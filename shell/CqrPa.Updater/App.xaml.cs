using System.Windows;

namespace CqrPa.Updater;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        if (e.Args.Contains("--verify-only", StringComparer.OrdinalIgnoreCase))
        {
            Shutdown(new UpdateRunner().Run(e.Args));
            return;
        }

        var window = new UpdateApplyWindow();
        MainWindow = window;
        window.Show();

        _ = RunUpdateAsync(window, e.Args);
    }

    private async Task RunUpdateAsync(UpdateApplyWindow window, string[] args)
    {
        var runner = new UpdateRunner();
        var exitCode = await Task.Run(() => runner.Run(args, (status, detail) =>
        {
            window.Dispatcher.Invoke(() => window.SetStatus(status, detail));
        }));

        if (exitCode == 0)
        {
            window.SetStatus("업데이트가 완료되었습니다.", "MY Agent가 다시 시작되었습니다.");
            await Task.Delay(800);
            window.AllowClose();
            window.Close();
            Shutdown(0);
            return;
        }

        window.SetStatus("업데이트에 실패했습니다.", runner.LastFailureDetail);
        window.AllowClose();
        MessageBox.Show(
            window,
            "업데이트를 적용하지 못했습니다.\n\n" + runner.LastFailureDetail,
            "MY Agent 업데이트",
            MessageBoxButton.OK,
            MessageBoxImage.Warning);
        Shutdown(1);
    }
}
