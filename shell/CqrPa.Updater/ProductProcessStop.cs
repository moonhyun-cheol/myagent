using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;

namespace CqrPa.Updater;

internal static class ProductProcessStop
{
    public static void StopAll(string root, int? parentPid, Action<string> log)
    {
        WaitForParentGracefully(parentPid, log);
        StopMatchedProcesses(root, log);
        StopNodeListeners(root, log);
        WaitForExit(root, TimeSpan.FromSeconds(15), log);
        if (AnyProductProcessRunning(root))
        {
            log("Some MY Agent processes remain; retrying this installation only.");
            StopAllMyAgentProcesses(root, log);
            StopNodeListeners(root, log);
            WaitForExit(root, TimeSpan.FromSeconds(10), log);
        }
    }

    private static void WaitForParentGracefully(int? parentPid, Action<string> log)
    {
        if (parentPid is null) return;
        try
        {
            using var parent = Process.GetProcessById(parentPid.Value);
            log($"Waiting for MY Agent process {parentPid.Value} to exit.");
            if (parent.WaitForExit((int)TimeSpan.FromSeconds(30).TotalMilliseconds)) return;
            log($"Parent process {parentPid.Value} did not exit within 30s; force stopping it.");
            TryKillProcess(parent, log);
        }
        catch (ArgumentException)
        {
            // The parent already exited.
        }
    }

    private static void StopMatchedProcesses(string root, Action<string> log)
    {
        foreach (var process in FindProductProcesses(root))
        {
            if (process.Id == Environment.ProcessId) continue;
            log($"Stopping MY Agent process {process.Id}.");
            TryKillProcess(process, log);
        }
    }

    private static void StopAllMyAgentProcesses(string root, Action<string> log)
    {
        foreach (var process in FindProductProcesses(root))
        {
            if (process.Id == Environment.ProcessId) continue;
            log($"Stopping MYAgent process {process.Id} (fallback).");
            TryKillProcess(process, log);
        }
    }

    private static void StopNodeListeners(string root, Action<string> log)
    {
        var port = ReadListeningPort(root);
        if (!ShouldStopNodeOnPort(root, port, log))
            return;

        foreach (var pid in FindListeningPids(port))
        {
            if (pid == Environment.ProcessId) continue;
            try
            {
                using var process = Process.GetProcessById(pid);
                if (!process.ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase)) continue;
                log($"Stopping node listener {pid} on port {port}.");
                TryKillProcess(process, log);
            }
            catch (ArgumentException)
            {
                // Process already exited.
            }
        }
    }

    private static bool ShouldStopNodeOnPort(string root, int port, Action<string> log)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            var json = http.GetStringAsync($"http://127.0.0.1:{port}/health").GetAwaiter().GetResult();
            using var document = JsonDocument.Parse(json);
            var cqrRoot = document.RootElement.TryGetProperty("cqr_root", out var value)
                ? value.GetString()
                : null;
            if (SameProductRoot(root, cqrRoot)) return true;
            log($"Port {port} is owned by another process; leaving it running.");
            return false;
        }
        catch
        {
            return PortRecordedByThisInstall(root, port);
        }
    }

    private static bool PortRecordedByThisInstall(string root, int port)
    {
        try
        {
            var runtimePath = Path.Combine(root, "data", "runtime", "api-port.json");
            if (!File.Exists(runtimePath)) return false;
            using var runtime = JsonDocument.Parse(File.ReadAllBytes(runtimePath));
            return runtime.RootElement.TryGetProperty("port", out var value)
                && value.TryGetInt32(out var recorded)
                && recorded == port;
        }
        catch
        {
            return false;
        }
    }

    private static bool SameProductRoot(string root, string? actual)
    {
        if (string.IsNullOrWhiteSpace(actual)) return false;
        try
        {
            var expectedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var actualRoot = Path.GetFullPath(actual).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return string.Equals(expectedRoot, actualRoot, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static IEnumerable<Process> FindProductProcesses(string root)
    {
        var fullRoot = Path.GetFullPath(root);
        var candidates = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            Path.GetFullPath(Path.Combine(fullRoot, "MYAgent.exe")),
            Path.GetFullPath(Path.Combine(fullRoot, "bin", "my-agent", "MYAgent.exe")),
        };
        foreach (var process in Process.GetProcessesByName("MYAgent"))
        {
            Process? matched = null;
            try
            {
                var path = process.MainModule?.FileName;
                if (path is not null && candidates.Contains(Path.GetFullPath(path)))
                    matched = process;
            }
            catch
            {
                // Accessing MainModule can fail; do not treat an unknown MYAgent as this install.
            }

            if (matched is not null) yield return matched;
        }
    }

    private static bool AnyProductProcessRunning(string root)
    {
        return FindProductProcesses(root).Any(process =>
        {
            try
            {
                return !process.HasExited;
            }
            catch
            {
                return false;
            }
        });
    }

    private static void WaitForExit(string root, TimeSpan timeout, Action<string> log)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (!AnyProductProcessRunning(root)) return;
            Thread.Sleep(200);
        }

        if (AnyProductProcessRunning(root))
            log("Timed out waiting for MY Agent processes to exit.");
    }

    private static void TryKillProcess(Process process, Action<string> log)
    {
        try
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
        }
        catch (Exception error)
        {
            log($"Failed to stop process {process.Id}: {error.Message}");
        }
    }

    internal static int ReadListeningPort(string root)
    {
        try
        {
            var runtimePath = Path.Combine(root, "data", "runtime", "api-port.json");
            if (File.Exists(runtimePath))
            {
                using var runtime = JsonDocument.Parse(File.ReadAllBytes(runtimePath));
                if (runtime.RootElement.TryGetProperty("port", out var runtimePort)
                    && runtimePort.TryGetInt32(out var parsedRuntimePort)
                    && parsedRuntimePort is >= 1 and <= 65535)
                {
                    return parsedRuntimePort;
                }
            }
        }
        catch
        {
            // Fall through to the manifest default.
        }

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(root, "manifest.json")));
            if (document.RootElement.TryGetProperty("api_port_default", out var portValue)
                && portValue.TryGetInt32(out var parsedPort)
                && parsedPort is >= 1 and <= 65535)
            {
                return parsedPort;
            }
        }
        catch
        {
            // Fall back to the product default.
        }

        return 10200;
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
            if (proc is null) return pids;
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
        catch
        {
            // Port probing is best effort only.
        }

        return pids;
    }
}
