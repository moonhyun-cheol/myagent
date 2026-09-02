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
