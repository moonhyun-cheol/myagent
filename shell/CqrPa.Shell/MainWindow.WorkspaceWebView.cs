using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Wpf;

namespace CqrPa.Shell;

/// <summary>
/// Workspace WebView host selection. WebView2CompositionControl renders through a D3D11
/// device; on machines/sessions where that device cannot be created the control throws
/// from its own Loaded handler and the process dies before any window appears. We probe
/// D3D11 up front and, if it fails (or the control still throws at Loaded), fall back to the
/// HWND-based WebView2. The HWND fallback cannot be overlapped by WPF elements (airspace),
/// so it stays hidden while the startup overlay is shown.
/// </summary>
public partial class MainWindow
{
    private IWebView2 WebView = null!;
    private FrameworkElement WebViewElement = null!;
    private bool _workspaceWebViewHwnd;

    private void InitializeWorkspaceWebView()
    {
        var mode = Environment.GetEnvironmentVariable("MY_AGENT_WEBVIEW_MODE");
        if (string.Equals(mode, "hwnd", StringComparison.OrdinalIgnoreCase))
        {
            UseHwndWorkspaceWebView("env");
            return;
        }
        if (!Direct3DProbe.CanCreateDevice())
        {
            UseHwndWorkspaceWebView("d3d11-probe");
            return;
        }
        var composition = new WebView2CompositionControl { AllowExternalDrop = false };
        AttachWorkspaceWebView(composition, composition);
        Dispatcher.UnhandledException += OnWorkspaceCompositionFailure;
    }

    private void AttachWorkspaceWebView(IWebView2 view, FrameworkElement element)
    {
        WebView = view;
        WebViewElement = element;
        BrowserLayout.Children.Insert(0, element);
    }

    private void UseHwndWorkspaceWebView(string reason)
    {
        Trace.WriteLine($"[MY Agent] workspace WebView: HWND fallback ({reason})");
        _workspaceWebViewHwnd = true;
        var hwnd = new WebView2 { AllowExternalDrop = false, Visibility = Visibility.Hidden };
        AttachWorkspaceWebView(hwnd, hwnd);
    }

    private void HideHwndWorkspaceWebViewForOverlay()
    {
        if (_workspaceWebViewHwnd) WebViewElement.Visibility = Visibility.Hidden;
    }

    private void OnWorkspaceCompositionFailure(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        if (_workspaceWebViewHwnd || e.Exception is not COMException) return;
        if (e.Exception.StackTrace?.Contains("Direct3DHelper", StringComparison.Ordinal) != true) return;
        if (WebView.CoreWebView2 is not null) return;
        e.Handled = true;
        Dispatcher.UnhandledException -= OnWorkspaceCompositionFailure;
        var failed = WebViewElement;
        BrowserLayout.Children.Remove(failed);
        try
        {
            (failed as IDisposable)?.Dispose();
        }
        catch
        {
            /* best effort: the control never finished initializing */
        }
        UseHwndWorkspaceWebView("d3d11-runtime");
    }

    private static class Direct3DProbe
    {
        private const int D3D_DRIVER_TYPE_HARDWARE = 1;
        private const uint D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20;
        private const uint D3D11_SDK_VERSION = 7;

        [DllImport("d3d11.dll", ExactSpelling = true)]
        private static extern int D3D11CreateDevice(
            IntPtr adapter,
            int driverType,
            IntPtr software,
            uint flags,
            IntPtr featureLevels,
            uint featureLevelCount,
            uint sdkVersion,
            out IntPtr device,
            out int featureLevel,
            out IntPtr immediateContext);

        public static bool CanCreateDevice()
        {
            try
            {
                var hr = D3D11CreateDevice(
                    IntPtr.Zero,
                    D3D_DRIVER_TYPE_HARDWARE,
                    IntPtr.Zero,
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    IntPtr.Zero,
                    0,
                    D3D11_SDK_VERSION,
                    out var device,
                    out _,
                    out var context);
                if (context != IntPtr.Zero) Marshal.Release(context);
                if (device != IntPtr.Zero) Marshal.Release(device);
                return hr >= 0;
            }
            catch
            {
                return false;
            }
        }
    }
}
