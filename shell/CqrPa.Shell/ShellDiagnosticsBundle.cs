using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using Microsoft.Web.WebView2.Core;

namespace CqrPa.Shell;

/// <summary>
/// Collects the local diagnostics a support person needs for "꺼짐 / 멈춤 / 실행 실패"
/// into one ZIP on the Desktop. Works without the local API (the API may be the thing that
/// is broken), so it is reachable from Settings, the tray menu, failure dialogs, and
/// <c>MYAgent.exe --collect-diagnostics</c>. Only log/state files are included — no chats,
/// vault, provider keys, or workspace files.
/// </summary>
internal static class ShellDiagnosticsBundle
{
    public const string CommandLineFlag = "--collect-diagnostics";
    private const long MaxFileBytes = 8L * 1024 * 1024;

    private static readonly string[] RootRelativeFiles =
    {
        "manifest.json",
        "VERSION.txt",
        @"data\runtime\api-port.json",
        @"data\logs\shell-startup.log",
        @"data\logs\shell-startup.log.1",
        @"data\logs\shell-session.marker",
        @"data\logs\error-reports.jsonl",
        @"logs\api-runtime.log",
        @"logs\api-runtime.log.1",
        @"logs\api-stderr.log",
        @"logs\api-stderr.log.1",
        @"logs\api-start.log",
        @"logs\slow-requests.log",
        @"logs\slow-requests.log.1",
        @"logs\api-guard.log",
    };

    /// <summary>Creates the ZIP and returns its full path. Throws only when the ZIP itself cannot be written.</summary>
    public static string Create(string? root)
    {
        var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        if (string.IsNullOrWhiteSpace(desktop) || !Directory.Exists(desktop))
            desktop = Path.GetTempPath();
        var zipPath = Path.Combine(desktop, $"MYAgent-진단-{DateTime.Now:yyyyMMdd-HHmmss}.zip");

        using (var zip = ZipFile.Open(zipPath, ZipArchiveMode.Create))
        {
            var notes = new StringBuilder();
            if (!string.IsNullOrWhiteSpace(root))
            {
                foreach (var relative in RootRelativeFiles)
                    AddFile(zip, Path.Combine(root, relative), relative.Replace('\\', '/'), notes);
            }
            else
            {
                notes.AppendLine("install root: (unknown)");
            }

            var local = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MYAgent");
            AddFile(zip, Path.Combine(local, "shell-startup.log"), "localappdata/shell-startup.log", notes);
            AddFile(zip, Path.Combine(local, "install-root.json"), "localappdata/install-root.json", notes);

            AddText(zip, "system-info.txt", BuildSystemInfo(root) + (notes.Length > 0 ? $"\n[skipped]\n{notes}" : ""));
            AddText(zip, "windows-events.txt", ReadWindowsEvents());
            AddText(zip, "README.txt",
                "MY Agent 진단 묶음\n"
                + "- localappdata/, data/logs/shell-startup.log : 창(셸) 시작·멈춤(ui_hang)·비정상 종료(previous_session)·화면 엔진(webview_process_failed) 기록\n"
                + "- logs/api-runtime.log : 로컬 서비스 시작/종료(exit)/충돌(crash)/멈춤(event_loop_stall)\n"
                + "- logs/api-stderr.log : 로컬 서비스 오류 출력\n"
                + "- logs/slow-requests.log : 느린 요청\n"
                + "- windows-events.txt : Windows가 기록한 응용 프로그램 오류·응답 없음(Application Hang)\n"
                + "대화 내용·API 키·작업 폴더 파일은 포함되지 않습니다.\n");
        }

        ShellStartupLog.Write($"diagnostics: bundle created {zipPath}");
        return zipPath;
    }

    /// <summary>Create + reveal in Explorer; returns a user-facing message.</summary>
    public static string CreateAndReveal(string? root)
    {
        try
        {
            var path = Create(root);
            try
            {
                Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true });
            }
            catch
            {
                // Revealing is optional.
            }
            return $"진단 기록을 모았습니다.\n\n{path}\n\n이 파일을 담당자에게 보내 주세요. 대화 내용·API 키는 들어 있지 않습니다.";
        }
        catch (Exception ex)
        {
            ShellStartupLog.WriteException("diagnostics: bundle failed", ex);
            return $"진단 기록을 모으지 못했습니다.\n\n{ex.Message}\n\n기록 위치: {ShellStartupLog.CurrentPath}";
        }
    }

    private static void AddFile(ZipArchive zip, string source, string entryName, StringBuilder notes)
    {
        try
        {
            if (!File.Exists(source)) return;
            // Live logs (api-stderr.log) stay open for append by the shell; share for read.
            using var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (input.Length > MaxFileBytes) input.Seek(-MaxFileBytes, SeekOrigin.End);
            var entry = zip.CreateEntry(entryName, CompressionLevel.Optimal);
            using var output = entry.Open();
            input.CopyTo(output);
        }
        catch (Exception ex)
        {
            notes.AppendLine($"{entryName}: {ex.GetType().Name} {ex.Message}");
        }
    }

    private static void AddText(ZipArchive zip, string entryName, string text)
    {
        try
        {
            var entry = zip.CreateEntry(entryName, CompressionLevel.Optimal);
            using var writer = new StreamWriter(entry.Open(), new UTF8Encoding(false));
            writer.Write(text);
        }
        catch
        {
            // Best effort.
        }
    }

    private static string BuildSystemInfo(string? root)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"collected: {DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz}");
        sb.AppendLine($"root: {root ?? "(unknown)"}");
        sb.AppendLine(ShellStartupLog.DescribeProcess());
        sb.AppendLine($"64bit_os: {Environment.Is64BitOperatingSystem} cpus: {Environment.ProcessorCount}");
        try
        {
            var gc = GC.GetGCMemoryInfo();
            sb.AppendLine($"physical_memory_mb: {gc.TotalAvailableMemoryBytes / 1048576}");
        }
        catch { /* optional */ }
        try
        {
            sb.AppendLine($"webview2_runtime: {CoreWebView2Environment.GetAvailableBrowserVersionString() ?? "(none)"}");
        }
        catch (Exception ex)
        {
            sb.AppendLine($"webview2_runtime: unavailable ({ex.GetType().Name}: {ex.Message})");
        }
        try
        {
            if (!string.IsNullOrWhiteSpace(root))
            {
                var drive = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(root))!);
                sb.AppendLine($"disk_free_mb: {drive.AvailableFreeSpace / 1048576} ({drive.Name})");
            }
        }
        catch { /* optional */ }

        sb.AppendLine();
        sb.AppendLine("[processes]");
        foreach (var name in new[] { "MYAgent", "node", "msedgewebview2", "MYAgent.Updater" })
        {
            try
            {
                foreach (var p in Process.GetProcessesByName(name))
                {
                    using (p)
                    {
                        string started;
                        try { started = p.StartTime.ToString("yyyy-MM-dd HH:mm:ss"); } catch { started = "?"; }
                        string responding;
                        try { responding = p.MainWindowHandle != IntPtr.Zero ? p.Responding.ToString() : "-"; } catch { responding = "?"; }
                        sb.AppendLine($"{name} pid={p.Id} ws_mb={p.WorkingSet64 / 1048576} started={started} responding={responding}");
                    }
                }
            }
            catch { /* optional */ }
        }
        return sb.ToString();
    }

    /// <summary>
    /// Recent Windows Application-log crash/hang events that mention our processes.
    /// Uses wevtutil so no extra assembly is required.
    /// </summary>
    private static string ReadWindowsEvents()
    {
        try
        {
            var query = "*[System[(Provider[@Name='Application Error'] or Provider[@Name='Application Hang'] or Provider[@Name='.NET Runtime'] or Provider[@Name='Windows Error Reporting']) and TimeCreated[timediff(@SystemTime) <= 1209600000]]]";
            var psi = new ProcessStartInfo
            {
                FileName = "wevtutil",
                Arguments = $"qe Application /q:\"{query}\" /c:200 /rd:true /f:text",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            using var proc = Process.Start(psi);
            if (proc is null) return "wevtutil: not started";
            var output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit(15_000);
            var blocks = output.Split("Event[", StringSplitOptions.RemoveEmptyEntries)
                .Where(block => block.Contains("MYAgent", StringComparison.OrdinalIgnoreCase)
                    || block.Contains("node.exe", StringComparison.OrdinalIgnoreCase)
                    || block.Contains("msedgewebview2", StringComparison.OrdinalIgnoreCase))
                .Take(40)
                .Select(block => "Event[" + block.TrimEnd())
                .ToList();
            return blocks.Count == 0
                ? "최근 14일 동안 MY Agent 관련 Windows 오류/응답 없음 이벤트가 없습니다."
                : string.Join(Environment.NewLine + Environment.NewLine, blocks);
        }
        catch (Exception ex)
        {
            return $"wevtutil failed: {ex.GetType().Name} {ex.Message}";
        }
    }
}
