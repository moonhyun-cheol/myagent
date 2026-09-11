using System.Windows;
using Application = System.Windows.Application;
using MessageBox = System.Windows.MessageBox;

namespace CqrPa.Shell;

public partial class App : Application
{
    private ApiProcessHost? _api;
    private SingleInstanceGuard? _singleInstance;
    private UpdatePollingService? _updatePolling;
    private WorkEnvironmentUpdatePollingService? _workEnvironmentPolling;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        var args = e.Args;
        var root = CqrPaths.ResolveCqrRoot();
        CleanupLegacyWorkKitLauncher(root);

        if (args.Contains("--verify-update-feed", StringComparer.OrdinalIgnoreCase))
        {
            var code = VerifyUpdateFeedCommand(args);
            Shutdown(code);
            return;
        }

        if (!SingleInstanceGuard.TryBecomePrimary(root, out _singleInstance))
        {
            Shutdown(0);
            return;
        }

        _api = new ApiProcessHost(root);
        if (!_api.Start())
        {
            MessageBox.Show(
                "API를 시작하지 못했습니다. 설치가 손상됐거나 Node 런타임을 찾지 못했습니다.",
                "MY Agent",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            Shutdown(1);
            return;
        }

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
        _workEnvironmentPolling = new WorkEnvironmentUpdatePollingService(win, _api.Port);
        win.WorkEnvironmentPolling = _workEnvironmentPolling;
        win.ContentRendered += async (_, _) =>
        {
            try
            {
                await _workEnvironmentPolling.StartAsync(CancellationToken.None);
            }
            catch (OperationCanceledException)
            {
                /* app closing */
            }
        };
        win.Show();
    }

    private static void CleanupLegacyWorkKitLauncher(string root)
    {
        // Best-effort migration only. A locked legacy exe must never block MY Agent startup.
        foreach (var file in new[]
        {
            Path.Combine(root, "WorkKitLauncher.exe"),
            Path.Combine(root, "launcher-manifest.json"),
        })
        {
            try { if (File.Exists(file)) File.Delete(file); } catch { }
        }
        foreach (var directory in new[]
        {
            Path.Combine(root, "bin", "work-kit-launcher"),
            Path.Combine(root, "ui", "work-kit-launcher"),
            Path.Combine(root, "shell", "WorkKitLauncher"),
        })
        {
            try { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); } catch { }
        }
        var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        foreach (var name in new[] { "MY Agent 관리자.lnk", "WorkKitLauncher.lnk", "MY Agent Work Kit.lnk", "MY Agent 작업 환경.lnk" })
        {
            try
            {
                var shortcut = Path.Combine(desktop, name);
                if (File.Exists(shortcut)) File.Delete(shortcut);
            }
            catch { }
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
        _workEnvironmentPolling?.Dispose();
        _singleInstance?.Dispose();
        _api?.Dispose();
        base.OnExit(e);
    }
}
