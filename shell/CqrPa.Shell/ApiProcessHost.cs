using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text.Json;

namespace CqrPa.Shell;

public sealed class ApiProcessHost : IDisposable
{
    private const int DefaultPort = 10200;
    private const int ReuseWindow = 32;
    private const int SearchWindow = 2048;
    /// <summary>Central activation-server default; skip unless this install prefers it.</summary>
    private const int ActivationServerDefaultPort = 10201;

    private Process? _process;
    private readonly string _root;
    private readonly string _expectedVersion;
    private bool _startedByShell;
    private bool _restartedAfterVersionMismatch;

    public TimeSpan RecommendedHealthTimeout =>
        _restartedAfterVersionMismatch ? TimeSpan.FromSeconds(90) : TimeSpan.FromSeconds(60);

    public int Port { get; private set; } = DefaultPort;

    public ApiProcessHost(string root)
    {
        _root = root;
        _expectedVersion = ReadManifestVersion(root);
        Port = ReadManifestPort(root);
        Environment.SetEnvironmentVariable("MY_AGENT_ROOT", root);
    }

    public bool Start()
    {
        var script = Path.Combine(_root, "core", "dist", "main.js");
        if (!File.Exists(script))
            return false;

        var decision = ResolveOwnedPort(script);
        Port = decision.Port;
        PersistRuntimePort(Port);

        if (decision.ReuseExisting)
            return true;

        if (decision.KillExisting)
        {
            if (decision.VersionMismatch)
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
            var h = ProbeHealth(Port);
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
            var h = await Task.Run(() => ProbeHealth(Port));
            if (IsReady(h))
                return true;
            await Task.Delay(200);
        }
        return false;
    }

    private readonly record struct PortDecision(
        int Port,
        bool ReuseExisting,
        bool KillExisting,
        bool VersionMismatch);

    private PortDecision ResolveOwnedPort(string script)
    {
        var preferred = ReadManifestPort(_root);
        var distMtimeMs = new DateTimeOffset(File.GetLastWriteTimeUtc(script)).ToUnixTimeMilliseconds();
        var listening = ListListeningPorts();

        if (TryOwnPort(preferred, listening, distMtimeMs, out var owned))
            return owned;

        var recorded = ReadPersistedRuntimePort(_root);
        if (recorded is int recordedPort
            && recordedPort != preferred
            && TryOwnPort(recordedPort, listening, distMtimeMs, out owned))
        {
            return owned;
        }

        for (var offset = 1; offset < ReuseWindow; offset++)
        {
            var port = preferred + offset;
            if (port > 65535) break;
            if (TryOwnPort(port, listening, distMtimeMs, out owned))
                return owned;
        }

        for (var offset = 0; offset < SearchWindow; offset++)
        {
            var port = preferred + offset;
            if (port > 65535) break;
            if (port != preferred && port == ActivationServerDefaultPort)
                continue;
            if (listening.Contains(port))
                continue;
            if (!CanBindLoopback(port))
                continue;
            return new PortDecision(port, ReuseExisting: false, KillExisting: false, VersionMismatch: false);
        }

        return new PortDecision(
            BindEphemeralLoopback(),
            ReuseExisting: false,
            KillExisting: false,
            VersionMismatch: false);
    }

    private bool TryOwnPort(
        int port,
        HashSet<int> listening,
        long distMtimeMs,
        out PortDecision decision)
    {
        decision = default;
        if (!listening.Contains(port))
            return false;

        var existing = ProbeHealth(port);
        if (!existing.Ok || !SameProductRoot(existing.CqrRoot))
            return false;

        if (existing.Version == _expectedVersion
            && existing.DistMtimeMs.HasValue
            && existing.DistMtimeMs.Value >= distMtimeMs)
        {
            decision = new PortDecision(port, ReuseExisting: true, KillExisting: false, VersionMismatch: false);
            return true;
        }

        decision = new PortDecision(
            port,
            ReuseExisting: false,
            KillExisting: true,
            VersionMismatch: existing.Version != _expectedVersion);
        return true;
    }

    private bool IsReady((bool Ok, string? Version, string? CqrRoot, long? DistMtimeMs) health)
    {
        return health.Ok && SameProductRoot(health.CqrRoot);
    }

    private bool SameProductRoot(string? actual)
    {
        if (string.IsNullOrWhiteSpace(actual)) return false;
        try
        {
            var expectedRoot = Path.GetFullPath(_root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var actualRoot = Path.GetFullPath(actual).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return string.Equals(expectedRoot, actualRoot, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private (bool Ok, string? Version, string? CqrRoot, long? DistMtimeMs) ProbeHealth(int port)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            var json = http.GetStringAsync($"http://127.0.0.1:{port}/health").GetAwaiter().GetResult();
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

    private void PersistRuntimePort(int port)
    {
        try
        {
            var directory = Path.Combine(_root, "data", "runtime");
            Directory.CreateDirectory(directory);
            File.WriteAllText(
                Path.Combine(directory, "api-port.json"),
                JsonSerializer.Serialize(new { port, cqr_root = _root }));
        }
        catch
        {
            // Runtime port is a hint for the updater; startup must not fail on it.
        }
    }

    private static int? ReadPersistedRuntimePort(string root)
    {
        try
        {
            var path = Path.Combine(root, "data", "runtime", "api-port.json");
            if (!File.Exists(path)) return null;
            using var doc = JsonDocument.Parse(File.ReadAllBytes(path));
            if (doc.RootElement.TryGetProperty("port", out var value)
                && value.TryGetInt32(out var port)
                && port is >= 1 and <= 65535)
            {
                return port;
            }
        }
        catch
        {
            // Last-run port is a hint only.
        }
        return null;
    }

    private static bool CanBindLoopback(int port)
    {
        try
        {
            var listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            listener.Stop();
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }

    private static int BindEphemeralLoopback()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            return ((IPEndPoint)listener.LocalEndpoint).Port;
        }
        finally
        {
            listener.Stop();
        }
    }

    private static HashSet<int> ListListeningPorts()
    {
        var ports = new HashSet<int>();
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
            if (proc == null) return ports;
            var output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit(3000);

            foreach (var line in output.Split('\n'))
            {
                if (!line.Contains("LISTENING", StringComparison.OrdinalIgnoreCase)) continue;
                var parts = line.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 2) continue;
                var colon = parts[1].LastIndexOf(':');
                if (colon < 0) continue;
                if (int.TryParse(parts[1][(colon + 1)..], out var port) && port is >= 1 and <= 65535)
                    ports.Add(port);
            }
        }
        catch { /* ignore */ }

        return ports;
    }

    private static int ReadManifestPort(string root)
    {
        try
        {
            var path = Path.Combine(root, "manifest.json");
            if (!File.Exists(path)) return DefaultPort;
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            if (doc.RootElement.TryGetProperty("api_port_default", out var value)
                && value.TryGetInt32(out var port)
                && port is >= 1 and <= 65535)
            {
                return port;
            }
        }
        catch
        {
            // Fall back to the product default.
        }
        return DefaultPort;
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
