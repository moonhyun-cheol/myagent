using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CqrPa.WorkKitLauncher;

public readonly record struct LauncherUpdateDownloadProgress(
    long ReceivedBytes,
    long TotalBytes,
    string Phase);

internal sealed record DownloadedLauncherUpdate(
    LauncherAvailableUpdate Update,
    string Directory,
    string FeedPath,
    string ZipPath,
    string StagePath);

internal sealed class LauncherUpdateTooOldException(string message) : InvalidOperationException(message);

internal sealed class LauncherUpdateService
{
    private const int MaxFeedBytes = 1024 * 1024;
    private readonly string _root;
    private readonly Uri _feedUri;
    private readonly string _repository;
    private readonly string _channel;
    private readonly int _currentSequence;
    private readonly string _publicKeyPath;
    private readonly HttpClient _http;

    private LauncherUpdateService(
        string root,
        Uri feedUri,
        string repository,
        string channel,
        int currentSequence)
    {
        _root = root;
        _feedUri = feedUri;
        _repository = repository;
        _channel = channel;
        _currentSequence = currentSequence;
        _publicKeyPath = Path.Combine(root, "core", "config", "defaults", "update-public.pem");
        _http = new HttpClient(new HttpClientHandler
        {
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 5,
            AutomaticDecompression = DecompressionMethods.All,
        })
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("WorkKitLauncher-Updater/1");
    }

    public static LauncherUpdateService? TryCreate(string root)
    {
        if (string.Equals(
                Environment.GetEnvironmentVariable("MY_AGENT_UPDATE_CHECK"),
                "0",
                StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        try
        {
            using var document = JsonDocument.Parse(
                File.ReadAllBytes(Path.Combine(root, "launcher-manifest.json")));
            var manifest = document.RootElement;
            if (!string.Equals(
                    RequireString(manifest, "kind"),
                    "work-kit-launcher",
                    StringComparison.Ordinal))
            {
                return null;
            }
            var repository = RequireString(manifest, "update_repository");
            var channel = RequireString(manifest, "update_channel");
            var feedUrl = RequireString(manifest, "update_feed_url");
            var currentSequence = manifest.GetProperty("update_sequence").GetInt32();
            if (currentSequence < 1) return null;
            var feedUri = new Uri(feedUrl, UriKind.Absolute);
            if (!string.Equals(feedUri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
                || !IsTrustedFeedHost(feedUri.Host, feedUri.Host))
            {
                return null;
            }
            var service = new LauncherUpdateService(root, feedUri, repository, channel, currentSequence);
            if (!File.Exists(service._publicKeyPath)) return null;
            return service;
        }
        catch
        {
            return null;
        }
    }

    public async Task<LauncherAvailableUpdate?> CheckAsync(CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));
        using var response = await _http.GetAsync(
            _feedUri,
            HttpCompletionOption.ResponseHeadersRead,
            timeout.Token);
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        EnsureFeedResponseUri(response.RequestMessage?.RequestUri);
        if (response.Content.Headers.ContentLength is > MaxFeedBytes)
            throw new InvalidDataException("Launcher update feed is too large.");
        var feedBytes = await ReadLimitedAsync(
            await response.Content.ReadAsStreamAsync(timeout.Token),
            MaxFeedBytes,
            timeout.Token);
        var update = LauncherUpdateFeedVerifier.Verify(
            feedBytes,
            File.ReadAllText(_publicKeyPath, Encoding.UTF8),
            _repository,
            _channel);
        if (update.Sequence <= _currentSequence) return null;
        if (_currentSequence < update.MinimumSupportedSequence)
        {
            throw new LauncherUpdateTooOldException(
                "현재 MY Agent 관리자 버전이 너무 오래되어 자동 업데이트할 수 없습니다. 최신 설치본으로 다시 설치하세요.");
        }
        return update;
    }

    public async Task<DownloadedLauncherUpdate> DownloadAsync(
        LauncherAvailableUpdate update,
        CancellationToken cancellationToken,
        IProgress<LauncherUpdateDownloadProgress>? progress = null)
    {
        if (update.Sequence <= _currentSequence)
            throw new InvalidOperationException("Launcher update is not newer than this installation.");
        var downloadUri = BuildReleaseAssetUri(update.Asset);
        var updateDirectory = Path.Combine(
            Path.GetTempPath(),
            "WorkKitLauncher",
            "updates",
            $"{update.Sequence}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(updateDirectory);
        var feedPath = Path.Combine(updateDirectory, $"launcher-feed-{update.Channel}.json");
        var zipPath = Path.Combine(updateDirectory, update.Asset.Name);
        var stagePath = Path.Combine(updateDirectory, "stage");
        try
        {
            progress?.Report(new LauncherUpdateDownloadProgress(0, update.Asset.Size, "업데이트 파일을 다운로드하는 중…"));
            await File.WriteAllBytesAsync(feedPath, update.FeedBytes, cancellationToken);
            using var response = await _http.GetAsync(
                downloadUri,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);
            response.EnsureSuccessStatusCode();
            EnsureReleaseResponseUri(response.RequestMessage?.RequestUri);
            if (response.Content.Headers.ContentLength is long contentLength
                && contentLength != update.Asset.Size)
            {
                throw new InvalidDataException("Downloaded launcher update size does not match signed feed.");
            }

            await using (var input = await response.Content.ReadAsStreamAsync(cancellationToken))
            await using (var output = new FileStream(
                zipPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 128 * 1024,
                useAsync: true))
            using (var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
            {
                var buffer = new byte[128 * 1024];
                long total = 0;
                long lastReported = 0;
                while (true)
                {
                    var read = await input.ReadAsync(buffer, cancellationToken);
                    if (read == 0) break;
                    total = checked(total + read);
                    if (total > update.Asset.Size)
                        throw new InvalidDataException("Downloaded launcher update exceeded its signed size.");
                    hash.AppendData(buffer, 0, read);
                    await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                    if (total - lastReported >= 512 * 1024 || total == update.Asset.Size)
                    {
                        lastReported = total;
                        progress?.Report(new LauncherUpdateDownloadProgress(
                            total,
                            update.Asset.Size,
                            "업데이트 파일을 다운로드하는 중…"));
                    }
                }
                if (total != update.Asset.Size)
                    throw new InvalidDataException("Downloaded launcher update size does not match signed feed.");
                var actualHash = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
                if (!FixedEquals(actualHash, update.Asset.Sha256))
                    throw new InvalidDataException("Downloaded launcher update hash does not match signed feed.");
            }

            progress?.Report(new LauncherUpdateDownloadProgress(
                update.Asset.Size,
                update.Asset.Size,
                "다운로드를 확인하고 설치를 준비하는 중…"));
            LauncherUpdateApplier.ExtractAndVerify(zipPath, stagePath, expectedSha256: update.Asset.Sha256);
            return new DownloadedLauncherUpdate(update, updateDirectory, feedPath, zipPath, stagePath);
        }
        catch
        {
            TryDeleteDirectory(updateDirectory);
            throw;
        }
    }

    public Process LaunchApplier(DownloadedLauncherUpdate downloaded)
    {
        var applier = Path.Combine(downloaded.StagePath, "WorkKitLauncher.exe");
        if (!File.Exists(applier))
        {
            applier = Path.Combine(downloaded.Directory, "WorkKitLauncher.Apply.exe");
            File.Copy(Environment.ProcessPath ?? Environment.GetCommandLineArgs()[0], applier, overwrite: false);
        }
        var start = new ProcessStartInfo
        {
            FileName = applier,
            WorkingDirectory = downloaded.Directory,
            UseShellExecute = true,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add("--apply-update");
        start.ArgumentList.Add("--root");
        start.ArgumentList.Add(_root);
        start.ArgumentList.Add("--stage");
        start.ArgumentList.Add(downloaded.StagePath);
        start.ArgumentList.Add("--parent-pid");
        start.ArgumentList.Add(Environment.ProcessId.ToString());
        start.ArgumentList.Add("--restart-exe");
        start.ArgumentList.Add(Path.Combine(_root, "WorkKitLauncher.exe"));
        return Process.Start(start)
            ?? throw new InvalidOperationException("MY Agent 관리자 업데이트를 시작하지 못했습니다.");
    }

    public void LogFailure(string category, Exception error)
    {
        try
        {
            var logDirectory = Path.Combine(_root, "data", "logs");
            Directory.CreateDirectory(logDirectory);
            File.AppendAllText(
                Path.Combine(logDirectory, "launcher-update-check.log"),
                $"{DateTimeOffset.UtcNow:O} {category}: {error.GetType().Name}: {error.Message}{Environment.NewLine}",
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        }
        catch
        {
            // Update logging must never block application startup.
        }
    }

    private Uri BuildReleaseAssetUri(LauncherUpdateFeedAsset asset)
    {
        var repositoryParts = asset.Repository.Split('/');
        if (repositoryParts.Length != 2)
            throw new InvalidDataException("Signed launcher update repository is invalid.");
        var template = Environment.GetEnvironmentVariable("MY_AGENT_UPDATE_ASSET_URL_TEMPLATE");
        if (!string.IsNullOrWhiteSpace(template))
        {
            var filled = template
                .Replace("{owner}", Uri.EscapeDataString(repositoryParts[0]), StringComparison.Ordinal)
                .Replace("{repo}", Uri.EscapeDataString(repositoryParts[1]), StringComparison.Ordinal)
                .Replace(
                    "{repository}",
                    $"{Uri.EscapeDataString(repositoryParts[0])}/{Uri.EscapeDataString(repositoryParts[1])}",
                    StringComparison.Ordinal)
                .Replace("{tag}", Uri.EscapeDataString(asset.ReleaseTag), StringComparison.Ordinal)
                .Replace("{name}", Uri.EscapeDataString(asset.Name), StringComparison.Ordinal);
            return new Uri(filled, UriKind.Absolute);
        }
        return new Uri(
            $"https://github.com/{Uri.EscapeDataString(repositoryParts[0])}/"
            + $"{Uri.EscapeDataString(repositoryParts[1])}/releases/download/"
            + $"{Uri.EscapeDataString(asset.ReleaseTag)}/{Uri.EscapeDataString(asset.Name)}");
    }

    private void EnsureFeedResponseUri(Uri? uri)
    {
        if (uri is null
            || !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || !IsTrustedFeedHost(uri.Host, _feedUri.Host))
        {
            throw new InvalidDataException(
                "Launcher update feed redirected outside trusted hosts. Set MY_AGENT_UPDATE_TRUSTED_HOSTS if using a non-GitHub feed.");
        }
    }

    private void EnsureReleaseResponseUri(Uri? uri)
    {
        if (uri is null || !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Launcher update download did not use HTTPS.");
        if (!IsTrustedAssetHost(uri.Host, _feedUri.Host))
        {
            throw new InvalidDataException(
                "Launcher update download redirected outside trusted hosts. Set MY_AGENT_UPDATE_TRUSTED_HOSTS / MY_AGENT_UPDATE_ASSET_HOSTS.");
        }
    }

    internal static bool IsTrustedFeedHost(string host, string configuredFeedHost)
    {
        if (HostEquals(host, configuredFeedHost)) return true;
        if (HostEquals(host, "raw.githubusercontent.com")) return true;
        return HostInEnvList(host, "MY_AGENT_UPDATE_TRUSTED_HOSTS")
            || HostInEnvList(host, "MY_AGENT_UPDATE_FEED_HOSTS");
    }

    internal static bool IsTrustedAssetHost(string host, string configuredFeedHost)
    {
        if (HostEquals(host, configuredFeedHost)) return true;
        if (HostEquals(host, "github.com")
            || HostEquals(host, "objects.githubusercontent.com")
            || HostEquals(host, "release-assets.githubusercontent.com")
            || host.EndsWith(".githubusercontent.com", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }
        return HostInEnvList(host, "MY_AGENT_UPDATE_TRUSTED_HOSTS")
            || HostInEnvList(host, "MY_AGENT_UPDATE_ASSET_HOSTS");
    }

    private static bool HostEquals(string left, string right) =>
        string.Equals(left, right, StringComparison.OrdinalIgnoreCase);

    private static bool HostInEnvList(string host, string envName)
    {
        var raw = Environment.GetEnvironmentVariable(envName);
        if (string.IsNullOrWhiteSpace(raw)) return false;
        foreach (var part in raw.Split(
                     new[] { ',', ';', ' ' },
                     StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (HostMatchesPattern(host, part)) return true;
        }
        return false;
    }

    private static bool HostMatchesPattern(string host, string pattern)
    {
        if (string.IsNullOrWhiteSpace(pattern)) return false;
        if (pattern.StartsWith("*.", StringComparison.Ordinal) || pattern.StartsWith('.'))
        {
            var suffix = pattern.StartsWith("*.", StringComparison.Ordinal) ? pattern[1..] : pattern;
            return HostEquals(host, suffix.TrimStart('.'))
                || host.EndsWith(suffix, StringComparison.OrdinalIgnoreCase);
        }
        return HostEquals(host, pattern)
            || host.EndsWith("." + pattern, StringComparison.OrdinalIgnoreCase);
    }

    private static async Task<byte[]> ReadLimitedAsync(
        Stream input,
        int limit,
        CancellationToken cancellationToken)
    {
        using var output = new MemoryStream();
        var buffer = new byte[16 * 1024];
        while (true)
        {
            var read = await input.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            if (output.Length + read > limit)
                throw new InvalidDataException("Launcher update feed exceeded its size limit.");
            output.Write(buffer, 0, read);
        }
        return output.ToArray();
    }

    private static bool FixedEquals(string left, string right) =>
        CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(left.ToLowerInvariant()),
            Encoding.ASCII.GetBytes(right.ToLowerInvariant()));

    private static string RequireString(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value)
            || value.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(value.GetString()))
        {
            throw new InvalidDataException($"{name} is missing from launcher-manifest.json.");
        }
        return value.GetString()!;
    }

    private static void TryDeleteDirectory(string directory)
    {
        try
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
        catch
        {
            // Temp cleanup is best effort.
        }
    }
}
