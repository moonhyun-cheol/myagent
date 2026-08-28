using System.ComponentModel;
using System.Windows;
using System.Windows.Input;

namespace CqrPa.Updater;

public partial class UpdateApplyWindow : Window
{
    private bool _allowClose;

    public UpdateApplyWindow()
    {
        InitializeComponent();
        MouseLeftButtonDown += (_, e) =>
        {
            if (e.ChangedButton == MouseButton.Left) DragMove();
        };
    }

    public void AllowClose() => _allowClose = true;

    public void SetStatus(string status, string? detail = null)
    {
        StatusText.Text = status;
        if (detail is not null) DetailText.Text = detail;
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (!_allowClose) e.Cancel = true;
    }
}
