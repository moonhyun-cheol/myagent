using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace CqrPa.Shell;

/// <summary>
/// Match the native DWM frame to the resolved workspace palette.
/// Windows 10 1809+ / Windows 11.
/// </summary>
internal static class DarkTitleBar
{
    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaBorderColor = 34;
    private const int DwmwaCaptionColor = 35;
    private const int DwmwaTextColor = 36;


    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmSetWindowAttribute(
        IntPtr hwnd,
        int attr,
        ref int attrValue,
        int attrSize);

    public static void TryApply(Window window, bool dark)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        if (hwnd == IntPtr.Zero) return;

        try
        {
            var immersiveDark = dark ? 1 : 0;
            _ = DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkMode, ref immersiveDark, sizeof(int));

            // COLORREF = 0x00BBGGRR.
            var caption = dark ? 0x0024201d : 0x00f2f5f4; // #1d2024 / #f4f5f2
            _ = DwmSetWindowAttribute(hwnd, DwmwaCaptionColor, ref caption, sizeof(int));

            var border = dark ? 0x00524c48 : 0x00b4b9ad; // #484c52 / #adb9b4
            _ = DwmSetWindowAttribute(hwnd, DwmwaBorderColor, ref border, sizeof(int));

            var text = dark ? 0x00f3efec : 0x001d2117; // #eceff3 / #17211d
            _ = DwmSetWindowAttribute(hwnd, DwmwaTextColor, ref text, sizeof(int));
        }
        catch (DllNotFoundException)
        {
            // Older Windows builds can render the WPF chrome without DWM attributes.
        }
    }
}
