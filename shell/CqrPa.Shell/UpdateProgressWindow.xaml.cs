using System.Windows;
using System.Windows.Input;

namespace CqrPa.Shell;

public partial class UpdateProgressWindow : Window, IProgress<UpdateDownloadProgress>
{
    private bool _allowClose;

    public UpdateProgressWindow()
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

    public void Report(UpdateDownloadProgress value)
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
        // Keep the download window alive while work is in progress. Closing it
        // cancels the download instead of tearing the app down. App.xaml.cs calls
        // AllowClose() only after the user accepted an update and the updater is launched.
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
