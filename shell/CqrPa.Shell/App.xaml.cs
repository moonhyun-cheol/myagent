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

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        RegisterUnhandledExceptionLogging();

        var args = e.Args;
        string root;
        string rootSource;
        try
        {
            root = CqrPaths.ResolveCqrRoot(out rootSource);
        }
        catch (Exception ex)
        {
            ShellStartupLog.WriteException("startup: install root not found", ex);
            MessageBox.Show(
                $"MY Agent 설치 폴더를 찾지 못했습니다.\n\n{ex.Message}\n\n기록: {ShellStartupLog.CurrentPath}",
                "MY Agent",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            Shutdown(1);
            return;
        }
        ShellStartupLog.SetRoot(root);
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

        _api = new ApiProcessHost(root);
        if (!_api.Start())
        {
            ShellStartupLog.Write($"startup: api start failed ({_api.LastStartFailure ?? "unknown"})");
            MessageBox.Show(
                $"API를 시작하지 못했습니다. 설치가 손상됐거나 Node 런타임을 찾지 못했습니다.\n\n{_api.LastStartFailure}\n\n기록: {ShellStartupLog.CurrentPath}",
                "MY Agent",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
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
    }

    /// <summary>
    /// Hands the launch to an already running instance. When that instance does not answer
    /// (hung, stuck while closing for an update, or an older build), the user gets an
    /// explanation and may end it instead of the launch exiting with no trace.
    /// </summary>
    private bool TryBecomePrimaryOrExplain(string root)
    {
        for (var attempt = 0; attempt < 2; attempt++)
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
            var pids = string.Join(",", others.Select(p => p.Id));
            if (outcome == SingleInstanceGuard.SecondaryOutcome.Acknowledged)
            {
                ShellStartupLog.Write($"single_instance: handed off to running instance pids=[{pids}]");
                foreach (var p in others) p.Dispose();
                return false;
            }

            ShellStartupLog.Write($"single_instance: running instance did not respond pids=[{pids}] attempt={attempt + 1}");
            if (attempt > 0 || others.Count == 0)
            {
                foreach (var p in others) p.Dispose();
                MessageBox.Show(
                    "이미 실행 중인 MY Agent가 응답하지 않아 새로 열 수 없습니다.\n"
                    + "작업 관리자에서 MYAgent.exe를 종료한 뒤 다시 실행해 주세요.\n\n"
                    + $"기록: {ShellStartupLog.CurrentPath}",
                    "MY Agent",
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);
                return false;
            }

            var answer = MessageBox.Show(
                "이미 실행 중인 MY Agent가 응답하지 않습니다.\n"
                + "창이나 트레이 아이콘 없이 멈춰 있는 것 같습니다.\n\n"
                + $"멈춘 MY Agent(PID {pids})를 종료하고 새로 시작할까요?\n"
                + "저장하지 않은 입력은 사라질 수 있습니다.",
                "MY Agent",
                MessageBoxButton.YesNo,
                MessageBoxImage.Warning);
            if (answer != MessageBoxResult.Yes)
            {
                ShellStartupLog.Write("single_instance: user declined to end the unresponsive instance");
                foreach (var p in others) p.Dispose();
                return false;
            }

            foreach (var p in others)
            {
                try
                {
                    p.Kill(entireProcessTree: true);
                    p.WaitForExit(10_000);
                    ShellStartupLog.Write($"single_instance: ended unresponsive instance pid={p.Id}");
                }
                catch (Exception ex)
                {
                    ShellStartupLog.WriteException($"single_instance: could not end pid={p.Id}", ex);
                }
                finally
                {
                    p.Dispose();
                }
            }
        }
        return false;
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
        try
        {
            MessageBox.Show(
                $"MY Agent를 시작하는 중 오류가 발생했습니다.\n\n{args.Exception.Message}\n\n기록: {ShellStartupLog.CurrentPath}",
                "MY Agent",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
        catch
        {
            // The process is terminating anyway.
        }
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
        _updatePolling?.Dispose();
        _singleInstance?.Dispose();
        _api?.Dispose();
        base.OnExit(e);
    }
}
