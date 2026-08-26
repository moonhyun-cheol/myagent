using System.Net.Http;
using System.Windows;

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
        void CancelOnClose(object? _, EventArgs __) => cancellation.Cancel();
        owner.Closed += CancelOnClose;
        try
        {
            await Task.Delay(750, cancellation.Token);
            var update = await updateService.CheckAsync(cancellation.Token);
            if (update is null || !owner.IsVisible) return;

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

            owner.IsEnabled = false;
            try
            {
                var downloaded = await updateService.DownloadAsync(update, cancellation.Token);
                updateService.LaunchUpdater(downloaded);
                Shutdown(0);
            }
            finally
            {
                if (owner.IsVisible) owner.IsEnabled = true;
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            // Closing the app cancels a pending check/download without user-facing noise.
        }
        catch (UpdateTooOldException error)
        {
            updateService.LogFailure("minimum-sequence", error);
            if (owner.IsVisible)
            {
                MessageBox.Show(
                    owner,
                    error.Message,
                    "MY Agent 업데이트",
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);
            }
        }
        catch (InvalidDataException error)
        {
            updateService.LogFailure("security", error);
            if (owner.IsVisible)
            {
                MessageBox.Show(
                    owner,
                    "업데이트 파일의 서명을 확인할 수 없어 설치하지 않았습니다. 기존 버전은 그대로 실행됩니다.",
                    "MY Agent 업데이트 보안 확인",
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);
            }
        }
        catch (HttpRequestException error)
        {
            updateService.LogFailure("network", error);
        }
        catch (TaskCanceledException error)
        {
            updateService.LogFailure("timeout", error);
        }
        catch (Exception error)
        {
            updateService.LogFailure("unexpected", error);
            if (owner.IsVisible)
            {
                MessageBox.Show(
                    owner,
                    "업데이트를 적용하지 못했습니다. 기존 버전으로 계속 실행합니다.",
                    "MY Agent 업데이트",
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);
            }
        }
        finally
        {
            owner.Closed -= CancelOnClose;
        }
    }
}
