using System.Windows;
using CqrPa.Shell;
using Application = System.Windows.Application;
using MessageBox = System.Windows.MessageBox;

namespace CqrPa.WorkKitLauncher;

public partial class App : Application
{
    private ApiProcessHost? _api;
    private LauncherUpdatePollingService? _updatePolling;
    private bool _leaveApiRunning;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var args = e.Args;

        if (args.Contains("--verify-launcher-feed", StringComparer.OrdinalIgnoreCase))
        {
            Shutdown(VerifyLauncherFeedCommand(args));
            return;
        }

        if (args.Contains("--apply-update", StringComparer.OrdinalIgnoreCase))
        {
            Shutdown(LauncherUpdateApplier.Run(args));
            return;
        }

        if (args.Contains("--companion-update", StringComparer.OrdinalIgnoreCase))
        {
            string cqrRoot;
            try
            {
                cqrRoot = CqrPaths.ResolveCqrRoot();
            }
            catch
            {
                Shutdown(1);
                return;
            }
            Shutdown(LauncherCompanionUpdate.Run(cqrRoot));
            return;
        }

        DispatcherUnhandledException += (_, argsEx) =>
        {
            MessageBox.Show(
                argsEx.Exception.Message,
                "MY Agent 관리자",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            argsEx.Handled = true;
            Shutdown(1);
        };

        string root;
        try
        {
            root = CqrPaths.ResolveCqrRoot();
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"{ex.Message}\n\nMY Agent가 설치된 폴더에서 실행하거나 MY_AGENT_ROOT 환경 변수를 설정하세요.",
                "MY Agent 관리자",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            Shutdown(1);
            return;
        }

        _api = new ApiProcessHost(root);
        if (!_api.Start())
        {
            MessageBox.Show(
                "Core API를 시작하지 못했습니다. MY Agent가 설치되어 있는지 확인하세요.",
                "MY Agent 관리자",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            Shutdown(1);
            return;
        }

        var win = new MainWindow(root, _api.Port, _api);
        MainWindow = win;
        var updateService = LauncherUpdateService.TryCreate(root);
        if (updateService is not null)
        {
            _updatePolling = new LauncherUpdatePollingService(win, updateService);
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
    }

    internal void PrepareForLauncherUpdateExit() => _leaveApiRunning = true;

    private static int VerifyLauncherFeedCommand(string[] args)
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
            _ = LauncherUpdateFeedVerifier.Verify(
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
        if (!_leaveApiRunning) _api?.Dispose();
        base.OnExit(e);
    }
}
