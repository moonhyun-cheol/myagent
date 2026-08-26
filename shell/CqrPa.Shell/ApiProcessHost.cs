using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;

namespace CqrPa.Shell;

internal sealed class ApiProcessHost : IDisposable
{
    private Process? _process;
    private readonly string _root;
    private readonly string _expectedVersion;
    private bool _startedByShell;
    private bool _restartedAfterVersionMismatch;

    public TimeSpan RecommendedHealthTimeout =>
        _restartedAfterVersionMismatch ? TimeSpan.FromSeconds(90) : TimeSpan.FromSeconds(60);

    public int Port { get; } = 10200;

    public ApiProcessHost(string root)
    {
        _root = root;
        _expectedVersion = ReadManifestVersion(root);
        Environment.SetEnvironmentVariable("MY_AGENT_ROOT", root);
    }

    public bool Start()
    {
        var script = Path.Combine(_root, "core", "dist", "main.js");
        if (!File.Exists(script))
            return false;

        var existing = ProbeHealth();
        if (existing.Ok && existing.Version == _expectedVersion)
        {
            var distMtimeMs = new DateTimeOffset(File.GetLastWriteTimeUtc(script)).ToUnixTimeMilliseconds();
            if (existing.DistMtimeMs.HasValue && existing.DistMtimeMs.Value >= distMtimeMs)
                return true;

            ForceKillNodeListenersOnPort(Port);
            WaitForPortFree(Port, TimeSpan.FromSeconds(5));
        }
        else if (existing.Ok && existing.Version != _expectedVersion)
        {
            _restartedAfterVersionMismatch = true;
            ForceKillNodeListenersOnPort(Port);
            WaitForPortFree(Port, TimeSpan.FromSeconds(5));
        }

        var nodePath = Path.Combine(_root, "runtime", "node", "node.exe");
        if (!File.Exists(nodePath))
            return false;

        var psi = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = $"\"{script}\"",
            WorkingDirectory = _root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.Environment["MY_AGENT_ROOT"] = _root;
        psi.Environment["CQR_API_PORT"] = Port.ToString();

        _process = Process.Start(psi);
        _startedByShell = _process != null;
        if (_startedByShell && _process != null)
        {
            _process.OutputDataReceived += (_, e) => { _ = e.Data; };
            _process.ErrorDataReceived += (_, e) => { _ = e.Data; };
            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();
        }
        return _startedByShell;
    }

    public bool WaitForHealth(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            var h = ProbeHealth();
            if (IsReady(h))
                return true;
            Thread.Sleep(200);
        }
        return false;
    }

    public async Task<bool> WaitForHealthAsync(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            var h = await Task.Run(ProbeHealth);
            if (IsReady(h))
                return true;
            await Task.Delay(200);
        }
        return false;
    }

    private bool IsReady((bool Ok, string? Version, string? CqrRoot, long? DistMtimeMs) health)
    {
        if (!health.Ok || string.IsNullOrWhiteSpace(health.CqrRoot))
            return false;

        try
        {
            var expectedRoot = Path.GetFullPath(_root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var actualRoot = Path.GetFullPath(health.CqrRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return string.Equals(expectedRoot, actualRoot, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private (bool Ok, string? Version, string? CqrRoot, long? DistMtimeMs) ProbeHealth()
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            var json = http.GetStringAsync($"http://127.0.0.1:{Port}/health").GetAwaiter().GetResult();
            if (!json.Contains("MY Agent", StringComparison.Ordinal))
                return (false, null, null, null);
            using var doc = JsonDocument.Parse(json);
            var version = doc.RootElement.TryGetProperty("version", out var v) ? v.GetString() : null;
            var cqrRoot = doc.RootElement.TryGetProperty("cqr_root", out var r) ? r.GetString() : null;
            long? distMtime = null;
            if (doc.RootElement.TryGetProperty("dist_mtime_ms", out var m) && m.TryGetInt64(out var ms))
                distMtime = ms;
            return (true, version, cqrRoot, distMtime);
        }
        catch
        {
            return (false, null, null, null);
        }
    }

    private static string ReadManifestVersion(string root)
    {
        try
        {
            var path = Path.Combine(root, "manifest.json");
            if (!File.Exists(path)) return "0.0.0";
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            return doc.RootElement.TryGetProperty("version", out var v) ? v.GetString() ?? "0.0.0" : "0.0.0";
        }
        catch
        {
            return "0.0.0";
        }
    }

    private static void ForceKillNodeListenersOnPort(int port)
    {
        foreach (var pid in FindListeningPids(port))
        {
            try
            {
                var killer = Process.GetProcessById(pid);
                if (killer.ProcessName is "node" or "Node")
                    killer.Kill(entireProcessTree: true);
            }
            catch { /* ignore */ }
        }

        Thread.Sleep(400);
    }

    private static bool WaitForPortFree(int port, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (FindListeningPids(port).Count == 0)
                return true;
            Thread.Sleep(100);
        }
        return FindListeningPids(port).Count == 0;
    }

    private static HashSet<int> FindListeningPids(int port)
    {
        var pids = new HashSet<int>();
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "netstat",
                Arguments = "-ano",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                CreateNoWindow = true,
            };
            using var proc = Process.Start(psi);
            if (proc == null) return pids;
            var output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit(3000);

            var suffix = $":{port}";
            foreach (var line in output.Split('\n'))
            {
                if (!line.Contains("LISTENING", StringComparison.OrdinalIgnoreCase)) continue;
                if (!line.Contains(suffix, StringComparison.Ordinal)) continue;
                var parts = line.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length > 0 && int.TryParse(parts[^1], out var pid) && pid > 0)
                    pids.Add(pid);
            }
        }
        catch { /* ignore */ }

        return pids;
    }

    public void Dispose()
    {
        if (_startedByShell && _process is { HasExited: false })
        {
            try { _process.Kill(entireProcessTree: true); } catch { /* ignore */ }
        }
        _process?.Dispose();
    }
}
