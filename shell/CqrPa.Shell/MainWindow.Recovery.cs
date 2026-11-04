using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace CqrPa.Shell;

/// <summary>
/// Self-recovery for the workspace screen. WebView2 renderer/browser crashes used to leave a
/// blank window with only a log line. Now the page is reloaded (renderer) or the WebView is
/// rebuilt (browser process), at most <see cref="WebViewRecoveryBudget"/> times per
/// <see cref="WebViewRecoveryWindow"/>; after that the startup overlay explains the problem
/// with a retry button and the secondary "담당자에게 보낼 기록 저장" button.
/// </summary>
public partial class MainWindow
{
    private const int WebViewRecoveryBudget = 2;
    private static readonly TimeSpan WebViewRecoveryWindow = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan UnresponsiveConfirmWindow = TimeSpan.FromSeconds(60);

    private readonly Queue<DateTime> _webViewRecoveries = new();
    private DateTime? _rendererUnresponsiveSince;
    private bool _workspaceNeedsRecreate;
    private bool _startupProblemShown;
    private ShellProblemAction? _startupFix;

    /// <summary>Shows a plain-language problem on the startup overlay instead of a blank page.</summary>
    private void ShowStartupProblem(string title, string cause, string advice, ShellProblemAction? fix = null)
    {
        ShellStartupLog.Write($"problem_shown: {title} | {cause}");
        _startupProblemShown = true;
        StartupOverlay.Visibility = Visibility.Visible;
        HideHwndWorkspaceWebViewForOverlay();
        StartupProgress.Visibility = Visibility.Collapsed;
        StartupTitleText.Text = title;
        StartupStatusText.Text = cause;
        StartupAdviceText.Text = advice;
        StartupAdviceText.Visibility = string.IsNullOrWhiteSpace(advice) ? Visibility.Collapsed : Visibility.Visible;
        StartupRetryButton.Visibility = Visibility.Visible;
        _startupFix = fix;
        StartupFixButton.Content = fix?.Label ?? "";
        StartupFixButton.Visibility = fix is null ? Visibility.Collapsed : Visibility.Visible;
        StartupSaveLogButton.Visibility = Visibility.Visible;
    }

    private void ResetStartupOverlay(string status)
    {
        _startupProblemShown = false;
        _startupFix = null;
        StartupTitleText.Text = "MY Agent를 준비하고 있습니다";
        StartupStatusText.Text = status;
        StartupAdviceText.Visibility = Visibility.Collapsed;
        StartupRetryButton.Visibility = Visibility.Collapsed;
        StartupFixButton.Visibility = Visibility.Collapsed;
        StartupSaveLogButton.Visibility = Visibility.Collapsed;
        StartupProgress.Visibility = Visibility.Visible;
    }

    private void ShowApiStartupProblem(string title)
    {
        var (cause, advice, fix) = _api.DescribeStartupFailure();
        ShowStartupProblem(title, cause, advice, fix);
    }

    private void OnStartupFixClick(object sender, RoutedEventArgs e)
    {
        var fix = _startupFix;
        if (fix is null) return;
        ShellStartupLog.Write($"problem_action: {fix.Label}");
        try { fix.Run(); }
        catch (Exception ex) { ShellStartupLog.WriteException($"problem action failed ({fix.Label})", ex); }
    }

    private void OnStartupSaveLogClick(object sender, RoutedEventArgs e) => CollectDiagnosticsInteractive();

    private bool TryTakeWebViewRecoveryBudget()
    {
        var cutoff = DateTime.UtcNow - WebViewRecoveryWindow;
        while (_webViewRecoveries.Count > 0 && _webViewRecoveries.Peek() < cutoff) _webViewRecoveries.Dequeue();
        if (_webViewRecoveries.Count >= WebViewRecoveryBudget) return false;
        _webViewRecoveries.Enqueue(DateTime.UtcNow);
        return true;
    }

    /// <summary>Decides how to recover from a WebView2 process failure (called on the UI thread).</summary>
    private void RecoverFromWorkspaceProcessFailure(CoreWebView2ProcessFailedKind kind)
    {
        bool recreate;
        switch (kind)
        {
            case CoreWebView2ProcessFailedKind.BrowserProcessExited:
                recreate = true;
                break;
            case CoreWebView2ProcessFailedKind.RenderProcessExited:
                recreate = false;
                break;
            case CoreWebView2ProcessFailedKind.RenderProcessUnresponsive:
                // A busy page can be briefly unresponsive; reload only when it stays so.
                var now = DateTime.UtcNow;
                if (_rendererUnresponsiveSince is not DateTime since || now - since > UnresponsiveConfirmWindow)
                {
                    _rendererUnresponsiveSince = now;
                    ShellStartupLog.Write("webview_recovery: 화면이 응답 없음, 다시 보고되면 새로고침");
                    return;
                }
                _rendererUnresponsiveSince = null;
                recreate = false;
                break;
            default:
                // GPU/utility/plugin processes are restarted by WebView2 itself.
                return;
        }

        if (_workspaceLoading) return;
        if (!TryTakeWebViewRecoveryBudget())
        {
            _workspaceNeedsRecreate |= recreate;
            ShellStartupLog.Write($"webview_recovery: gave up after {WebViewRecoveryBudget} recoveries in {WebViewRecoveryWindow.TotalSeconds:F0}s");
            ShowStartupProblem(
                "화면이 반복해서 꺼집니다",
                "작업 화면을 보여 주는 화면 엔진(WebView2)이 짧은 시간에 여러 번 종료됐습니다.",
                ShellProblems.IsDiskLow(_cqrRoot)
                    ? $"디스크 여유 공간이 부족합니다 (약 {ShellProblems.FreeDiskMb(_cqrRoot)}MB). 공간을 확보한 뒤 다시 시도해 주세요."
                    : "다시 시도해 보고, 반복되면 PC를 다시 시작하거나 담당자에게 기록을 보내 주세요.",
                ShellProblems.IsDiskLow(_cqrRoot) ? ShellProblems.DiskCleanupAction() : null);
            return;
        }

        ShellStartupLog.Write($"webview_recovery: {(recreate ? "화면 엔진 다시 만들기" : "화면 다시 불러오기")} ({kind})");
        if (recreate)
        {
            _ = RecreateAndLoadWorkspaceAsync();
            return;
        }
        try
        {
            WebView.CoreWebView2?.Reload();
        }
        catch (Exception ex)
        {
            ShellStartupLog.WriteException("webview_recovery: reload failed, recreating", ex);
            _ = RecreateAndLoadWorkspaceAsync();
        }
    }

    private async Task RecreateAndLoadWorkspaceAsync()
    {
        try
        {
            RecreateWorkspaceWebView();
            await LoadWorkspaceAsync();
        }
        catch (Exception ex)
        {
            ShellStartupLog.WriteException("webview_recovery: recreate failed", ex);
            _workspaceNeedsRecreate = true;
            ShowStartupProblem(
                "화면을 다시 열지 못했습니다",
                "화면 엔진(WebView2)을 다시 준비하지 못했습니다.",
                "다시 시도해 보고, 반복되면 MY Agent를 껐다가 다시 실행해 주세요.");
        }
    }

    /// <summary>
    /// After the WebView2 browser process exits, the existing control can never navigate again;
    /// replace it with a fresh control of the same host type.
    /// </summary>
    private void RecreateWorkspaceWebView()
    {
        _workspaceNeedsRecreate = false;
        var old = WebViewElement;
        BrowserLayout.Children.Remove(old);
        try { (old as IDisposable)?.Dispose(); }
        catch (Exception ex) { ShellStartupLog.WriteException("webview_recovery: old control dispose failed", ex); }

        if (_workspaceWebViewHwnd)
        {
            var hwnd = new WebView2 { AllowExternalDrop = false, Visibility = Visibility.Hidden };
            AttachWorkspaceWebView(hwnd, hwnd);
        }
        else
        {
            var composition = new WebView2CompositionControl { AllowExternalDrop = false };
            AttachWorkspaceWebView(composition, composition);
        }
    }

    /// <summary>The health monitor restarted a crashed local API.</summary>
    internal void OnApiRestarted()
    {
        if (_workspaceLoading) return;
        if (_startupProblemShown || WebView.CoreWebView2 is null)
        {
            _ = RetryWorkspaceAsync();
            return;
        }
        // Open streams/requests died with the old process; reload to resync with the new one.
        try { WebView.CoreWebView2.Reload(); }
        catch (Exception ex) { ShellStartupLog.WriteException("api_restarted: reload failed", ex); }
    }

    /// <summary>The local API keeps exiting; automatic restart stopped.</summary>
    internal void OnApiGaveUp() => ShowApiStartupProblem("로컬 서비스가 반복해서 꺼집니다");

    private async Task RetryWorkspaceAsync()
    {
        _webViewRecoveries.Clear();
        if (_workspaceNeedsRecreate)
        {
            await RecreateAndLoadWorkspaceAsync();
            return;
        }
        await LoadWorkspaceAsync();
    }
}
