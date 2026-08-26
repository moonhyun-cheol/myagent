using System.Diagnostics;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CqrPa.Updater;

internal static class Program
{
    private static StreamWriter? _log;

    public static int Main(string[] args)
    {
        try
        {
            var options = ParseArgs(args);
            var root = Path.GetFullPath(Require(options, "root"));
            var feedPath = Path.GetFullPath(Require(options, "feed"));
            var zipPath = Path.GetFullPath(Require(options, "zip"));
            var publicKeyPath = Path.GetFullPath(Require(options, "public-key"));
            var verifyOnly = options.ContainsKey("verify-only");
            var parentPid = GetOptionalInt(options, "parent-pid");
            var healthTimeoutSeconds = GetOptionalInt(options, "health-timeout-seconds") ?? 75;
            if (healthTimeoutSeconds > 300)
                throw new ArgumentException("--health-timeout-seconds cannot exceed 300.");
            var restartExe = Path.GetFullPath(
                options.TryGetValue("restart-exe", out var configuredRestart)
                    ? configuredRestart!
                    : Path.Combine(root, "MYAgent.exe"));

            InitializeLog(root);
            Log($"Updater starting. verify_only={verifyOnly}");
            ValidateInputs(root, feedPath, zipPath, publicKeyPath, restartExe, verifyOnly);

            var mutexName = BuildMutexName(root);
            using var mutex = new Mutex(initiallyOwned: false, mutexName);
            if (!mutex.WaitOne(TimeSpan.Zero))
                throw new InvalidOperationException("Another MY Agent update is already running.");

            var stagingParent = Path.Combine(root, ".update-staging");
            var stageRoot = Path.Combine(stagingParent, Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(stageRoot);
            try
            {
                var update = UpdateProtocol.VerifyAndExtract(feedPath, zipPath, publicKeyPath, stageRoot);
                Log($"Verified update sequence={update.Sequence} version={update.Version}");
                if (verifyOnly)
                {
                    Log("Verification-only completed.");
                    return 0;
                }

                var current = ReadInstalledProduct(root);
                if (current.Sequence >= update.Sequence)
                    throw new InvalidOperationException("Update sequence is not newer than the installed sequence.");
                if (current.Sequence < update.MinimumSupportedSequence)
                    throw new InvalidOperationException("Installed version is too old for this direct update.");

                WaitForParent(parentPid);
                var transaction = TransactionalInstaller.Apply(root, update);
                Process? restarted = null;
                try
                {
                    restarted = StartProduct(restartExe, root);
                    if (!WaitForHealthAsync(
                            root,
                            update.Version,
                            TimeSpan.FromSeconds(healthTimeoutSeconds))
                        .GetAwaiter()
                        .GetResult())
                        throw new InvalidOperationException("Updated application did not pass the health check.");
                    transaction.Commit();
                    Log("Update committed after health verification.");
                    return 0;
                }
                catch
                {
                    TryStop(restarted);
                    transaction.Rollback();
                    Log("Update rolled back.");
                    try
                    {
                        StartProduct(restartExe, root);
                        Log("Previous application restarted.");
                    }
                    catch (Exception restartError)
                    {
                        Log($"Previous application restart failed: {restartError.Message}");
                    }
                    throw;
                }
            }
            finally
            {
                TryDeleteDirectory(stageRoot);
                TryDeleteEmptyDirectory(stagingParent);
                mutex.ReleaseMutex();
            }
        }
        catch (Exception error)
        {
            Log($"FAILED: {error}");
            Console.Error.WriteLine($"MY Agent update failed: {error.Message}");
            return 1;
        }
        finally
        {
            _log?.Dispose();
        }
    }

    private static Dictionary<string, string?> ParseArgs(string[] args)
    {
        var result = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < args.Length; index++)
        {
            var token = args[index];
            if (!token.StartsWith("--", StringComparison.Ordinal) || token.Length <= 2)
                throw new ArgumentException($"Unexpected argument: {token}");
            var key = token[2..];
            if (key is "verify-only")
            {
                result[key] = null;
                continue;
            }
            if (index + 1 >= args.Length || args[index + 1].StartsWith("--", StringComparison.Ordinal))
                throw new ArgumentException($"Missing value for --{key}");
            if (!result.TryAdd(key, args[++index]))
                throw new ArgumentException($"Duplicate argument: --{key}");
        }
        return result;
    }

    private static string Require(IReadOnlyDictionary<string, string?> options, string key)
    {
        if (!options.TryGetValue(key, out var value) || string.IsNullOrWhiteSpace(value))
            throw new ArgumentException($"--{key} is required.");
        return value;
    }

    private static int? GetOptionalInt(IReadOnlyDictionary<string, string?> options, string key)
    {
        if (!options.TryGetValue(key, out var value)) return null;
        if (!int.TryParse(value, out var result) || result <= 0)
            throw new ArgumentException($"--{key} must be a positive integer.");
        return result;
    }

    private static void ValidateInputs(
        string root,
        string feedPath,
        string zipPath,
        string publicKeyPath,
        string restartExe,
        bool verifyOnly)
    {
        if (!Directory.Exists(root)) throw new DirectoryNotFoundException(root);
        if (!File.Exists(feedPath)) throw new FileNotFoundException("Update feed missing.", feedPath);
        if (!File.Exists(zipPath)) throw new FileNotFoundException("Update ZIP missing.", zipPath);
        if (!File.Exists(publicKeyPath)) throw new FileNotFoundException("Update public key missing.", publicKeyPath);
        if (!verifyOnly)
        {
            if (!File.Exists(Path.Combine(root, "manifest.json")))
                throw new FileNotFoundException("Installed manifest missing.");
            if (!File.Exists(restartExe)) throw new FileNotFoundException("Restart executable missing.", restartExe);
        }
    }

    private static void InitializeLog(string root)
    {
        try
        {
            var logDirectory = Path.Combine(root, "data", "logs");
            Directory.CreateDirectory(logDirectory);
            var logPath = Path.Combine(
                logDirectory,
                $"update-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}.log");
            _log = new StreamWriter(
                new FileStream(logPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read),
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false))
            {
                AutoFlush = true,
            };
        }
        catch
        {
            _log = null;
        }
    }

    private static void Log(string message)
    {
        var line = $"{DateTimeOffset.UtcNow:O} {message}";
        _log?.WriteLine(line);
        Console.WriteLine(line);
    }

    private static string BuildMutexName(string root)
    {
        var hash = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(root.ToUpperInvariant())));
        return $@"Local\MYAgent_Update_{hash[..24]}";
    }

    private static void WaitForParent(int? parentPid)
    {
        if (parentPid is null) return;
        try
        {
            using var parent = Process.GetProcessById(parentPid.Value);
            Log($"Waiting for MY Agent process {parentPid.Value} to exit.");
            if (!parent.WaitForExit((int)TimeSpan.FromSeconds(30).TotalMilliseconds))
                throw new TimeoutException("MY Agent did not exit before the update timeout.");
        }
        catch (ArgumentException)
        {
            // The parent already exited.
        }
    }

    private static (int Sequence, string Version, int Port) ReadInstalledProduct(string root)
    {
        using var document = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(root, "manifest.json")));
        var body = document.RootElement;
        var sequence = body.TryGetProperty("update_sequence", out var sequenceValue)
            && sequenceValue.TryGetInt32(out var parsedSequence)
            ? parsedSequence
            : 0;
        var version = body.GetProperty("version").GetString()
            ?? throw new InvalidDataException("Installed version is missing.");
        var port = body.TryGetProperty("api_port_default", out var portValue)
            && portValue.TryGetInt32(out var parsedPort)
            ? parsedPort
            : 10200;
        return (sequence, version, port);
    }

    private static Process StartProduct(string executable, string root)
    {
        var process = Process.Start(new ProcessStartInfo
        {
            FileName = executable,
            WorkingDirectory = root,
            UseShellExecute = true,
        }) ?? throw new InvalidOperationException("MY Agent could not be restarted.");
        Log($"Started MY Agent process {process.Id}.");
        return process;
    }

    private static async Task<bool> WaitForHealthAsync(string root, string expectedVersion, TimeSpan timeout)
    {
        var installed = ReadInstalledProduct(root);
        if (!string.Equals(installed.Version, expectedVersion, StringComparison.Ordinal))
            return false;
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            try
            {
                var health = await client.GetFromJsonAsync<JsonElement>(
                    $"http://127.0.0.1:{installed.Port}/health");
                if (health.TryGetProperty("version", out var version)
                    && string.Equals(version.GetString(), expectedVersion, StringComparison.Ordinal))
                {
                    return true;
                }
            }
            catch
            {
                // The shell/API can take time to become healthy after replacement.
            }
            await Task.Delay(500);
        }
        return false;
    }

    private static void TryStop(Process? process)
    {
        if (process is null) return;
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch
        {
            // Rollback still has to be attempted.
        }
    }

    private static void TryDeleteDirectory(string directory)
    {
        try
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
        catch
        {
            // Staging cleanup can be retried on the next launch.
        }
    }

    private static void TryDeleteEmptyDirectory(string directory)
    {
        try
        {
            if (Directory.Exists(directory) && !Directory.EnumerateFileSystemEntries(directory).Any())
                Directory.Delete(directory);
        }
        catch
        {
            // Best effort only.
        }
    }
}
