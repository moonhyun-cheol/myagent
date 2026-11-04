using System.Diagnostics;
using System.Windows;
using System.Windows.Threading;
using Application = System.Windows.Application;
using MessageBox = System.Windows.MessageBox;

namespace CqrPa.Shell;

public partial class App : Application
{
    private ApiProcessHost? _api;
    private SingleInstanceGuard? _singleInstance;
    private UpdatePollingService? _updatePolling;
    private ShellHealthMonitor? _healthMonitor;
    private bool _sessionStarted;
    private string? _root;
    private bool _startupErrorShown;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        RegisterUnhandledExceptionLogging();

        var args = e.Args;
        if (args.Contains(ShellDiagnosticsBundle.CommandLineFlag, StringComparer.OrdinalIgnoreCase))
        {
            // Works even while another instance is hung: no single-instance gate, no API.
            string? diagRoot = null;
            try { diagRoot = CqrPaths.ResolveCqrRoot(out _); } catch { /* collect what we can */ }
            if (diagRoot is not null) ShellStartupLog.SetRoot(diagRoot);
            MessageBox.Show(ShellDiagnosticsBundle.CreateAndReveal(diagRoot), "MY Agent 진단", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown(0);
            return;
        }

        string root;
        string rootSource;
        try
        {
            root = CqrPaths.ResolveCqrRoot(out rootSource);
        }
        catch (Exception ex)
        {
            ShellStartupLog.WriteException("startup: install root not found", ex);
            ShellProblems.ShowDialog(
                null,
                null,
                "MY Agent 설치 폴더를 찾지 못했습니다",
                "프로그램 파일이 다른 곳으로 옮겨졌거나 일부가 지워졌을 수 있습니다.",
                "「설치 파일 받기」를 눌러 최신 설치 파일을 받은 뒤 MY Agent를 다시 설치해 주세요.",
                ShellProblems.ReinstallAction());
            Shutdown(1);
            return;
        }
        ShellStartupLog.SetRoot(root);
        _root = root;
        // NOTE: The former CleanupLegacyWorkKitLauncher() startup sweep was removed.
        // The operator admin program is now reinstalled into this same install folder
        // as WorkKitLauncher.exe with a "MY Agent 관리자.lnk" desktop shortcut, so the
        // filename-based legacy delete-list ended up wiping the current admin app and its
        // shortcut on every MY Agent launch (e.g. breaking admin 1.0.12 / skill 21 sync).
        // Pre-update-51 launcher leftovers are inert (core no longer calls /launcher/*),
        // so blind deletion in a now-shared folder is removed entirely.

        if (args.Contains("--verify-update-feed", StringComparer.OrdinalIgnoreCase))
        {
            var code = VerifyUpdateFeedCommand(args);
            Shutdown(code);
            return;
        }

        ShellStartupLog.Write($"startup: root={root} source={rootSource} {ShellStartupLog.DescribeProcess()}");

        if (!TryBecomePrimaryOrExplain(root))
        {
            Shutdown(0);
            return;
        }
        ShellStartupLog.BeginSession();
        _sessionStarted = true;

        _api = new ApiProcessHost(root);
        if (!_api.Start())
        {
            ShellStartupLog.Write($"startup: api start failed kind={_api.LastStartFailureKind} ({_api.LastStartFailure ?? "unknown"})");
            ShowApiStartFailure(root, _api.LastStartFailureKind);
            Shutdown(1);
            return;
        }
        ShellStartupLog.Write($"startup: api port={_api.Port}");

        // Show the shell immediately. MainWindow owns the non-blocking health/loading state,
        // so a cold Node/WebView start never looks like a failed double-click.
        var win = new MainWindow(root, _api.Port, _api);
        _singleInstance?.SetActivateHandler(() =>
        {
            Dispatcher.Invoke(() =>
            {
                if (MainWindow is MainWindow mainWindow) mainWindow.RestoreFromTray();
            });
        });
        MainWindow = win;
        var updateService = UpdateService.TryCreate(root);
        if (updateService is not null)
        {
            _updatePolling = new UpdatePollingService(win, root, _api.Port, updateService);
            win.UpdatePolling = _updatePolling;
            win.ContentRendered += async (_, _) =>
            {
                try
                {
                    await _updatePolling.StartAsync(CancellationToken.None);
                }
                catch (OperationCanceledException)
                {
                    /* app closing */
                }
            };
        }
        win.Show();
        ShellStartupLog.Write("startup: main window shown");
        _healthMonitor = new ShellHealthMonitor(Dispatcher, _api, win.OnApiRestarted, win.OnApiGaveUp);
        _healthMonitor.Start();
    }

    private static void ShowApiStartFailure(string root, ApiStartFailureKind kind)
    {
        if (ShellProblems.IsDiskLow(root))
        {
            ShellProblems.ShowDialog(
                null,
                root,
                "MY Agent를 시작하지 못했습니다",
                $"디스크 여유 공간이 부족합니다 (약 {ShellProblems.FreeDiskMb(root)}MB).",
                "필요 없는 파일을 지운 뒤 다시 실행해 주세요.",
                ShellProblems.DiskCleanupAction());
            return;
        }
        var (title, cause, advice) = ApiProcessHost.DescribeStartFailure(kind);
        ShellProblems.ShowDialog(
            null,
            root,
            title,
            cause,
            advice,
            kind == ApiStartFailureKind.FilesMissing ? ShellProblems.ReinstallAction() : null);
    }

    private static readonly TimeSpan StillStartingAge = TimeSpan.FromSeconds(20);

    /// <summary>
    /// Hands the launch to an already running instance. When that instance does not answer:
    /// <list type="bullet">
    /// <item>the core updater is running → never end it; explain and exit.</item>
    /// <item>it exits on its own within a few seconds (was closing) → take over.</item>
    /// <item>it has no window at all and is not just starting → it is stuck closing/starting;
    /// end it automatically (logged) and take over.</item>
    /// <item>otherwise (a window exists, possibly busy) → ask once before ending it.</item>
    /// </list>
    /// </summary>
    private bool TryBecomePrimaryOrExplain(string root)
    {
        const int maxAttempts = 3;
        for (var attempt = 0; attempt < maxAttempts; attempt++)
        {
            if (SingleInstanceGuard.TryBecomePrimary(
                    root,
                    TimeSpan.FromSeconds(5),
                    out _singleInstance,
                    out var outcome))
            {
                return true;
            }

            var others = ShellStartupLog.FindOtherShellProcesses();
            try
            {
                var pids = string.Join(",", others.Select(p => p.Id));
                if (outcome == SingleInstanceGuard.SecondaryOutcome.Acknowledged)
                {
                    ShellStartupLog.Write($"single_instance: handed off to running instance pids=[{pids}]");
                    return false;
                }
                ShellStartupLog.Write($"single_instance: running instance did not respond pids=[{pids}] attempt={attempt + 1}");

                if (ShellProblems.IsUpdaterRunning())
                {
                    ShellStartupLog.Write("single_instance: updater is running; not ending the instance");
                    ShellProblems.ShowDialog(
                        null,
                        root,
                        "업데이트를 마무리하는 중입니다",
                        "MY Agent가 업데이트 파일을 바꾸고 있어 지금은 새로 열 수 없습니다.",
                        "업데이트가 끝난 뒤 다시 실행해 주세요. 보통 1~2분 걸립니다.");
                    return false;
                }

                if (others.Count == 0 || attempt == maxAttempts - 1)
                {
                    if (others.Count == 0 && attempt < maxAttempts - 1)
                    {
                        Thread.Sleep(1000);
                        continue;
                    }
                    ShowUnresponsiveGiveUp(root);
                    return false;
                }

                if (WaitForAllExit(others, TimeSpan.FromSeconds(8)))
                {
                    ShellStartupLog.Write("single_instance: previous instance finished closing on its own");
                    continue;
                }

                var states = others.Select(p => (Process: p, Windows: ShellProblems.DescribeWindows(p.Id), Age: ProcessAge(p))).ToList();
                var detail = string.Join(" ", states.Select(s => $"pid={s.Process.Id} windows={s.Windows.Count} hung={s.Windows.AnyHung} age_s={s.Age.TotalSeconds:F0}"));
                ShellStartupLog.Write($"single_instance: state {detail}");

                if (states.Any(s => s.Age < StillStartingAge))
                {
                    ShellStartupLog.Write("single_instance: previous instance is still starting; waiting");
                    Thread.Sleep(3000);
                    continue;
                }

                if (states.All(s => s.Windows.Count == 0))
                {
                    ShellStartupLog.Write("single_instance: previous instance has no window (stuck closing/starting); ending it automatically");
                    EndProcesses(others);
                    continue;
                }

                var hung = states.Any(s => s.Windows.AnyHung);
                var answer = MessageBox.Show(
                    (hung
                        ? "이미 열려 있는 MY Agent 창이 '응답 없음' 상태입니다.\n"
                        : "이미 실행 중인 MY Agent가 응답하지 않습니다. 무거운 작업 중이라 늦어지는 것일 수도 있습니다.\n")
                    + "\n멈춘 MY Agent를 끝내고 새로 시작할까요?\n"
                    + "진행 중인 대화 응답과 저장하지 않은 입력은 사라질 수 있습니다.\n\n"
                    + "[아니요]를 누르면 기존 창을 그대로 둡니다.",
                    "MY Agent",
                    MessageBoxButton.YesNo,
                    MessageBoxImage.Warning,
                    MessageBoxResult.No);
                if (answer != MessageBoxResult.Yes)
                {
                    ShellStartupLog.Write($"single_instance: user declined to end the unresponsive instance (hung={hung})");
                    return false;
                }
                ShellStartupLog.Write($"single_instance: user chose to end the unresponsive instance (hung={hung})");
                EndProcesses(others);
            }
            finally
            {
                foreach (var p in others) p.Dispose();
            }
        }
        return false;
    }

    private static void ShowUnresponsiveGiveUp(string root)
    {
        ShellProblems.ShowDialog(
            null,
            root,
            "이미 실행 중인 MY Agent가 응답하지 않습니다",
            "기존 MY Agent가 멈춰 있어 새로 열 수 없습니다.",
            "작업 관리자에서 MYAgent를 끝낸 뒤 다시 실행해 주세요. 그래도 안 되면 PC를 다시 시작해 주세요.",
            new ShellProblemAction("작업 관리자 열기", () => Process.Start(new ProcessStartInfo("taskmgr.exe") { UseShellExecute = true })));
    }

    private static bool WaitForAllExit(List<Process> processes, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        foreach (var p in processes)
        {
            var remaining = deadline - DateTime.UtcNow;
            try
            {
                if (remaining <= TimeSpan.Zero ? !p.HasExited : !p.WaitForExit(remaining)) return false;
            }
            catch
            {
                // Inaccessible: treat as still running.
                return false;
            }
        }
        return true;
    }

    private static TimeSpan ProcessAge(Process process)
    {
        try { return DateTime.Now - process.StartTime; }
        catch { return TimeSpan.MaxValue; }
    }

    private static void EndProcesses(List<Process> processes)
    {
        foreach (var p in processes)
        {
            try
            {
                if (p.HasExited) continue;
                p.Kill(entireProcessTree: true);
                p.WaitForExit(10_000);
                ShellStartupLog.Write($"single_instance: ended unresponsive instance pid={p.Id}");
            }
            catch (Exception ex)
            {
                ShellStartupLog.WriteException($"single_instance: could not end pid={p.Id}", ex);
            }
        }
    }

    private void RegisterUnhandledExceptionLogging()
    {
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            ShellStartupLog.WriteException(
                $"unhandled (terminating={args.IsTerminating})",
                args.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, args) =>
            ShellStartupLog.WriteException("unobserved task exception", args.Exception);
    }

    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs args)
    {
        ShellStartupLog.WriteException("dispatcher unhandled exception", args.Exception);
        if (MainWindow is not null && MainWindow.IsLoaded) return; // keep existing crash semantics after startup
        if (_startupErrorShown) return;
        _startupErrorShown = true;
        // Same plain-language dialog as other failures; the exception text stays in the log only.
        // ShowDialog falls back to a MessageBox itself and never throws.
        ShellProblems.ShowDialog(
            null,
            _root,
            "MY Agent를 시작하지 못했습니다",
            "시작하는 중 프로그램 내부 오류가 발생했습니다.",
            "MY Agent를 다시 실행해 주세요. 계속되면 「담당자에게 보낼 기록 저장」으로 기록을 저장해 담당자에게 보내 주세요.");
    }

    private static int VerifyUpdateFeedCommand(string[] args)
    {
        try
        {
            string RequireValue(string flag)
            {
                var index = Array.FindIndex(args, item =>
                    string.Equals(item, flag, StringComparison.OrdinalIgnoreCase));
                if (index < 0 || index + 1 >= args.Length)
                    throw new ArgumentException($"{flag} is required.");
                return args[index + 1];
            }

            var feed = File.ReadAllBytes(RequireValue("--feed"));
            var publicKey = File.ReadAllText(RequireValue("--public-key"));
            _ = UpdateFeedVerifier.Verify(
                feed,
                publicKey,
                RequireValue("--repository"),
                RequireValue("--channel"));
            return 0;
        }
        catch
        {
            return 1;
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _healthMonitor?.Dispose();
        if (_sessionStarted) ShellStartupLog.EndSession($"exit code={e.ApplicationExitCode}");
        _updatePolling?.Dispose();
        _singleInstance?.Dispose();
        _api?.Dispose();
        base.OnExit(e);
    }
}
