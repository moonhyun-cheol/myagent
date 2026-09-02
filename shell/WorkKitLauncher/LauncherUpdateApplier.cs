using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CqrPa.WorkKitLauncher;

internal static class LauncherUpdateApplier
{
    private static readonly HashSet<string> ProtectedRoots = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git", "data", "logs", "runtime", "core",
    };

    public static int Run(string[] args)
    {
        try
        {
            var options = ParseArgs(args);
            var root = Path.GetFullPath(Require(options, "root"));
            var parentPid = GetOptionalInt(options, "parent-pid");
            var noRestart = options.ContainsKey("no-restart");
            var restartExe = Path.GetFullPath(
                options.TryGetValue("restart-exe", out var configuredRestart)
                    ? configuredRestart!
                    : Path.Combine(root, "WorkKitLauncher.exe"));
            if (!File.Exists(Path.Combine(root, "manifest.json")))
                throw new InvalidDataException("Apply root is not a MY Agent install (manifest.json missing).");

            WaitForParent(parentPid);

            string stagePath;
            if (options.TryGetValue("stage", out var stage) && !string.IsNullOrWhiteSpace(stage))
            {
                stagePath = Path.GetFullPath(stage);
                if (!Directory.Exists(stagePath))
                    throw new InvalidDataException("Launcher update stage directory is missing.");
                RejectForbiddenFiles(stagePath);
            }
            else
            {
                var zipPath = Path.GetFullPath(Require(options, "zip"));
                options.TryGetValue("expected-sha256", out var expectedSha);
                var stagingParent = Path.Combine(root, ".launcher-update-staging");
                stagePath = Path.Combine(stagingParent, Guid.NewGuid().ToString("N"));
                ExtractAndVerify(zipPath, stagePath, expectedSha);
            }

            ApplyStage(root, stagePath);

            if (!noRestart)
            {
                var start = new ProcessStartInfo
                {
                    FileName = restartExe,
                    WorkingDirectory = root,
                    UseShellExecute = true,
                };
                start.Environment["MY_AGENT_ROOT"] = root;
                _ = Process.Start(start)
                    ?? throw new InvalidOperationException("Updated WorkKitLauncher.exe did not start.");
            }
            return 0;
        }
        catch (Exception error)
        {
            try
            {
                Console.Error.WriteLine($"WorkKitLauncher update failed: {error.Message}");
            }
            catch
            {
                // Console may be detached in WinExe.
            }
            return 1;
        }
    }

    public static void ExtractAndVerify(string zipPath, string stageRoot, string? expectedSha256)
    {
        if (!File.Exists(zipPath))
            throw new InvalidDataException("Launcher update zip is missing.");
        if (!string.IsNullOrWhiteSpace(expectedSha256))
        {
            var actual = Sha256File(zipPath);
            if (!FixedEquals(actual, expectedSha256))
                throw new InvalidDataException("Launcher update zip hash does not match.");
        }

        if (Directory.Exists(stageRoot)) Directory.Delete(stageRoot, recursive: true);
        Directory.CreateDirectory(stageRoot);
        using (var archive = ZipFile.OpenRead(zipPath))
        {
            foreach (var entry in archive.Entries)
            {
                if (string.IsNullOrEmpty(entry.Name)) continue;
                var unixType = (entry.ExternalAttributes >> 16) & 0xF000;
                if (unixType == 0xA000)
                    throw new InvalidDataException($"ZIP symlink is not allowed: {entry.FullName}");
                var entryPath = entry.FullName.Replace('\\', '/');
                while (entryPath.StartsWith("./", StringComparison.Ordinal)) entryPath = entryPath[2..];
                var relative = NormalizeManagedPath(entryPath);
                AssertAllowedPath(relative);
                var destination = ResolveUnder(stageRoot, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                using var input = entry.Open();
                using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                input.CopyTo(output);
            }
        }

        RejectForbiddenFiles(stageRoot);
        VerifyPayloadIfPresent(stageRoot);
    }

    public static void ApplyStage(string root, string stageRoot)
    {
        RejectForbiddenFiles(stageRoot);
        foreach (var file in Directory.EnumerateFiles(stageRoot, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(stageRoot, file).Replace('\\', '/');
            if (relative.Equals("launcher-payload.json", StringComparison.OrdinalIgnoreCase))
                continue;
            AssertAllowedPath(relative);
            foreach (var destRelative in MapInstallPaths(relative))
            {
                var dest = ResolveUnder(root, destRelative);
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                CopyWithRetry(file, dest);
            }
        }
    }

    internal static IEnumerable<string> MapInstallPaths(string relative)
    {
        var unix = relative.Replace('\\', '/');
        if (unix.Equals("WorkKitLauncher.exe", StringComparison.OrdinalIgnoreCase))
        {
            yield return "WorkKitLauncher.exe";
            yield return "bin/work-kit-launcher/WorkKitLauncher.exe";
            yield break;
        }
        if (unix.Equals("launcher-manifest.json", StringComparison.OrdinalIgnoreCase))
        {
            yield return "launcher-manifest.json";
            yield break;
        }
        if (unix.StartsWith("web/", StringComparison.OrdinalIgnoreCase))
        {
            var rest = unix["web/".Length..];
            yield return "bin/work-kit-launcher/web/" + rest;
            yield return "ui/work-kit-launcher/dist/" + rest;
            yield break;
        }
        yield return unix;
    }

    internal static void AssertAllowedPath(string relative)
    {
        var normalized = NormalizeManagedPath(relative);
        var lower = normalized.ToLowerInvariant();
        var baseName = Path.GetFileName(lower);
        if (baseName is "myagent.exe" or "myagent.updater.exe")
            throw new InvalidDataException($"Launcher update cannot include {normalized}.");
        if (lower == "manifest.json")
            throw new InvalidDataException("Launcher update cannot replace product manifest.json.");
        if (lower is "workkitlauncher.exe"
            or "launcher-manifest.json"
            or "launcher-payload.json"
            || lower.StartsWith("web/", StringComparison.Ordinal)
            || lower.StartsWith("bin/work-kit-launcher/", StringComparison.Ordinal)
            || lower.StartsWith("ui/work-kit-launcher/", StringComparison.Ordinal))
        {
            return;
        }
        throw new InvalidDataException($"Launcher update path is not allowed: {normalized}");
    }

    private static void RejectForbiddenFiles(string stageRoot)
    {
        foreach (var file in Directory.EnumerateFiles(stageRoot, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(stageRoot, file).Replace('\\', '/');
            AssertAllowedPath(relative);
        }
    }

    private static void VerifyPayloadIfPresent(string stageRoot)
    {
        var payloadPath = Path.Combine(stageRoot, "launcher-payload.json");
        if (!File.Exists(payloadPath)) return;
        using var document = JsonDocument.Parse(File.ReadAllBytes(payloadPath));
        var envelope = document.RootElement;
        if (!envelope.TryGetProperty("document", out var payload))
            throw new InvalidDataException("Launcher payload document is missing.");
        RequireString(payload, "schema", "my-agent-launcher-payload/v1");
        RequireString(payload, "kind", "work-kit-launcher");
        if (!payload.TryGetProperty("files", out var files) || files.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("Launcher payload files are missing.");
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in files.EnumerateArray())
        {
            var relative = NormalizeManagedPath(RequireNonEmptyString(file, "path"));
            AssertAllowedPath(relative);
            if (!seen.Add(relative)) throw new InvalidDataException($"Duplicate launcher payload path: {relative}");
            var staged = ResolveUnder(stageRoot, relative);
            if (!File.Exists(staged))
                throw new InvalidDataException($"Launcher payload file is missing: {relative}");
            var size = file.GetProperty("size").GetInt64();
            var sha = RequireSha256(file, "sha256");
            var info = new FileInfo(staged);
            if (info.Length != size || !FixedEquals(sha, Sha256File(staged)))
                throw new InvalidDataException($"Launcher payload file verification failed: {relative}");
        }
    }

    private static void WaitForParent(int? parentPid)
    {
        if (parentPid is null or <= 0) return;
        try
        {
            using var parent = Process.GetProcessById(parentPid.Value);
            if (!parent.WaitForExit(120_000))
                throw new TimeoutException("Timed out waiting for WorkKitLauncher to exit before applying the update.");
        }
        catch (ArgumentException)
        {
            // Parent already exited.
        }
    }

    private static void CopyWithRetry(string source, string dest)
    {
        Exception? last = null;
        for (var attempt = 0; attempt < 12; attempt++)
        {
            try
            {
                File.Copy(source, dest, overwrite: true);
                return;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                last = error;
                Thread.Sleep(250);
            }
        }
        throw last ?? new IOException($"Could not copy {dest}");
    }

    internal static string NormalizeManagedPath(string input)
    {
        if (string.IsNullOrWhiteSpace(input) || input.IndexOf('\0') >= 0)
            throw new InvalidDataException("Managed path must be non-empty.");
        var normalized = input.Replace('\\', '/');
        if (normalized.StartsWith('/') || Path.IsPathRooted(normalized))
            throw new InvalidDataException($"Managed path must be relative: {input}");
        var parts = normalized.Split('/');
        if (parts.Any(part => string.IsNullOrEmpty(part) || part is "." or ".."))
            throw new InvalidDataException($"Managed path contains unsafe segments: {input}");
        if (ProtectedRoots.Contains(parts[0]))
            throw new InvalidDataException($"Managed path targets protected data: {input}");
        return string.Join('/', parts);
    }

    private static string ResolveUnder(string root, string relative)
    {
        var safeRelative = NormalizeManagedPath(relative);
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var full = Path.GetFullPath(Path.Combine(fullRoot, safeRelative.Replace('/', Path.DirectorySeparatorChar)));
        if (!full.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"Path escapes update root: {relative}");
        return full;
    }

    private static string Sha256File(string filePath)
    {
        using var stream = File.OpenRead(filePath);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static bool FixedEquals(string left, string right) =>
        CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(left.ToLowerInvariant()),
            Encoding.ASCII.GetBytes(right.ToLowerInvariant()));

    private static Dictionary<string, string> ParseArgs(string[] args)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < args.Length; i++)
        {
            var token = args[i];
            if (!token.StartsWith("--", StringComparison.Ordinal)) continue;
            var key = token[2..];
            if (key is "apply-update" or "no-restart" or "verify-launcher-feed")
            {
                result[key] = "1";
                continue;
            }
            if (i + 1 >= args.Length)
                throw new ArgumentException($"{token} requires a value.");
            result[key] = args[++i];
        }
        return result;
    }

    private static string Require(Dictionary<string, string> options, string name)
    {
        if (!options.TryGetValue(name, out var value) || string.IsNullOrWhiteSpace(value))
            throw new ArgumentException($"--{name} is required.");
        return value;
    }

    private static int? GetOptionalInt(Dictionary<string, string> options, string name)
    {
        if (!options.TryGetValue(name, out var value) || string.IsNullOrWhiteSpace(value))
            return null;
        if (!int.TryParse(value, out var parsed))
            throw new ArgumentException($"--{name} must be an integer.");
        return parsed;
    }

    private static string RequireNonEmptyString(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value)
            || value.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(value.GetString()))
        {
            throw new InvalidDataException($"{name} is required.");
        }
        return value.GetString()!;
    }

    private static string RequireSha256(JsonElement element, string name)
    {
        var value = RequireNonEmptyString(element, name).ToLowerInvariant();
        if (value.Length != 64 || value.Any(ch => !Uri.IsHexDigit(ch)))
            throw new InvalidDataException($"{name} must be SHA-256 hex.");
        return value;
    }

    private static void RequireString(JsonElement element, string name, string expected)
    {
        var actual = RequireNonEmptyString(element, name);
        if (!string.Equals(actual, expected, StringComparison.Ordinal))
            throw new InvalidDataException($"{name} must be {expected}.");
    }
}
