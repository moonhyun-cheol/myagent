using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using Button = System.Windows.Controls.Button;
using HorizontalAlignment = System.Windows.HorizontalAlignment;
using MessageBox = System.Windows.MessageBox;
using Orientation = System.Windows.Controls.Orientation;

namespace CqrPa.Shell;

/// <summary>One user-facing action offered next to a problem ("디스크 정리 열기" 등).</summary>
internal sealed record ShellProblemAction(string Label, Action Run);

/// <summary>
/// User-facing failure explanation: a plain-language cause, what to do next, and at most one
/// fix button. The diagnostics ZIP is only a secondary "담당자에게 보낼 기록 저장" button.
/// Every shown problem is also written to the shell log (<c>problem_shown</c>).
/// </summary>
internal static class ShellProblems
{
    private const long LowDiskBytes = 300L * 1024 * 1024;

    /// <summary>Public download page for MY Agent installers (GitHub Releases).</summary>
    public const string ReleasesUrl = "https://github.com/moonhyun-cheol/myagent/releases/latest";

    public static void ShowDialog(
        Window? owner,
        string? root,
        string title,
        string cause,
        string advice,
        ShellProblemAction? fix = null)
    {
        ShellStartupLog.Write($"problem_shown: {title} | {cause}");
        try
        {
            ShowDialogCore(owner, root, title, cause, advice, fix);
        }
        catch (Exception ex)
        {
            ShellStartupLog.WriteException("problem dialog failed", ex);
            try
            {
                MessageBox.Show($"{title}\n\n{cause}\n\n{advice}", "MY Agent", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
            catch
            {
                // Nothing else can be shown.
            }
        }
    }

    private static void ShowDialogCore(
        Window? owner,
        string? root,
        string title,
        string cause,
        string advice,
        ShellProblemAction? fix)
    {
        var window = new Window
        {
            Title = "MY Agent",
            Width = 460,
            SizeToContent = SizeToContent.Height,
            ResizeMode = ResizeMode.NoResize,
            ShowInTaskbar = owner is null,
            WindowStartupLocation = owner is null ? WindowStartupLocation.CenterScreen : WindowStartupLocation.CenterOwner,
        };
        if (owner is not null && owner.IsLoaded) window.Owner = owner;

        var panel = new StackPanel { Margin = new Thickness(24, 20, 24, 18) };
        panel.Children.Add(new TextBlock
        {
            Text = title,
            FontSize = 16,
            FontWeight = FontWeights.SemiBold,
            TextWrapping = TextWrapping.Wrap,
        });
        panel.Children.Add(new TextBlock
        {
            Text = cause,
            Margin = new Thickness(0, 10, 0, 0),
            TextWrapping = TextWrapping.Wrap,
        });
        if (!string.IsNullOrWhiteSpace(advice))
        {
            panel.Children.Add(new TextBlock
            {
                Text = advice,
                Margin = new Thickness(0, 8, 0, 0),
                Opacity = 0.75,
                TextWrapping = TextWrapping.Wrap,
            });
        }

        var buttons = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 20, 0, 0),
        };
        var saveLog = new Button { Content = "담당자에게 보낼 기록 저장", Padding = new Thickness(10, 4, 10, 4) };
        saveLog.Click += (_, _) =>
        {
            var message = ShellDiagnosticsBundle.CreateAndReveal(root);
            MessageBox.Show(window, message, "MY Agent", MessageBoxButton.OK, MessageBoxImage.Information);
        };
        buttons.Children.Add(saveLog);
        if (fix is not null)
        {
            var fixButton = new Button
            {
                Content = fix.Label,
                Margin = new Thickness(8, 0, 0, 0),
                Padding = new Thickness(14, 4, 14, 4),
                IsDefault = true,
            };
            fixButton.Click += (_, _) =>
            {
                ShellStartupLog.Write($"problem_action: {fix.Label}");
                try { fix.Run(); }
                catch (Exception ex) { ShellStartupLog.WriteException($"problem action failed ({fix.Label})", ex); }
                window.Close();
            };
            buttons.Children.Add(fixButton);
        }
        var close = new Button
        {
            Content = "닫기",
            Margin = new Thickness(8, 0, 0, 0),
            Padding = new Thickness(14, 4, 14, 4),
            IsCancel = true,
            IsDefault = fix is null,
        };
        close.Click += (_, _) => window.Close();
        buttons.Children.Add(close);
        panel.Children.Add(buttons);

        window.Content = panel;
        window.ShowDialog();
    }

    /// <summary>Free space under the install root in MB, or null when unknown.</summary>
    public static long? FreeDiskMb(string? root)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(root)) return null;
            var drive = Path.GetPathRoot(Path.GetFullPath(root));
            if (string.IsNullOrWhiteSpace(drive)) return null;
            return new DriveInfo(drive).AvailableFreeSpace / (1024 * 1024);
        }
        catch
        {
            return null;
        }
    }

    public static bool IsDiskLow(string? root) =>
        FreeDiskMb(root) is long mb && mb * 1024 * 1024 < LowDiskBytes;

    public static ShellProblemAction DiskCleanupAction() =>
        new("디스크 정리 열기", () => Process.Start(new ProcessStartInfo("cleanmgr.exe") { UseShellExecute = true }));

    /// <summary>Opens the installer download page in the default browser.</summary>
    public static ShellProblemAction ReinstallAction() =>
        new("설치 파일 받기", () => Process.Start(new ProcessStartInfo(ReleasesUrl) { UseShellExecute = true }));

    /// <summary>The core updater is replacing files; another instance must not be killed meanwhile.</summary>
    public static bool IsUpdaterRunning()
    {
        try
        {
            var processes = Process.GetProcessesByName("MYAgent.Updater");
            var running = processes.Length > 0;
            foreach (var p in processes) p.Dispose();
            return running;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Top-level windows of another process (hidden tray/dispatcher windows count too).</summary>
    public readonly record struct ProcessWindows(int Count, bool AnyHung);

    public static ProcessWindows DescribeWindows(int pid)
    {
        var windows = 0;
        var hung = false;
        try
        {
            EnumWindows((hwnd, _) =>
            {
                GetWindowThreadProcessId(hwnd, out var owner);
                if (owner == (uint)pid)
                {
                    windows++;
                    if (IsWindowVisible(hwnd) && IsHungAppWindow(hwnd)) hung = true;
                }
                return true;
            }, IntPtr.Zero);
        }
        catch
        {
            // Unknown window state: report "has windows" so callers stay conservative.
            return new ProcessWindows(1, false);
        }
        return new ProcessWindows(windows, hung);
    }

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool IsHungAppWindow(IntPtr hwnd);
}
