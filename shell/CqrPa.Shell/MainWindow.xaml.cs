using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media.Imaging;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Application = System.Windows.Application;
using Forms = System.Windows.Forms;
using KeyEventArgs = System.Windows.Input.KeyEventArgs;
using OpenFileDialog = Microsoft.Win32.OpenFileDialog;

namespace CqrPa.Shell;

public partial class MainWindow : Window
{
    private readonly string _cqrRoot;
    private readonly int _port;
    private readonly ApiProcessHost _api;
    private readonly Thickness _restoredBorderThickness = new(1);
    private readonly WindowPlacementStore _windowPlacement;
    private CoreWebView2? _browserCore;
    private Forms.NotifyIcon? _trayIcon;
    private bool _allowExit;
    private bool _minimizeToTrayOnClose = LoadMinimizeToTrayPreference();

    private bool _workspaceLoading;

    internal MainWindow(string cqrRoot, int port, ApiProcessHost api)
    {
        _cqrRoot = cqrRoot;
        _port = port;
        _api = api;
        InitializeComponent();
        _windowPlacement = new WindowPlacementStore(
            this,
            () => MaximizeWorkArea.IsWorkAreaFilled,
            () => MaximizeWorkArea.GetPersistableBounds(this));
        TrySetWindowIcon();
        SourceInitialized += (_, _) =>
        {
            DarkTitleBar.TryEnable(this);
            MaximizeWorkArea.Hook(this);

            // Restore before the first frame is rendered. Deferring this work lets the
            // 1100x780 loading surface flash first and can leave that size on screen.
            if (_windowPlacement.ShouldRestoreWorkAreaFilled)
                MaximizeWorkArea.FillWorkArea(this);
        };
        Loaded += (_, _) => _windowPlacement.StartTracking();
        Loaded += OnLoaded;
        Closing += OnWindowClosing;
        Application.Current.SessionEnding += (_, _) => _allowExit = true;
        LocationChanged += (_, _) => MaximizeWorkArea.OnUserMovedOrResized(this);
        SizeChanged += (_, _) => MaximizeWorkArea.OnUserMovedOrResized(this);
        UpdateMaximizeGlyph();
        MaximizeWorkArea.ApplyChrome(this, RootLayout, _restoredBorderThickness);
    }

    private void TrySetWindowIcon()
    {
        var candidates = new[]
        {
            Path.Combine(_cqrRoot, "ui", "assets", "my-agent-app.ico"),
            Path.Combine(AppContext.BaseDirectory, "my-agent-app.ico"),
        };

        foreach (var iconPath in candidates)
        {
            if (!File.Exists(iconPath)) continue;
            try
            {
                Icon = BitmapFrame.Create(new Uri(iconPath, UriKind.Absolute));
                return;
            }
            catch
            {
                /* optional icon */
            }
        }
    }

    private async Task EnsureBrowserAsync()
    {
        if (_browserCore is not null) return;

        var userData = Path.Combine(_cqrRoot, "data", "in-app-browser-webview-user-data");
        Directory.CreateDirectory(userData);
        var env = await CoreWebView2Environment.CreateAsync(
            browserExecutableFolder: null,
            userDataFolder: userData,
            options: new CoreWebView2EnvironmentOptions());

        await BrowserWebView.EnsureCoreWebView2Async(env);
        _browserCore = BrowserWebView.CoreWebView2;
        _browserCore.Settings.AreDevToolsEnabled = false;
        _browserCore.Settings.AreBrowserAcceleratorKeysEnabled = false;
        _browserCore.Settings.IsStatusBarEnabled = false;
        _browserCore.NavigationStarting += OnBrowserNavigationStarting;
        _browserCore.NavigationCompleted += (_, _) => UpdateBrowserState("탐색 완료");
        _browserCore.HistoryChanged += (_, _) => UpdateBrowserState();
        _browserCore.NewWindowRequested += OnBrowserNewWindowRequested;
        _browserCore.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
        _browserCore.DownloadStarting += (_, e) =>
        {
            e.Cancel = true;
            UpdateBrowserState("다운로드는 인앱 브라우저에서 차단됩니다.");
        };
        BrowserWebView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 0x0c, 0x0e, 0x12);
    }

    private async Task OpenInAppBrowserAsync(string? rawUrl)
    {
        if (!TryNormalizeBrowserUri(rawUrl, out var uri))
        {
            UpdateBrowserState("http 또는 https 주소만 열 수 있습니다.");
            return;
        }

        // OWUI OpenRouter OAuth / login redirects — do not steal focus with a panel.
        if (IsProviderAuthNoiseUri(uri))
        {
            NotifyProviderAuthBlocked(uri);
            return;
        }

        try
        {
            await EnsureBrowserAsync();
            InAppBrowserPanel.Visibility = Visibility.Visible;
            BrowserAddressBox.Text = uri.AbsoluteUri;
            _browserCore!.Navigate(uri.AbsoluteUri);
            UpdateBrowserState("페이지를 여는 중입니다.");
        }
        catch (Exception ex)
        {
            UpdateBrowserState($"브라우저를 열 수 없습니다: {ex.Message}");
        }
    }

    private void CloseInAppBrowser()
    {
        InAppBrowserPanel.Visibility = Visibility.Collapsed;
        PostBrowserState("닫힘");
    }

    private void OnWorkspaceNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (IsWorkspaceUri(e.Uri)) return;
        if (IsProviderAuthNoiseUri(e.Uri))
        {
            e.Cancel = true;
            NotifyProviderAuthBlocked(e.Uri);
            return;
        }
        e.Cancel = true;
        _ = OpenInAppBrowserAsync(e.Uri);
    }

    private void OnWorkspaceNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (IsProviderAuthNoiseUri(e.Uri))
        {
            NotifyProviderAuthBlocked(e.Uri);
            return;
        }
        _ = OpenInAppBrowserAsync(e.Uri);
    }

    private void OnWorkspaceWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var message = JsonDocument.Parse(e.WebMessageAsJson);
            var root = message.RootElement;
            if (!root.TryGetProperty("type", out var typeProperty)) return;
            var type = typeProperty.GetString();
            var url = root.TryGetProperty("url", out var urlProperty) ? urlProperty.GetString() : null;

            switch (type)
            {
                case "inAppBrowser.open":
                case "inAppBrowser.navigate":
                    _ = OpenInAppBrowserAsync(url);
                    break;
                case "inAppBrowser.close":
                    CloseInAppBrowser();
                    break;
                case "inAppBrowser.back":
                    if (_browserCore?.CanGoBack == true) _browserCore.GoBack();
                    break;
                case "inAppBrowser.forward":
                    if (_browserCore?.CanGoForward == true) _browserCore.GoForward();
                    break;
                case "inAppBrowser.reload":
                    _browserCore?.Reload();
                    break;
                case "inAppBrowser.stop":
                    _browserCore?.Stop();
                    break;
                case "inAppBrowser.openExternal":
                    OpenInDefaultBrowser(url ?? _browserCore?.Source);
                    break;
                case "app.closeBehavior.set":
                    var minimizeToTray = root.TryGetProperty("minimizeToTray", out var minimizeProperty)
                        && minimizeProperty.ValueKind is JsonValueKind.True or JsonValueKind.False
                        && minimizeProperty.GetBoolean();
                    SetMinimizeToTrayOnClose(minimizeToTray);
                    break;
                case "filePicker.open":
                    // Let WebView2 finish dispatching the message before entering a modal
                    // Win32 loop. Otherwise the picker can be hidden behind custom chrome or
                    // fail to activate while the WebMessageReceived callback is still active.
                    var pickerRequest = root.Clone();
                    _ = Dispatcher.InvokeAsync(
                        () => OpenWorkspaceFilePicker(pickerRequest),
                        System.Windows.Threading.DispatcherPriority.Background);
                    break;
                case "preview.detach":
                    var previewMode = root.TryGetProperty("mode", out var modeProperty)
                        ? modeProperty.GetString()
                        : "objects";
                    _ = OpenDetachedPreviewAsync(previewMode);
                    break;
            }
        }
        catch (JsonException)
        {
            // Ignore malformed messages from the workspace surface.
        }
    }

    private async Task OpenDetachedPreviewAsync(string? mode)
    {
        var allowedModes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "objects", "canvas", "media", "browser",
        };
        var safeMode = mode is not null && allowedModes.Contains(mode) ? mode : "objects";
        var preview = new Window
        {
            Title = $"MY Agent · {safeMode} 프리뷰",
            Width = 960,
            Height = 720,
            MinWidth = 480,
            MinHeight = 320,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Owner = this,
        };
        var webView = new WebView2();
        preview.Content = webView;
        preview.Show();

        var userData = Path.Combine(_cqrRoot, "data", "webview-user-data");
        Directory.CreateDirectory(userData);
        var env = await CoreWebView2Environment.CreateAsync(userDataFolder: userData);
        await webView.EnsureCoreWebView2Async(env);
        webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
        webView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
        webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
        webView.CoreWebView2.Navigate($"http://127.0.0.1:{_port}/?preview={Uri.EscapeDataString(safeMode)}");
    }

    private void OnBrowserNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (IsAllowedExternalUri(e.Uri))
        {
            BrowserAddressBox.Text = e.Uri;
            UpdateBrowserState("페이지를 여는 중입니다.");
            return;
        }

        e.Cancel = true;
        UpdateBrowserState("http 또는 https 주소만 열 수 있습니다.");
    }

    private void OnBrowserNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (IsProviderAuthNoiseUri(e.Uri))
        {
            NotifyProviderAuthBlocked(e.Uri);
            return;
        }
        _ = OpenInAppBrowserAsync(e.Uri);
    }

    private void OnBrowserBackClick(object sender, RoutedEventArgs e)
    {
        if (_browserCore?.CanGoBack == true) _browserCore.GoBack();
    }

    private void OnBrowserForwardClick(object sender, RoutedEventArgs e)
    {
        if (_browserCore?.CanGoForward == true) _browserCore.GoForward();
    }

    private void OnBrowserReloadClick(object sender, RoutedEventArgs e) => _browserCore?.Reload();

    private async void OnBrowserAddressKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Enter) return;
        e.Handled = true;
        await OpenInAppBrowserAsync(BrowserAddressBox.Text);
    }

    private void OnBrowserOpenExternalClick(object sender, RoutedEventArgs e) =>
        OpenInDefaultBrowser(_browserCore?.Source ?? BrowserAddressBox.Text);

    private void OnBrowserCloseClick(object sender, RoutedEventArgs e) => CloseInAppBrowser();

    private void OpenInDefaultBrowser(string? rawUrl)
    {
        if (!TryNormalizeBrowserUri(rawUrl, out var uri))
        {
            UpdateBrowserState("http 또는 https 주소만 열 수 있습니다.");
            return;
        }

        // Even explicit external open: avoid surprise OpenRouter login chrome during chat.
        if (IsProviderAuthNoiseUri(uri))
        {
            NotifyProviderAuthBlocked(uri);
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            UpdateBrowserState($"기본 브라우저를 열 수 없습니다: {ex.Message}");
        }
    }

    private bool IsWorkspaceUri(string rawUrl) =>
        Uri.TryCreate(rawUrl, UriKind.Absolute, out var uri)
        && uri.Scheme == Uri.UriSchemeHttp
        && uri.Host == "127.0.0.1"
        && uri.Port == _port;

    /// <summary>
    /// OWUI OpenRouter integration often redirects/popups openrouter.ai for OAuth.
    /// That steals focus during chat/coding — block auto open; configure keys in vault/Manager.
    /// </summary>
    private static bool IsProviderAuthNoiseUri(string? rawUrl)
    {
        if (!Uri.TryCreate(rawUrl?.Trim(), UriKind.Absolute, out var uri)) return false;
        return IsProviderAuthNoiseUri(uri);
    }

    private static bool IsProviderAuthNoiseUri(Uri uri)
    {
        var host = uri.Host.ToLowerInvariant();
        return host == "openrouter.ai"
            || host.EndsWith(".openrouter.ai", StringComparison.Ordinal)
            || host == "openrouter.com"
            || host.EndsWith(".openrouter.com", StringComparison.Ordinal);
    }

    private void NotifyProviderAuthBlocked(string? rawUrl)
    {
        if (Uri.TryCreate(rawUrl?.Trim(), UriKind.Absolute, out var uri))
        {
            NotifyProviderAuthBlocked(uri);
            return;
        }
        UpdateBrowserState("OpenRouter 로그인 창은 자동으로 열지 않습니다. Manager/Vault API 키를 확인하세요.");
    }

    private void NotifyProviderAuthBlocked(Uri uri)
    {
        UpdateBrowserState(
            "OpenRouter 로그인 창은 자동으로 열지 않습니다. Manager → Providers/Vault에서 API 키를 설정하세요.");
        if (WebView.CoreWebView2 is null) return;
        var payload = JsonSerializer.Serialize(new
        {
            type = "providerAuth.blocked",
            host = uri.Host,
            url = uri.AbsoluteUri,
            message = "OpenRouter 팝업이 차단되었습니다. Vault/Manager에서 API 키를 설정하세요.",
        });
        WebView.CoreWebView2.PostWebMessageAsJson(payload);
    }

    private static bool IsAllowedExternalUri(string? rawUrl) =>
        Uri.TryCreate(rawUrl, UriKind.Absolute, out var uri)
        && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    private static bool TryNormalizeBrowserUri(string? rawUrl, out Uri uri)
    {
        uri = null!;
        var value = rawUrl?.Trim();
        if (string.IsNullOrWhiteSpace(value)) return false;
        if (!value.Contains("://", StringComparison.Ordinal)) value = $"https://{value}";
        return Uri.TryCreate(value, UriKind.Absolute, out uri)
            && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);
    }

    private void UpdateBrowserState(string? status = null)
    {
        if (status is not null) BrowserStatusText.Text = status;
        PostBrowserState(status ?? BrowserStatusText.Text);
    }

    private void PostBrowserState(string status)
    {
        if (WebView.CoreWebView2 is null) return;
        var state = JsonSerializer.Serialize(new
        {
            type = "inAppBrowser.state",
            visible = InAppBrowserPanel.Visibility == Visibility.Visible,
            url = _browserCore?.Source ?? string.Empty,
            canGoBack = _browserCore?.CanGoBack ?? false,
            canGoForward = _browserCore?.CanGoForward ?? false,
            loading = status == "페이지를 여는 중입니다.",
            status,
        });
        WebView.CoreWebView2.PostWebMessageAsJson(state);
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        await LoadWorkspaceAsync();
    }

    private async Task LoadWorkspaceAsync()
    {
        if (_workspaceLoading) return;
        _workspaceLoading = true;
        StartupOverlay.Visibility = Visibility.Visible;
        StartupRetryButton.Visibility = Visibility.Collapsed;
        StartupProgress.Visibility = Visibility.Visible;
        StartupStatusText.Text = "로컬 서비스를 시작하는 중…";
        try
        {
            if (!await _api.WaitForHealthAsync(_api.RecommendedHealthTimeout))
                throw new InvalidOperationException("로컬 서비스가 제한 시간 안에 준비되지 않았습니다.");

            StartupStatusText.Text = "화면 엔진을 준비하는 중…";
            if (WebView.CoreWebView2 is null)
            {
                var userData = Path.Combine(_cqrRoot, "data", "webview-user-data");
                Directory.CreateDirectory(userData);

                var env = await CoreWebView2Environment.CreateAsync(
                    browserExecutableFolder: null,
                    userDataFolder: userData,
                    options: new CoreWebView2EnvironmentOptions());

                await WebView.EnsureCoreWebView2Async(env);
                var initializedCore = WebView.CoreWebView2
                    ?? throw new InvalidOperationException("WebView2 코어를 만들지 못했습니다.");
                initializedCore.Settings.AreDevToolsEnabled = true;
                initializedCore.Settings.AreBrowserAcceleratorKeysEnabled = false;
                initializedCore.Settings.IsStatusBarEnabled = false;
                initializedCore.WebMessageReceived += OnWorkspaceWebMessageReceived;
                initializedCore.NavigationStarting += OnWorkspaceNavigationStarting;
                initializedCore.NavigationCompleted += OnWorkspaceNavigationCompleted;
                initializedCore.NewWindowRequested += OnWorkspaceNewWindowRequested;
                WebView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 0x0c, 0x0e, 0x12);
                WebView.AllowExternalDrop = true;
            }
            StartupStatusText.Text = "작업 화면을 불러오는 중…";
            var workspaceCore = WebView.CoreWebView2
                ?? throw new InvalidOperationException("WebView2 코어가 준비되지 않았습니다.");
            workspaceCore.Navigate($"http://127.0.0.1:{_port}/");
        }
        catch (Exception ex)
        {
            StartupProgress.Visibility = Visibility.Collapsed;
            StartupRetryButton.Visibility = Visibility.Visible;
            StartupStatusText.Text = $"시작하지 못했습니다. {ex.Message}";
        }
        finally
        {
            _workspaceLoading = false;
        }
    }

    private void OpenWorkspaceFilePicker(JsonElement request)
    {
        var requestId = request.TryGetProperty("requestId", out var requestIdProperty)
            ? requestIdProperty.GetString()
            : null;
        var purpose = request.TryGetProperty("purpose", out var purposeProperty)
            ? purposeProperty.GetString()
            : null;
        if (string.IsNullOrWhiteSpace(requestId)) return;
        if (purpose is not ("skillZip" or "organizationModuleZip")) return;

        var dialog = new OpenFileDialog
        {
            Title = purpose == "organizationModuleZip" ? "설치할 회사 팩 ZIP 선택" : "설치할 스킬 ZIP 선택",
            Filter = "ZIP 압축 파일 (*.zip)|*.zip",
            DefaultExt = ".zip",
            AddExtension = true,
            CheckFileExists = true,
            CheckPathExists = true,
            Multiselect = false,
            DereferenceLinks = true,
        };
        var accepted = dialog.ShowDialog(this) == true;
        var selectedPath = accepted && string.Equals(Path.GetExtension(dialog.FileName), ".zip", StringComparison.OrdinalIgnoreCase)
            ? Path.GetFullPath(dialog.FileName)
            : null;
        var payload = JsonSerializer.Serialize(new
        {
            type = "filePicker.result",
            requestId,
            purpose,
            canceled = selectedPath is null,
            path = selectedPath,
        });
        WebView.CoreWebView2?.PostWebMessageAsJson(payload);
    }

    private void OnWorkspaceNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess)
        {
            StartupOverlay.Visibility = Visibility.Collapsed;
            return;
        }
        StartupProgress.Visibility = Visibility.Collapsed;
        StartupRetryButton.Visibility = Visibility.Visible;
        StartupStatusText.Text = $"작업 화면을 불러오지 못했습니다. ({e.WebErrorStatus})";
    }

    private async void OnStartupRetryClick(object sender, RoutedEventArgs e)
    {
        await LoadWorkspaceAsync();
    }

    private void OnMinimizeClick(object sender, RoutedEventArgs e) =>
        WindowState = WindowState.Minimized;

    private void OnMaximizeClick(object sender, RoutedEventArgs e)
    {
        MaximizeWorkArea.Toggle(this);
        MaximizeWorkArea.ApplyChrome(this, RootLayout, _restoredBorderThickness);
        UpdateMaximizeGlyph();
    }

    private static string TrayPreferencePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MYAgent",
        "shell-settings.json");

    private static bool LoadMinimizeToTrayPreference()
    {
        try
        {
            if (!File.Exists(TrayPreferencePath)) return true;
            using var document = JsonDocument.Parse(File.ReadAllText(TrayPreferencePath));
            return !document.RootElement.TryGetProperty("minimizeToTrayOnClose", out var value)
                || value.ValueKind != JsonValueKind.False;
        }
        catch
        {
            return true;
        }
    }

    private static void SaveMinimizeToTrayPreference(bool enabled)
    {
        try
        {
            var directory = Path.GetDirectoryName(TrayPreferencePath);
            if (!string.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);
            File.WriteAllText(TrayPreferencePath, JsonSerializer.Serialize(new { minimizeToTrayOnClose = enabled }));
        }
        catch
        {
            // The in-memory preference still applies for this run.
        }
    }

    private void SetMinimizeToTrayOnClose(bool enabled)
    {
        _minimizeToTrayOnClose = enabled;
        SaveMinimizeToTrayPreference(enabled);
        if (enabled) EnsureTrayIcon();
        else DisposeTrayIcon();
    }

    private void EnsureTrayIcon()
    {
        if (_trayIcon is not null) return;

        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("MY Agent 열기", null, (_, _) => Dispatcher.Invoke(RestoreFromTray));
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("종료", null, (_, _) => Dispatcher.Invoke(ExitFromTray));

        var icon = !string.IsNullOrWhiteSpace(Environment.ProcessPath)
            ? System.Drawing.Icon.ExtractAssociatedIcon(Environment.ProcessPath)
            : null;
        _trayIcon = new Forms.NotifyIcon
        {
            Text = "MY Agent",
            Icon = icon ?? SystemIcons.Application,
            ContextMenuStrip = menu,
            Visible = true,
        };
        _trayIcon.DoubleClick += (_, _) => Dispatcher.Invoke(RestoreFromTray);
    }

    private void DisposeTrayIcon()
    {
        if (_trayIcon is null) return;
        _trayIcon.Visible = false;
        _trayIcon.ContextMenuStrip?.Dispose();
        _trayIcon.Icon?.Dispose();
        _trayIcon.Dispose();
        _trayIcon = null;
    }

    internal void RestoreFromTray()
    {
        Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
        Topmost = true;
        Topmost = false;
        Focus();
    }

    internal void PrepareForUpdateExit()
    {
        _allowExit = true;
        DisposeTrayIcon();
    }

    private void ExitFromTray()
    {
        _allowExit = true;
        DisposeTrayIcon();
        Close();
    }

    private void OnWindowClosing(object? sender, CancelEventArgs e)
    {
        if (_allowExit || !_minimizeToTrayOnClose)
        {
            DisposeTrayIcon();
            return;
        }

        e.Cancel = true;
        EnsureTrayIcon();
        Hide();
    }

    private void OnCloseClick(object sender, RoutedEventArgs e) => Close();

    private void OnWindowStateChanged(object sender, EventArgs e)
    {
        MaximizeWorkArea.OnStateChanged(this, RootLayout, _restoredBorderThickness);
        UpdateMaximizeGlyph();
    }

    private void UpdateMaximizeGlyph()
    {
        if (MaximizeButton is null) return;
        var maximized = MaximizeWorkArea.IsWorkAreaFilled || WindowState == WindowState.Maximized;
        MaximizeButton.Content = maximized ? "\uE923" : "\uE922";
        MaximizeButton.ToolTip = maximized ? "이전 크기로" : "최대화";
    }
}
