using System.Net.Http;
using System.Windows;
using Application = System.Windows.Application;
using MessageBox = System.Windows.MessageBox;

namespace CqrPa.Shell;

public partial class App : Application
{
    private ApiProcessHost? _api;
    private bool _updateCheckStarted;

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

        if (args.Contains("--import-license", StringComparer.OrdinalIgnoreCase))
        {
            var code = LicenseImporter.Run(args, root);
            Shutdown(code);
            return;
        }

        _api = new ApiProcessHost(root);
        if (!_api.Start())
        {
            MessageBox.Show("API 시작 실패. 설치 파일이 손상되었을 수 있습니다. MY Agent를 다시 설치하세요.", "MY Agent", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
            return;
        }

        // Show the shell immediately. MainWindow owns the non-blocking health/loading state,
        // so a cold Node/WebView start never looks like a failed double-click.
        var win = new MainWindow(root, _api.Port, _api);
        MainWindow = win;
        win.ContentRendered += async (_, _) =>
        {
            if (_updateCheckStarted) return;
            _updateCheckStarted = true;
            await CheckForUpdatesAsync(win, root);
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
        _api?.Dispose();
        base.OnExit(e);
    }

    private async Task CheckForUpdatesAsync(Window owner, string root)
    {
        var updateService = UpdateService.TryCreate(root);
        if (updateService is null) return;
        using var cancellation = new CancellationTokenSource();
        using var downloadCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellation.Token);
        var userAccepted = false;
        var userCanceledDownload = false;
        var updaterLaunched = false;
        UpdateProgressWindow? progressWindow = null;
        void CancelOnClose(object? _, EventArgs __) => cancellation.Cancel();
        owner.Closed += CancelOnClose;
        try
        {
            await Task.Delay(750, cancellation.Token);
            var update = await updateService.CheckAsync(cancellation.Token);
            if (update is null) return;

            if (owner is MainWindow mainWindow) mainWindow.RestoreFromTray();
            else
            {
                owner.Show();
                owner.Activate();
            }

            var notes = string.IsNullOrWhiteSpace(update.ReleaseNotes)
                ? "안정성 개선 및 최신 구성요소가 포함되어 있습니다."
                : update.ReleaseNotes.Trim();
            if (notes.Length > 1200) notes = notes[..1200] + "…";
            var accepted = MessageBox.Show(
                owner,
                $"MY Agent {update.Version} 업데이트가 있습니다.\n\n{notes}\n\n"
                + "지금 다운로드하고 다시 시작할까요?",
                "MY Agent 업데이트",
                MessageBoxButton.YesNo,
                MessageBoxImage.Information,
                MessageBoxResult.Yes);
            if (accepted != MessageBoxResult.Yes) return;

            userAccepted = true;
            progressWindow = new UpdateProgressWindow { Owner = owner };
            progressWindow.Canceled += () =>
            {
                userCanceledDownload = true;
                downloadCancellation.Cancel();
            };
            progressWindow.Show();
            owner.IsEnabled = false;
            var downloaded = await updateService.DownloadAsync(
                update,
                downloadCancellation.Token,
                progressWindow);
            progressWindow.SetStatus("설치를 시작하고 앱을 다시 실행합니다…");
            progressWindow.DisableCancel();
            updateService.LaunchUpdater(downloaded);
            updaterLaunched = true;
            Shutdown(0);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            // Closing the app cancels a pending check/download without user-facing noise.
        }
        catch (OperationCanceledException) when (userCanceledDownload)
        {
            ShowUpdateMessage(owner, "업데이트를 취소했습니다. 기존 버전으로 계속 실행합니다.");
        }
        catch (UpdateTooOldException error)
        {
            updateService.LogFailure("minimum-sequence", error);
            ShowUpdateMessage(owner, error.Message);
        }
        catch (InvalidDataException error)
        {
            updateService.LogFailure("security", error);
            ShowUpdateMessage(
                owner,
                "업데이트 파일의 서명을 확인할 수 없어 설치하지 않았습니다. 기존 버전은 그대로 실행됩니다.");
        }
        catch (HttpRequestException error)
        {
            updateService.LogFailure("network", error);
            if (userAccepted)
            {
                ShowUpdateMessage(
                    owner,
                    "업데이트를 다운로드하지 못했습니다. 네트워크를 확인한 뒤 다시 시작해 주세요.\n\n"
                    + error.Message);
            }
        }
        catch (TaskCanceledException error)
        {
            updateService.LogFailure("timeout", error);
            if (userAccepted && !userCanceledDownload)
            {
                ShowUpdateMessage(
                    owner,
                    "업데이트 다운로드가 너무 오래 걸려 중단되었습니다. 네트워크를 확인한 뒤 다시 시작해 주세요.");
            }
        }
        catch (Exception error)
        {
            updateService.LogFailure("unexpected", error);
            if (userAccepted)
            {
                ShowUpdateMessage(
                    owner,
                    "업데이트를 적용하지 못했습니다. 기존 버전으로 계속 실행합니다.\n\n"
                    + error.Message);
            }
        }
        finally
        {
            owner.Closed -= CancelOnClose;
            if (progressWindow is not null && !updaterLaunched)
            {
                progressWindow.AllowClose();
                progressWindow.Close();
            }
            if (owner.IsVisible) owner.IsEnabled = true;
        }
    }

    private static void ShowUpdateMessage(Window owner, string message)
    {
        if (owner is MainWindow mainWindow) mainWindow.RestoreFromTray();
        if (owner.IsVisible)
        {
            MessageBox.Show(
                owner,
                message,
                "MY Agent 업데이트",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
            return;
        }
        MessageBox.Show(
            message,
            "MY Agent 업데이트",
            MessageBoxButton.OK,
            MessageBoxImage.Warning);
    }
}
