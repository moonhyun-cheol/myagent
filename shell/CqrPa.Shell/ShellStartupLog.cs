using System.Diagnostics;
using System.Text;

namespace CqrPa.Shell;

/// <summary>
/// Best-effort shell diagnostics. Startup paths that end without a window (single-instance
/// exit, root resolution failure, unhandled exceptions) used to leave no trace at all, so a
/// user-reported "it does not open" could not be diagnosed on a PC we cannot access.
/// Writes to <c>{root}\data\logs\shell-startup.log</c>, or <c>%LOCALAPPDATA%\MYAgent</c>
/// before the root is known. Logging must never throw.
/// </summary>
internal static class ShellStartupLog
{
    private const long MaxBytes = 1024 * 1024;
    private static readonly object Gate = new();
    private static string? _root;

    public static void SetRoot(string root) => _root = root;

    public static string CurrentPath
    {
        get
        {
            if (!string.IsNullOrWhiteSpace(_root))
                return Path.Combine(_root, "data", "logs", "shell-startup.log");
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(local, "MYAgent", "shell-startup.log");
        }
    }

    public static void Write(string message)
    {
        try
        {
            var line = $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss.fff zzz} pid={Environment.ProcessId} {message}{Environment.NewLine}";
            lock (Gate)
            {
                var path = CurrentPath;
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                RotateIfLarge(path);
                File.AppendAllText(path, line, Encoding.UTF8);
            }
        }
        catch
        {
            // Diagnostics are best effort.
        }
    }

    public static void WriteException(string context, Exception? ex)
    {
        Write($"{context}: {ex?.ToString() ?? "(no exception object)"}");
    }

    internal static void RotateIfLarge(string path)
    {
        try
        {
            var info = new FileInfo(path);
            if (info.Exists && info.Length > MaxBytes)
                File.Move(path, path + ".1", overwrite: true);
        }
        catch
        {
            // Rotation is best effort.
        }
    }

    public static string DescribeProcess()
    {
        try
        {
            return $"exe={Environment.ProcessPath} version={typeof(ShellStartupLog).Assembly.GetName().Version} "
                + $"os={Environment.OSVersion.VersionString} user={Environment.UserName}";
        }
        catch
        {
            return "exe=(unknown)";
        }
    }

    /// <summary>Other running shells of the same executable (the likely single-instance owner).</summary>
    public static List<Process> FindOtherShellProcesses()
    {
        var result = new List<Process>();
        try
        {
            using var current = Process.GetCurrentProcess();
            var currentPath = Environment.ProcessPath;
            foreach (var process in Process.GetProcessesByName(current.ProcessName))
            {
                if (process.Id == current.Id)
                {
                    process.Dispose();
                    continue;
                }
                string? path = null;
                try { path = process.MainModule?.FileName; } catch { /* access denied */ }
                if (path is null || currentPath is null
                    || string.Equals(path, currentPath, StringComparison.OrdinalIgnoreCase))
                {
                    result.Add(process);
                }
                else
                {
                    process.Dispose();
                }
            }
        }
        catch
        {
            // Enumeration is best effort.
        }
        return result;
    }
}
