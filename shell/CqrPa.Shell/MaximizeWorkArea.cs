using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Shell;
using System.Windows.Threading;

namespace CqrPa.Shell;

/// <summary>
/// Borderless (WindowStyle=None + WindowChrome) maximize must fill the monitor
/// <b>work area</b> (screen minus taskbar). True WindowState.Maximized often
/// still covers the taskbar; we convert that into an explicit work-area size.
/// </summary>
internal static class MaximizeWorkArea
{
    private const int WmGetMinMaxInfo = 0x0024;
    private const uint MonitorDefaultToNearest = 2;

    private static Rect? _restoreBounds;
    private static bool _workAreaFilled;
    private static bool _suppressStateHandler;

    [StructLayout(LayoutKind.Sequential)]
    private struct Point32
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MinMaxInfo
    {
        public Point32 Reserved;
        public Point32 MaxSize;
        public Point32 MaxPosition;
        public Point32 MinTrackSize;
        public Point32 MaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect32
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct MonitorInfo
    {
        public int Size;
        public Rect32 Monitor;
        public Rect32 Work;
        public int Flags;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MonitorInfo info);

    public static bool IsWorkAreaFilled => _workAreaFilled;

    public static Rect GetPersistableBounds(Window window)
    {
        if (_workAreaFilled && _restoreBounds is { } restored &&
            restored.Width >= 100 && restored.Height >= 100)
        {
            return restored;
        }

        var bounds = window.RestoreBounds;
        if (bounds.Width >= 100 && bounds.Height >= 100)
            return bounds;

        return new Rect(window.Left, window.Top, window.Width, window.Height);
    }

    public static void Hook(Window window)
    {
        var helper = new WindowInteropHelper(window);
        helper.EnsureHandle();
        var source = HwndSource.FromHwnd(helper.Handle);
        source?.AddHook(WndProc);
    }

    /// <summary>Maximize button / toggle — always snap to work area (never under taskbar).</summary>
    public static void Toggle(Window window)
    {
        if (_workAreaFilled || window.WindowState == WindowState.Maximized)
        {
            Restore(window);
            return;
        }

        FillWorkArea(window);
    }

    public static void FillWorkArea(Window window)
    {
        if (!_workAreaFilled && window.WindowState == WindowState.Normal)
        {
            _restoreBounds = new Rect(window.Left, window.Top, window.Width, window.Height);
        }
        else if (window.WindowState == WindowState.Maximized)
        {
            _restoreBounds = window.RestoreBounds;
        }

        var work = GetWorkAreaDip(window);
        if (work.Width < 100 || work.Height < 100) return;

        _suppressStateHandler = true;
        try
        {
            // Leave Maximized if set — then size explicitly to work area.
            window.WindowState = WindowState.Normal;
            window.Left = work.X;
            window.Top = work.Y;
            window.Width = work.Width;
            window.Height = work.Height;
            _workAreaFilled = true;
        }
        finally
        {
            _suppressStateHandler = false;
        }
    }

    public static void Restore(Window window)
    {
        _suppressStateHandler = true;
        try
        {
            window.WindowState = WindowState.Normal;
            if (_restoreBounds is { } r && r.Width >= 100 && r.Height >= 100)
            {
                window.Left = r.X;
                window.Top = r.Y;
                window.Width = r.Width;
                window.Height = r.Height;
            }
            _workAreaFilled = false;
            _restoreBounds = null;
        }
        finally
        {
            _suppressStateHandler = false;
        }
    }

    /// <summary>
    /// System maximize (Win+Up / drag) still sets Maximized — convert to work-area fill.
    /// </summary>
    public static void OnStateChanged(Window window, FrameworkElement? root, Thickness restoredBorder)
    {
        if (_suppressStateHandler) return;

        if (window.WindowState == WindowState.Maximized)
        {
            // Defer so WPF finishes its maximize layout, then replace with work-area bounds.
            window.Dispatcher.BeginInvoke(
                () =>
                {
                    if (window.WindowState == WindowState.Maximized)
                    {
                        FillWorkArea(window);
                    }
                    ApplyChrome(window, root, restoredBorder);
                },
                DispatcherPriority.ApplicationIdle);
            return;
        }

        if (window.WindowState == WindowState.Minimized) return;

        // User restored / resized away from our fill.
        if (window.WindowState == WindowState.Normal && _workAreaFilled)
        {
            // Keep _workAreaFilled until user moves/resizes noticeably — checked in ApplyChrome callers.
        }

        ApplyChrome(window, root, restoredBorder);
    }

    /// <summary>Call on LocationChanged / SizeChanged while filled to detect user drag-restore.</summary>
    public static void OnUserMovedOrResized(Window window)
    {
        if (!_workAreaFilled || _suppressStateHandler) return;
        if (window.WindowState != WindowState.Normal) return;

        var work = GetWorkAreaDip(window);
        const double tol = 4;
        var stillFilled =
            Math.Abs(window.Left - work.X) <= tol
            && Math.Abs(window.Top - work.Y) <= tol
            && Math.Abs(window.Width - work.Width) <= tol
            && Math.Abs(window.Height - work.Height) <= tol;
        if (!stillFilled) _workAreaFilled = false;
    }

    public static void ApplyChrome(Window window, FrameworkElement? root, Thickness restoredBorder)
    {
        var chrome = WindowChrome.GetWindowChrome(window);
        var filled = _workAreaFilled || window.WindowState == WindowState.Maximized;

        if (filled)
        {
            window.BorderThickness = new Thickness(0);
            if (chrome != null)
            {
                chrome.ResizeBorderThickness = new Thickness(0);
                chrome.GlassFrameThickness = new Thickness(0);
            }
            // Exact work-area size — no fake inset (old inset was only ~7px and still hid under taskbar).
            if (root != null) root.Margin = new Thickness(0);
        }
        else
        {
            window.BorderThickness = restoredBorder;
            if (chrome != null)
            {
                chrome.ResizeBorderThickness = new Thickness(6);
                chrome.GlassFrameThickness = new Thickness(0);
            }
            if (root != null) root.Margin = new Thickness(0);
        }
    }

    private static Rect GetWorkAreaDip(Window window)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        if (hwnd == IntPtr.Zero)
        {
            var wa = SystemParameters.WorkArea;
            return new Rect(wa.Left, wa.Top, wa.Width, wa.Height);
        }

        var monitor = MonitorFromWindow(hwnd, MonitorDefaultToNearest);
        if (monitor == IntPtr.Zero)
        {
            var wa = SystemParameters.WorkArea;
            return new Rect(wa.Left, wa.Top, wa.Width, wa.Height);
        }

        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(monitor, ref info))
        {
            var wa = SystemParameters.WorkArea;
            return new Rect(wa.Left, wa.Top, wa.Width, wa.Height);
        }

        var work = info.Work;
        var source = HwndSource.FromHwnd(hwnd);
        if (source?.CompositionTarget != null)
        {
            var fromDevice = source.CompositionTarget.TransformFromDevice;
            var topLeft = fromDevice.Transform(new System.Windows.Point(work.Left, work.Top));
            var bottomRight = fromDevice.Transform(new System.Windows.Point(work.Right, work.Bottom));
            return new Rect(topLeft, bottomRight);
        }

        return new Rect(work.Left, work.Top, work.Right - work.Left, work.Bottom - work.Top);
    }

    private static IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg != WmGetMinMaxInfo) return IntPtr.Zero;

        var mmi = Marshal.PtrToStructure<MinMaxInfo>(lParam);
        var monitor = MonitorFromWindow(hwnd, MonitorDefaultToNearest);
        if (monitor != IntPtr.Zero)
        {
            var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
            if (GetMonitorInfo(monitor, ref info))
            {
                var work = info.Work;
                var screen = info.Monitor;
                mmi.MaxPosition.X = work.Left - screen.Left;
                mmi.MaxPosition.Y = work.Top - screen.Top;
                mmi.MaxSize.X = Math.Max(0, work.Right - work.Left);
                mmi.MaxSize.Y = Math.Max(0, work.Bottom - work.Top);
                mmi.MaxTrackSize.X = mmi.MaxSize.X;
                mmi.MaxTrackSize.Y = mmi.MaxSize.Y;
                Marshal.StructureToPtr(mmi, lParam, true);
                handled = true;
            }
        }

        return IntPtr.Zero;
    }
}
