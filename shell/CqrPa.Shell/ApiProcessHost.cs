using System.Diagnostics;
using System.ComponentModel;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text.Json;

namespace CqrPa.Shell;

/// <summary>Why the local API could not be started (drives the user-facing message).</summary>
public enum ApiStartFailureKind
{
    None,
    /// <summary>core\dist\main.js or runtime\node\node.exe is missing.</summary>
    FilesMissing,
    /// <summary>Windows refused to run node.exe (antivirus, Smart App Control, group policy).</summary>
    Blocked,
    Other,
}

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
    private bool _disposed;
    private bool _needsRestart;
    private readonly object _lifecycleGate = new();

    public TimeSpan RecommendedHealthTimeout =>
        _restartedAfterVersionMismatch ? TimeSpan.FromSeconds(90) : TimeSpan.FromSeconds(60);

    public int Port { get; private set; } = DefaultPort;

    /// <summary>Why <see cref="Start"/> returned false (shown to the user and logged).</summary>
    public string? LastStartFailure { get; private set; }

    public ApiStartFailureKind LastStartFailureKind { get; private set; }

    private StreamWriter? _stderrLog;
    private readonly object _stderrGate = new();

    public ApiProcessHost(string root)
    {
        _root = root;
        _expectedVersion = ReadManifestVersion(root);
        Port = ReadManifestPort(root);
        Environment.SetEnvironmentVariable("MY_AGENT_ROOT", root);
    }

    public bool Start()
    {
        LastStartFailure = null;
        LastStartFailureKind = ApiStartFailureKind.None;
        var script = Path.Combine(_root, "core", "dist", "main.js");
        if (!File.Exists(script))
        {
            LastStartFailure = $"파일 없음: {script}";
            LastStartFailureKind = ApiStartFailureKind.FilesMissing;
            return false;
        }

        var decision = ResolveOwnedPort(script);
        Port = decision.Port;
        PersistRuntimePort(Port);

        if (decision.ReuseExisting)
        {
            ShellStartupLog.Write($"api: reusing running API on port {Port}");
            return true;
        }

        if (decision.KillExisting)
        {
            if (decision.VersionMismatch)
                _restartedAfterVersionMismatch = true;
            ForceKillNodeListenersOnPort(Port);
            WaitForPortFree(Port, TimeSpan.FromSeconds(5));
        }

        var nodePath = Path.Combine(_root, "runtime", "node", "node.exe");
        if (!File.Exists(nodePath))
        {
            LastStartFailure = $"파일 없음: {nodePath}";
            LastStartFailureKind = ApiStartFailureKind.FilesMissing;
            return false;
        }

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

        try
        {
            _process = Process.Start(psi);
        }
        catch (Exception ex)
        {
            LastStartFailure = $"Node 실행 실패: {ex.Message}";
            // 5 access denied, 225 virus detected, 1260 blocked by policy, 4551 app control policy.
            LastStartFailureKind = ex is Win32Exception { NativeErrorCode: 5 or 225 or 1260 or 4551 }
                ? ApiStartFailureKind.Blocked
                : ApiStartFailureKind.Other;
            ShellStartupLog.WriteException("api: node start failed", ex);
            return false;
        }
        _startedByShell = _process != null;
        if (_startedByShell && _process != null)
        {
            OpenStderrLog();
            var started = _process;
            ShellStartupLog.Write($"api: started node pid={started.Id} port={Port}");
            _process.OutputDataReceived += (_, e) => { _ = e.Data; };
            _process.ErrorDataReceived += (_, e) => AppendStderr(e.Data);
            _process.EnableRaisingEvents = true;
            _process.Exited += (_, _) =>
            {
                int? code = null;
                try { code = started.ExitCode; } catch { /* unavailable */ }
                ShellStartupLog.Write($"api: node pid={started.Id} exited code={code?.ToString() ?? "?"}");
                AppendStderr($"[shell] node exited code={code?.ToString() ?? "?"}");
            };
            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();
        }
        else
        {
            LastStartFailure = "Node 프로세스를 만들지 못했습니다.";
            LastStartFailureKind = ApiStartFailureKind.Other;
        }
        return _startedByShell;
    }

    /// <summary>User-facing cause/advice for a failed <see cref="Start"/>.</summary>
    public static (string Title, string Cause, string Advice) DescribeStartFailure(ApiStartFailureKind kind) => kind switch
    {
        ApiStartFailureKind.FilesMissing => (
            "프로그램 파일 일부가 없습니다",
            "백신 프로그램이 파일을 격리했거나, 설치·업데이트가 중간에 멈췄을 수 있습니다.",
            "MY Agent를 다시 설치해 주세요. 백신이 격리했다면 격리 목록에서 복원해도 됩니다."),
        ApiStartFailureKind.Blocked => (
            "Windows가 MY Agent 실행을 막았습니다",
            "백신 프로그램, 스마트 앱 컨트롤 또는 회사 보안 정책이 로컬 서비스(node.exe) 실행을 차단했습니다.",
            "회사 PC라면 담당자에게 아래 버튼으로 저장한 기록을 보내 주세요."),
        _ => (
            "MY Agent를 시작하지 못했습니다",
            "로컬 서비스를 실행하지 못했습니다.",
            "PC를 다시 시작한 뒤 실행해 보고, 반복되면 담당자에게 기록을 보내 주세요."),
    };

    /// <summary>True when the node process this shell started has exited (crash or kill).</summary>
    public bool OwnedProcessExited
    {
        get
        {
            var process = _process;
            if (!_startedByShell || process is null) return false;
            try { return process.HasExited; }
            catch { return false; }
        }
    }

    /// <summary>The owned node exited, or an earlier restart attempt did not start it.</summary>
    public bool NeedsRestart => _needsRestart || OwnedProcessExited;

    /// <summary>
    /// Starts node again only when the shell-owned process has exited. A running-but-slow
    /// process is never restarted here (that would cut off in-flight chats).
    /// </summary>
    public bool TryRestartAfterExit()
    {
        lock (_lifecycleGate)
        {
            if (_disposed || !NeedsRestart) return false;
            _needsRestart = true;
            var previousPort = Port;
            var old = _process;
            _process = null;
            _startedByShell = false;
            try { old?.Dispose(); } catch { /* ignore */ }
            lock (_stderrGate)
            {
                try { _stderrLog?.Dispose(); } catch { /* ignore */ }
                _stderrLog = null;
            }
            var ok = Start();
            if (ok) _needsRestart = false;
            ShellStartupLog.Write(ok
                ? $"api_restart: node restarted port={Port}{(Port != previousPort ? $" (port changed from {previousPort})" : "")}"
                : $"api_restart: failed ({LastStartFailure ?? "unknown"})");
            return ok;
        }
    }

    /// <summary>
    /// Plain-language cause and advice when <c>/health</c> never became ready, based on the
    /// node exit state, the tail of <c>logs\api-stderr.log</c> and free disk space.
    /// </summary>
    public (string Cause, string Advice, bool DiskLow) DescribeStartupFailure()
    {
        if (ShellProblems.IsDiskLow(_root))
        {
            return (
                $"디스크 여유 공간이 부족합니다 (남은 공간 약 {ShellProblems.FreeDiskMb(_root)}MB).",
                "필요 없는 파일을 지운 뒤 다시 시도해 주세요.",
                true);
        }

        if (LastStartFailureKind != ApiStartFailureKind.None)
        {
            var described = DescribeStartFailure(LastStartFailureKind);
            return ($"{described.Title}. {described.Cause}", described.Advice, false);
        }

        var tail = ReadStderrTail();
        if (tail.Contains("EADDRINUSE", StringComparison.Ordinal))
            return ("다른 프로그램이 MY Agent가 쓰는 연결 통로(포트)를 쓰고 있습니다.", "PC를 다시 시작한 뒤 실행해 주세요.", false);
        if (tail.Contains("ENOSPC", StringComparison.Ordinal))
            return ("디스크 여유 공간이 부족합니다.", "필요 없는 파일을 지운 뒤 다시 시도해 주세요.", true);
        if (tail.Contains("EPERM", StringComparison.Ordinal) || tail.Contains("EACCES", StringComparison.Ordinal))
            return ("프로그램 파일에 접근하지 못했습니다. 백신 프로그램이 파일을 검사·차단하고 있을 수 있습니다.", "잠시 후 다시 시도하고, 반복되면 담당자에게 기록을 보내 주세요.", false);
        if (tail.Contains("Cannot find module", StringComparison.Ordinal) || tail.Contains("ERR_MODULE_NOT_FOUND", StringComparison.Ordinal))
            return ("프로그램 파일 일부가 없습니다. 설치나 업데이트가 중간에 멈췄을 수 있습니다.", "MY Agent를 다시 설치해 주세요.", false);

        if (OwnedProcessExited)
        {
            int? code = null;
            try { code = _process?.ExitCode; } catch { /* unavailable */ }
            return (
                $"로컬 서비스가 시작 직후 종료됐습니다 (종료 코드 {code?.ToString() ?? "?"}).",
                "다시 시도해 보고, 반복되면 담당자에게 기록을 보내 주세요.",
                false);
        }
        return (
            "로컬 서비스가 제한 시간 안에 준비되지 않았습니다. PC가 바쁘거나 백신 프로그램이 검사 중일 수 있습니다.",
            "잠시 후 다시 시도해 주세요.",
            false);
    }

    private string ReadStderrTail()
    {
        try
        {
            var path = Path.Combine(_root, "logs", "api-stderr.log");
            if (!File.Exists(path)) return "";
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var length = Math.Min(stream.Length, 16 * 1024);
            stream.Seek(-length, SeekOrigin.End);
            var buffer = new byte[length];
            stream.ReadExactly(buffer);
            var text = System.Text.Encoding.UTF8.GetString(buffer);
            // Only the latest start attempt is relevant.
            var start = text.LastIndexOf("api start port=", StringComparison.Ordinal);
            return start >= 0 ? text[start..] : text;
        }
        catch
        {
            return "";
        }
    }

    /// <summary>
    /// Node stderr used to be discarded, so a crashing API left nothing behind. Keep it in
    /// <c>logs\api-stderr.log</c> (rotated at 1 MB) for support.
    /// </summary>
    private void OpenStderrLog()
    {
        try
        {
            var directory = Path.Combine(_root, "logs");
            Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, "api-stderr.log");
            ShellStartupLog.RotateIfLarge(path);
            var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
            _stderrLog = new StreamWriter(stream, new System.Text.UTF8Encoding(false)) { AutoFlush = true };
            _stderrLog.WriteLine($"[shell] {DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz} api start port={Port}");
        }
        catch
        {
            _stderrLog = null;
        }
    }

    private void AppendStderr(string? line)
    {
        if (line is null) return;
        lock (_stderrGate)
        {
            try { _stderrLog?.WriteLine(line); }
            catch { /* diagnostics are best effort */ }
        }
    }

    /// <summary>One short /health probe (used by the background health monitor).</summary>
    public bool ProbeReady() => IsReady(ProbeHealth(Port));

    /// <summary>Node process state for diagnostics lines.</summary>
    public string DescribeNodeProcess()
    {
        var process = _process;
        if (!_startedByShell || process is null) return "node=reused-or-unowned";
        try
        {
            if (process.HasExited) return $"node pid={process.Id} exited code={process.ExitCode}";
            process.Refresh();
            return $"node pid={process.Id} running ws_mb={process.WorkingSet64 / 1048576}";
        }
        catch (Exception ex)
        {
            return $"node state unavailable ({ex.GetType().Name})";
        }
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

        // Sticky origin: the workspace UI runs at http://127.0.0.1:{port}/ and WebView2
        // scopes localStorage (pinned chats, active chat, composer prefs) per origin.
        // Right after an update the previous node listener may still be releasing its
        // socket; hopping to the next free port then silently "resets" those settings.
        // Prefer the last-used port, then the manifest port, and wait for a dying
        // node listener to release it before searching for another port.
        var sticky = new List<int>();
        if (recorded is int lastPort) sticky.Add(lastPort);
        if (!sticky.Contains(preferred)) sticky.Add(preferred);
        foreach (var port in sticky)
        {
            if (port != preferred && port == ActivationServerDefaultPort)
                continue;
            if (listening.Contains(port) && !WaitForNodeListenerRelease(port, TimeSpan.FromSeconds(10)))
                continue;
            if (CanBindLoopback(port))
                return new PortDecision(port, ReuseExisting: false, KillExisting: false, VersionMismatch: false);
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

    /// <summary>
    /// Waits only while the port is held by node processes (e.g. the previous API that is
    /// shutting down). A foreign non-node listener returns false immediately.
    /// </summary>
    private static bool WaitForNodeListenerRelease(int port, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (true)
        {
            var pids = FindListeningPids(port);
            if (pids.Count == 0)
                return true;
            if (!pids.All(IsNodeProcess))
                return false;
            if (DateTime.UtcNow >= deadline)
                return false;
            Thread.Sleep(250);
        }
    }

    private static bool IsNodeProcess(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            // Already exited: treat as releasing.
            return true;
        }
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
        lock (_lifecycleGate)
        {
            _disposed = true;
            if (_startedByShell && _process is { HasExited: false })
            {
                try { _process.Kill(entireProcessTree: true); } catch { /* ignore */ }
            }
            _process?.Dispose();
        }
        lock (_stderrGate)
        {
            try { _stderrLog?.Dispose(); } catch { /* ignore */ }
            _stderrLog = null;
        }
    }
}
