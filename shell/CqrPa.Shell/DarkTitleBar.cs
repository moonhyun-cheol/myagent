using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace CqrPa.Shell;

/// <summary>
/// Match the native DWM frame to the matte light workspace palette.
/// Windows 10 1809+ / Windows 11.
/// </summary>
internal static class DarkTitleBar
{
    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaBorderColor = 34;
    private const int DwmwaCaptionColor = 35;
    private const int DwmwaTextColor = 36;

    // COLORREF = 0x00BBGGRR.
    private const int CaptionColorBgr = 0x00f2f5f4; // #f4f5f2
    private const int BorderColorBgr = 0x00b4b9ad;  // #adb9b4
    private const int TextColorBgr = 0x001d2117;    // #17211d

    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmSetWindowAttribute(
        IntPtr hwnd,
        int attr,
        ref int attrValue,
        int attrSize);

    public static void TryEnable(Window window)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        if (hwnd == IntPtr.Zero) return;

        var dark = 0;
        _ = DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkMode, ref dark, sizeof(int));

        var caption = CaptionColorBgr;
        _ = DwmSetWindowAttribute(hwnd, DwmwaCaptionColor, ref caption, sizeof(int));

        var border = BorderColorBgr;
        _ = DwmSetWindowAttribute(hwnd, DwmwaBorderColor, ref border, sizeof(int));

        var text = TextColorBgr;
        _ = DwmSetWindowAttribute(hwnd, DwmwaTextColor, ref text, sizeof(int));
    }
}
