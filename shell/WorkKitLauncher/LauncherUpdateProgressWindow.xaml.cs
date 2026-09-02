using System.Windows;
using System.Windows.Input;
using Application = System.Windows.Application;

namespace CqrPa.WorkKitLauncher;

public partial class LauncherUpdateProgressWindow : Window, IProgress<LauncherUpdateDownloadProgress>
{
    private bool _allowClose;

    public LauncherUpdateProgressWindow()
    {
        InitializeComponent();
        MouseLeftButtonDown += (_, e) =>
        {
            if (e.ChangedButton == MouseButton.Left) DragMove();
        };
    }

    public event Action? Canceled;

    public void AllowClose() => _allowClose = true;

    public void DisableCancel() => CancelButton.IsEnabled = false;

    public void SetStatus(string status, bool indeterminate = true)
    {
        StatusText.Text = status;
        Bar.IsIndeterminate = indeterminate;
        if (indeterminate)
        {
            Bar.Value = 0;
            DetailText.Text = "";
        }
    }

    public void Report(LauncherUpdateDownloadProgress value)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.Invoke(() => Report(value));
            return;
        }

        StatusText.Text = value.Phase;
        if (value.TotalBytes <= 0)
        {
            Bar.IsIndeterminate = true;
            DetailText.Text = value.ReceivedBytes > 0 ? FormatBytes(value.ReceivedBytes) : "";
            return;
        }

        Bar.IsIndeterminate = false;
        var percent = Math.Clamp(100.0 * value.ReceivedBytes / value.TotalBytes, 0, 100);
        Bar.Value = percent;
        DetailText.Text = $"{FormatBytes(value.ReceivedBytes)} / {FormatBytes(value.TotalBytes)}  ({percent:0}%)";
    }

    private void OnCancelClick(object sender, RoutedEventArgs e)
    {
        CancelButton.IsEnabled = false;
        StatusText.Text = "업데이트를 취소하는 중…";
        Canceled?.Invoke();
    }

    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_allowClose) return;
        e.Cancel = true;
        Canceled?.Invoke();
    }

    private static string FormatBytes(long bytes)
    {
        if (bytes < 1024) return $"{bytes} B";
        if (bytes < 1024 * 1024) return $"{bytes / 1024.0:0.0} KB";
        return $"{bytes / (1024.0 * 1024.0):0.0} MB";
    }
}
