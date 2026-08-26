using System.Text.Json;
using System.Windows;
using System.Windows.Threading;

namespace CqrPa.Shell;

/// <summary>
/// Persists the shell's last normal bounds and work-area-filled state.
/// Move/resize events are debounced so dragging a window does not write on every pixel.
/// </summary>
internal sealed class WindowPlacementStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    private static readonly TimeSpan SaveDelay = TimeSpan.FromMilliseconds(400);

    private readonly Window _window;
    private readonly Func<bool> _isWorkAreaFilled;
    private readonly Func<Rect> _getNormalBounds;
    private readonly DispatcherTimer _saveTimer;
    private bool _tracking;

    public WindowPlacementStore(
        Window window,
        Func<bool> isWorkAreaFilled,
        Func<Rect> getNormalBounds)
    {
        _window = window;
        _isWorkAreaFilled = isWorkAreaFilled;
        _getNormalBounds = getNormalBounds;
        _saveTimer = new DispatcherTimer(SaveDelay, DispatcherPriority.Background, OnSaveTimerTick, window.Dispatcher);

        ShouldRestoreWorkAreaFilled = TryRestore();
        _window.Closing += (_, _) =>
        {
            // Do not overwrite a valid placement when startup is interrupted before
            // the window has reached its loaded, trackable state.
            if (_tracking) SaveNow();
        };
    }

    public bool ShouldRestoreWorkAreaFilled { get; }

    public void StartTracking()
    {
        if (_tracking) return;
        _tracking = true;

        _window.LocationChanged += OnPlacementChanged;
        _window.SizeChanged += OnPlacementChanged;
        _window.StateChanged += OnPlacementChanged;
    }

    private static string SettingsPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MY Agent",
        "window-placement.json");

    private bool TryRestore()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return false;

            var state = JsonSerializer.Deserialize<PlacementState>(File.ReadAllText(SettingsPath));
            if (state is null || !IsUsable(state)) return false;

            var bounds = KeepVisible(new Rect(state.Left, state.Top, state.Width, state.Height));
            _window.WindowStartupLocation = WindowStartupLocation.Manual;
            _window.Left = bounds.Left;
            _window.Top = bounds.Top;
            _window.Width = bounds.Width;
            _window.Height = bounds.Height;
            return state.WorkAreaFilled;
        }
        catch
        {
            // A damaged preference file must never prevent the shell from opening.
            return false;
        }
    }

    private void OnPlacementChanged(object? sender, EventArgs e)
    {
        _saveTimer.Stop();
        _saveTimer.Start();
    }

    private void OnSaveTimerTick(object? sender, EventArgs e)
    {
        _saveTimer.Stop();
        SaveNow();
    }

    private void SaveNow()
    {
        _saveTimer.Stop();

        try
        {
            var bounds = _getNormalBounds();
            if (!IsUsable(bounds)) return;

            var state = new PlacementState
            {
                Left = bounds.Left,
                Top = bounds.Top,
                Width = bounds.Width,
                Height = bounds.Height,
                WorkAreaFilled = _isWorkAreaFilled(),
            };

            var path = SettingsPath;
            var directory = Path.GetDirectoryName(path)!;
            Directory.CreateDirectory(directory);

            var temporaryPath = path + ".tmp";
            File.WriteAllText(temporaryPath, JsonSerializer.Serialize(state, JsonOptions));
            File.Move(temporaryPath, path, true);
        }
        catch
        {
            // Window placement is a convenience feature; shutdown must continue if saving fails.
        }
    }

    private static bool IsUsable(PlacementState state) =>
        double.IsFinite(state.Left) && double.IsFinite(state.Top) &&
        double.IsFinite(state.Width) && double.IsFinite(state.Height) &&
        state.Width >= 100 && state.Height >= 100;

    private static bool IsUsable(Rect bounds) =>
        double.IsFinite(bounds.Left) && double.IsFinite(bounds.Top) &&
        double.IsFinite(bounds.Width) && double.IsFinite(bounds.Height) &&
        bounds.Width >= 100 && bounds.Height >= 100;

    private static Rect KeepVisible(Rect bounds)
    {
        var virtualScreen = new Rect(
            SystemParameters.VirtualScreenLeft,
            SystemParameters.VirtualScreenTop,
            SystemParameters.VirtualScreenWidth,
            SystemParameters.VirtualScreenHeight);

        if (virtualScreen.Width <= 0 || virtualScreen.Height <= 0)
            return bounds;

        var width = Math.Min(bounds.Width, virtualScreen.Width);
        var height = Math.Min(bounds.Height, virtualScreen.Height);
        const double visibleMargin = 80;

        var left = Math.Clamp(
            bounds.Left,
            virtualScreen.Left - width + visibleMargin,
            virtualScreen.Right - visibleMargin);
        var top = Math.Clamp(
            bounds.Top,
            virtualScreen.Top,
            virtualScreen.Bottom - visibleMargin);

        return new Rect(left, top, width, height);
    }

    private sealed class PlacementState
    {
        public double Left { get; init; }
        public double Top { get; init; }
        public double Width { get; init; }
        public double Height { get; init; }
        public bool WorkAreaFilled { get; init; }
    }
}
