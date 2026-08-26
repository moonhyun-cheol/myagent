using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CqrPa.Shell;

internal sealed record DownloadedUpdate(
    AvailableUpdate Update,
    string Directory,
    string FeedPath,
    string ZipPath,
    string UpdaterPath);

internal sealed class UpdateTooOldException(string message) : InvalidOperationException(message);

internal sealed class UpdateService
{
    private const int MaxFeedBytes = 1024 * 1024;
    private readonly string _root;
    private readonly Uri _feedUri;
    private readonly string _repository;
    private readonly string _channel;
    private readonly int _currentSequence;
    private readonly string _publicKeyPath;
    private readonly string _installedUpdaterPath;
    private readonly HttpClient _http;

    private UpdateService(
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
        _installedUpdaterPath = new[]
        {
            Path.Combine(root, "MYAgent.Updater.exe"),
            Path.Combine(root, "bin", "my-agent", "MYAgent.Updater.exe"),
        }.FirstOrDefault(File.Exists) ?? Path.Combine(root, "MYAgent.Updater.exe");
        _http = new HttpClient(new HttpClientHandler
        {
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 5,
            AutomaticDecompression = DecompressionMethods.All,
        })
        {
            Timeout = TimeSpan.FromSeconds(10),
        };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("MYAgent-Updater/1");
    }

    public static UpdateService? TryCreate(string root)
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
                File.ReadAllBytes(Path.Combine(root, "manifest.json")));
            var manifest = document.RootElement;
            var repository = RequireString(manifest, "update_repository");
            var channel = RequireString(manifest, "update_channel");
            var feedUrl = RequireString(manifest, "update_feed_url");
            var currentSequence = manifest.GetProperty("update_sequence").GetInt32();
            if (currentSequence < 1) return null;
            var feedUri = new Uri(feedUrl, UriKind.Absolute);
            if (!string.Equals(feedUri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(feedUri.Host, "raw.githubusercontent.com", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }
            var service = new UpdateService(root, feedUri, repository, channel, currentSequence);
            if (!File.Exists(service._publicKeyPath) || !File.Exists(service._installedUpdaterPath))
                return null;
            return service;
        }
        catch
        {
            return null;
        }
    }

    public async Task<AvailableUpdate?> CheckAsync(CancellationToken cancellationToken)
    {
        using var response = await _http.GetAsync(
            _feedUri,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        EnsureFeedResponseUri(response.RequestMessage?.RequestUri);
        if (response.Content.Headers.ContentLength is > MaxFeedBytes)
            throw new InvalidDataException("Update feed is too large.");
        var feedBytes = await ReadLimitedAsync(
            await response.Content.ReadAsStreamAsync(cancellationToken),
            MaxFeedBytes,
            cancellationToken);
        var update = UpdateFeedVerifier.Verify(
            feedBytes,
            File.ReadAllText(_publicKeyPath, Encoding.UTF8),
            _repository,
            _channel);
        if (update.Sequence <= _currentSequence) return null;
        if (_currentSequence < update.MinimumSupportedSequence)
        {
            throw new UpdateTooOldException(
                "현재 설치 버전이 너무 오래되어 자동 업데이트할 수 없습니다. 최신 설치본으로 다시 설치하세요.");
        }
        return update;
    }

    public async Task<DownloadedUpdate> DownloadAsync(
        AvailableUpdate update,
        CancellationToken cancellationToken)
    {
        if (update.Sequence <= _currentSequence)
            throw new InvalidOperationException("Update is not newer than this installation.");
        var downloadUri = BuildReleaseAssetUri(update.Asset);
        var updateDirectory = Path.Combine(
            Path.GetTempPath(),
            "MYAgent",
            "updates",
            $"{update.Sequence}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(updateDirectory);
        var feedPath = Path.Combine(updateDirectory, $"update-feed-{update.Channel}.json");
        var zipPath = Path.Combine(updateDirectory, update.Asset.Name);
        var updaterPath = Path.Combine(updateDirectory, "MYAgent.Updater.exe");
        try
        {
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
                throw new InvalidDataException("Downloaded update size does not match signed feed.");
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
                while (true)
                {
                    var read = await input.ReadAsync(buffer, cancellationToken);
                    if (read == 0) break;
                    total = checked(total + read);
                    if (total > update.Asset.Size)
                        throw new InvalidDataException("Downloaded update exceeded its signed size.");
                    hash.AppendData(buffer, 0, read);
                    await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                }
                if (total != update.Asset.Size)
                    throw new InvalidDataException("Downloaded update size does not match signed feed.");
                var actualHash = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
                if (!FixedEquals(actualHash, update.Asset.Sha256))
                    throw new InvalidDataException("Downloaded update hash does not match signed feed.");
            }

            File.Copy(_installedUpdaterPath, updaterPath, overwrite: false);
            return new DownloadedUpdate(
                update,
                updateDirectory,
                feedPath,
                zipPath,
                updaterPath);
        }
        catch
        {
            TryDeleteDirectory(updateDirectory);
            throw;
        }
    }

    public Process LaunchUpdater(DownloadedUpdate downloaded)
    {
        var start = new ProcessStartInfo
        {
            FileName = downloaded.UpdaterPath,
            WorkingDirectory = downloaded.Directory,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add("--root");
        start.ArgumentList.Add(_root);
        start.ArgumentList.Add("--feed");
        start.ArgumentList.Add(downloaded.FeedPath);
        start.ArgumentList.Add("--zip");
        start.ArgumentList.Add(downloaded.ZipPath);
        start.ArgumentList.Add("--public-key");
        start.ArgumentList.Add(_publicKeyPath);
        start.ArgumentList.Add("--parent-pid");
        start.ArgumentList.Add(Environment.ProcessId.ToString());
        start.ArgumentList.Add("--restart-exe");
        start.ArgumentList.Add(Path.Combine(_root, "MYAgent.exe"));
        return Process.Start(start)
            ?? throw new InvalidOperationException("Updater.exe를 시작하지 못했습니다.");
    }

    public void LogFailure(string category, Exception error)
    {
        try
        {
            var logDirectory = Path.Combine(_root, "data", "logs");
            Directory.CreateDirectory(logDirectory);
            File.AppendAllText(
                Path.Combine(logDirectory, "update-check.log"),
                $"{DateTimeOffset.UtcNow:O} {category}: {error.GetType().Name}: {error.Message}{Environment.NewLine}",
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        }
        catch
        {
            // Update logging must never block application startup.
        }
    }

    private static Uri BuildReleaseAssetUri(UpdateFeedAsset asset)
    {
        var repositoryParts = asset.Repository.Split('/');
        if (repositoryParts.Length != 2)
            throw new InvalidDataException("Signed update repository is invalid.");
        return new Uri(
            $"https://github.com/{Uri.EscapeDataString(repositoryParts[0])}/"
            + $"{Uri.EscapeDataString(repositoryParts[1])}/releases/download/"
            + $"{Uri.EscapeDataString(asset.ReleaseTag)}/{Uri.EscapeDataString(asset.Name)}");
    }

    private static void EnsureFeedResponseUri(Uri? uri)
    {
        if (uri is null
            || !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(uri.Host, "raw.githubusercontent.com", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Update feed redirected outside trusted GitHub hosting.");
        }
    }

    private static void EnsureReleaseResponseUri(Uri? uri)
    {
        if (uri is null || !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Update download did not use HTTPS.");
        var host = uri.Host;
        var trusted = string.Equals(host, "github.com", StringComparison.OrdinalIgnoreCase)
            || string.Equals(host, "objects.githubusercontent.com", StringComparison.OrdinalIgnoreCase)
            || string.Equals(host, "release-assets.githubusercontent.com", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".githubusercontent.com", StringComparison.OrdinalIgnoreCase);
        if (!trusted)
            throw new InvalidDataException("Update download redirected outside trusted GitHub hosting.");
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
                throw new InvalidDataException("Update feed exceeded its size limit.");
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
            throw new InvalidDataException($"{name} is missing from manifest.json.");
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
