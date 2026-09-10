using System.Linq;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Microsoft.Web.WebView2.Core;
using KeyEventArgs = System.Windows.Input.KeyEventArgs;
using Microsoft.Web.WebView2.Wpf;

namespace CqrPa.Shell;

public partial class MainWindow
{
    /// <summary>Tab id used when a caller does not target a specific tab (single-tab compatibility).</summary>
    private const string DefaultBrowserTab = "main";
    private const int MaxBrowserTabs = 12;

    /// <summary>
    /// One user-visible browser tab. The primary tab reuses the XAML-declared
    /// <c>BrowserWebView</c>/<c>InAppBrowserPanel</c> so the single-tab render path is unchanged;
    /// additional tabs create their own controls inside the shared canvas.
    /// </summary>
    private sealed class BrowserTab
    {
        public BrowserTab(string id, WebView2 view, Border panel, bool isPrimary)
        {
            Id = id;
            View = view;
            Panel = panel;
            IsPrimary = isPrimary;
        }

        public string Id { get; }
        public WebView2 View { get; }
        public Border Panel { get; }
        public bool IsPrimary { get; }
        public CoreWebView2? Core { get; set; }
        public Task? Initialization { get; set; }
        public int OpenVersion;
        public ulong NavigationId;
        public bool Loading;
        public bool Requested;
        public bool NeedsReload;
        public string Url = string.Empty;
        public string Status = string.Empty;
        public string Title = "현재 인앱 웹 페이지";
        public string? AutomationOwner;
        public bool ControlTakenOver;

        // Per-tab automation snapshot state (accessibility refs are only valid for their own tab).
        public string? SnapshotId;
        public ulong SnapshotNavigationId;
        public Dictionary<string, long> Refs = new(StringComparer.Ordinal);
    }

    /// <summary>Register the primary tab lazily, reusing the existing XAML controls.</summary>
    private BrowserTab EnsurePrimaryTab()
    {
        if (_browserTabs.TryGetValue(DefaultBrowserTab, out var existing)) return existing;
        var tab = new BrowserTab(DefaultBrowserTab, BrowserWebView, InAppBrowserPanel, isPrimary: true);
        _browserTabs[DefaultBrowserTab] = tab;
        return tab;
    }

    /// <summary>The active tab, creating the primary tab entry on demand.</summary>
    private BrowserTab ActiveTab =>
        _browserTabs.TryGetValue(_activeBrowserTabId, out var tab) ? tab : EnsurePrimaryTab();

    /// <summary>Non-mutating lookup for read-only queries (does not register the primary tab).</summary>
    private BrowserTab? PeekActiveTab() =>
        _browserTabs.TryGetValue(_activeBrowserTabId, out var tab) ? tab : null;

    private string? _browserReturnTabId;

    private BrowserTab? TabForCore(object? sender) =>
        sender is CoreWebView2 core ? _browserTabs.Values.FirstOrDefault(t => t.Core == core) : null;

    private static string? WorkspaceTabId(JsonElement message) =>
        message.TryGetProperty("tabId", out var property) && property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;

    /// <summary>Resolve a tab by id; a missing/blank id resolves to the active tab (or primary).</summary>
    private BrowserTab ResolveTab(string? tabId, bool createIfMissing = false)
    {
        var key = (tabId ?? string.Empty).Trim();
        if (key.Length == 0) return ActiveTab;
        if (_browserTabs.TryGetValue(key, out var tab)) return tab;
        if (key == DefaultBrowserTab) return EnsurePrimaryTab();
        if (createIfMissing) return CreateTab(key);
        throw new InvalidOperationException("VISIBLE_BROWSER_TAB_NOT_FOUND");
    }

    private BrowserTab CreateTab(string? requestedId)
    {
        EnsurePrimaryTab();
        if (_browserTabs.Count >= MaxBrowserTabs)
            throw new InvalidOperationException("VISIBLE_BROWSER_TAB_LIMIT");

        var id = NormalizeNewTabId(requestedId);
        var view = new WebView2();
        var panel = new Border
        {
            Visibility = Visibility.Collapsed,
            Background = InAppBrowserPanel.Background,
        };
        panel.Child = view;
        BrowserTabCanvas.Children.Add(panel);
        var tab = new BrowserTab(id, view, panel, isPrimary: false);
        _browserTabs[id] = tab;
        return tab;
    }

    private string NormalizeNewTabId(string? requestedId)
    {
        var key = (requestedId ?? string.Empty).Trim();
        if (key.Length > 0 && key != DefaultBrowserTab && !_browserTabs.ContainsKey(key)) return key;
        string candidate;
        do { candidate = $"tab-{++_browserTabSequence}"; } while (_browserTabs.ContainsKey(candidate));
        return candidate;
    }

    private async Task PromoteBrowserTabAsync(string? url)
    {
        if (!TryNormalizeBrowserUri(url, out var uri))
        {
            UpdateBrowserState("http 또는 https 주소만 열 수 있습니다.");
            return;
        }
        try
        {
            var tab = CreateTab(null);
            await OpenInAppBrowserOnTabAsync(tab, uri.AbsoluteUri, activate: true);
        }
        catch (Exception ex)
        {
            UpdateBrowserState($"탭으로 열 수 없습니다: {ex.Message}");
        }
    }

    private void CloseTab(string? tabId)
    {
        var key = (tabId ?? string.Empty).Trim();
        if (key.Length == 0) key = _activeBrowserTabId;
        if (!_browserTabs.TryGetValue(key, out var tab))
            throw new InvalidOperationException("VISIBLE_BROWSER_TAB_NOT_FOUND");
        if (tab.AutomationOwner is not null)
            throw new InvalidOperationException("VISIBLE_BROWSER_TAB_CONTROLLED");

        if (tab.IsPrimary)
        {
            // The primary tab keeps its XAML controls; closing just hides it like the workspace close.
            _activeBrowserTabId = DefaultBrowserTab;
            CloseInAppBrowser();
            return;
        }

        ++tab.OpenVersion;
        tab.Requested = false;
        tab.Core?.Stop();
        BrowserTabCanvas.Children.Remove(tab.Panel);
        tab.View.Dispose();
        _browserTabs.Remove(key);
        if (_activeBrowserTabId == key) _activeBrowserTabId = DefaultBrowserTab;
        ApplyBrowserSurface();
        UpdateBrowserState();
    }

    private void ActivateTab(string? tabId, bool userInitiated = false)
    {
        var tab = ResolveTab(tabId);
        if (userInitiated)
        {
            if (tab.Id != _activeBrowserTabId && tab.AutomationOwner is not null)
                _browserReturnTabId = _activeBrowserTabId;
            else if (tab.AutomationOwner is null)
                _browserReturnTabId = null;
        }
        _activeBrowserTabId = tab.Id;
        ApplyBrowserSurface();
        UpdateBrowserState();
    }

    private void AcquireAutomationControl(string? tabId, string? owner)
    {
        // A lock may reserve a dedicated agent tab before its first navigation.
        var tab = ResolveTab(tabId, createIfMissing: true);
        tab.AutomationOwner = string.IsNullOrWhiteSpace(owner) ? "agent" : owner;
        tab.ControlTakenOver = false;
        UpdateBrowserState();
    }

    private void ReleaseAutomationControl(string? tabId, string? owner)
    {
        var tab = ResolveTab(tabId);
        if (tab.AutomationOwner is not null
            && (string.IsNullOrWhiteSpace(owner) || tab.AutomationOwner == owner))
            tab.AutomationOwner = null;
        UpdateBrowserState();
    }

    private void TakeOverBrowserTab(string? tabId)
    {
        var tab = ResolveTab(tabId);
        tab.AutomationOwner = null;
        tab.ControlTakenOver = true;
        tab.Core?.Stop();
        tab.Loading = false;
        UpdateTabState(tab, "제어권을 가져왔습니다. 에이전트 자동화가 중단되었습니다.");
    }

    private void ReturnFromObservedBrowserTab()
    {
        var returnId = _browserReturnTabId;
        _browserReturnTabId = null;
        if (!string.IsNullOrWhiteSpace(returnId) && _browserTabs.ContainsKey(returnId))
            ActivateTab(returnId);
        else
            UpdateBrowserState();
    }

    private object[] BrowserTabSummaries()
    {
        var summaries = new List<object>(_browserTabs.Count);
        foreach (var tab in _browserTabs.Values)
        {
            summaries.Add(new
            {
                id = tab.Id,
                url = tab.Core?.Source ?? tab.Url,
                title = tab.Title,
                active = tab.Id == _activeBrowserTabId,
                loading = tab.Loading,
                primary = tab.IsPrimary,
                controlled = tab.AutomationOwner is not null,
                observing = tab.Id == _activeBrowserTabId && tab.AutomationOwner is not null
                    && !string.IsNullOrWhiteSpace(_browserReturnTabId),
            });
        }
        return summaries.ToArray();
    }

    private async Task<CoreWebView2Environment> EnsureBrowserEnvironmentAsync()
    {
        if (_browserEnv is not null) return _browserEnv;
        var userData = System.IO.Path.Combine(_cqrRoot, "data", "in-app-browser-webview-user-data");
        System.IO.Directory.CreateDirectory(userData);
        // A single environment is shared by every tab so they may reuse one user-data folder.
        _browserEnv = await CoreWebView2Environment.CreateAsync(
            browserExecutableFolder: null,
            userDataFolder: userData,
            options: new CoreWebView2EnvironmentOptions());
        return _browserEnv;
    }

    private async Task EnsureBrowserAsync(BrowserTab tab)
    {
        if (tab.Core is not null) return;
        try
        {
            await (tab.Initialization ??= InitializeBrowserAsync(tab));
        }
        catch
        {
            tab.Initialization = null;
            throw;
        }
    }

    private async Task InitializeBrowserAsync(BrowserTab tab)
    {
        var env = await EnsureBrowserEnvironmentAsync();
        await tab.View.EnsureCoreWebView2Async(env);
        var core = tab.View.CoreWebView2 ?? throw new InvalidOperationException("VISIBLE_BROWSER_CORE_FAILED");
        tab.Core = core;
        core.Settings.AreDevToolsEnabled = true;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.NavigationStarting += OnBrowserNavigationStarting;
        core.NavigationCompleted += OnBrowserNavigationCompleted;
        core.HistoryChanged += OnBrowserHistoryChanged;
        core.DocumentTitleChanged += OnBrowserDocumentTitleChanged;
        core.NewWindowRequested += OnBrowserNewWindowRequested;
        core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
        core.DownloadStarting += (s, e) =>
        {
            e.Cancel = true;
            var owner = TabForCore(s);
            if (owner is not null) UpdateTabState(owner, "다운로드는 인앱 브라우저에서 차단됩니다.");
        };
        tab.View.PreviewKeyDown += OnBrowserPreviewKeyDown;
        tab.View.DefaultBackgroundColor = WorkspaceBackgroundColor();
    }

    private void OnBrowserPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.F12 || sender is not WebView2 view) return;
        var tab = _browserTabs.Values.FirstOrDefault(candidate => candidate.View == view);
        if (tab is null) return;
        e.Handled = true;
        OpenBrowserDevTools(tab.Id);
    }

    private void OpenBrowserDevTools(string? tabId)
    {
        var tab = ResolveTab(tabId);
        if (tab.AutomationOwner is not null)
        {
            UpdateTabState(tab, "제어권을 가져온 뒤 개발자 도구를 열 수 있습니다.");
            return;
        }
        if (tab.Core is null)
        {
            UpdateTabState(tab, "페이지를 연 뒤 개발자 도구를 사용할 수 있습니다.");
            return;
        }
        tab.Core.OpenDevToolsWindow();
        UpdateTabState(tab, "개발자 도구를 열었습니다.");
    }

    private Task OpenInAppBrowserAsync(string? rawUrl, bool activate = true) =>
        OpenInAppBrowserOnTabAsync(ActiveTab, rawUrl, activate);

    private async Task OpenInAppBrowserOnTabAsync(BrowserTab tab, string? rawUrl, bool activate)
    {
        if (!TryNormalizeBrowserUri(rawUrl, out var uri))
        {
            UpdateTabState(tab, "http 또는 https 주소만 열 수 있습니다.");
            return;
        }

        // OWUI OpenRouter OAuth / login redirects — do not steal focus with a panel.
        if (IsProviderAuthNoiseUri(uri))
        {
            NotifyProviderAuthBlocked(uri);
            return;
        }

        var openVersion = ++tab.OpenVersion;
        tab.Requested = true;
        tab.NeedsReload = false;
        tab.Url = uri.AbsoluteUri;
        if (activate)
        {
            _activeBrowserTabId = tab.Id;
            WebView.CoreWebView2?.PostWebMessageAsJson(
                JsonSerializer.Serialize(new { type = "inAppBrowser.activate", url = uri.AbsoluteUri }));
        }
        try
        {
            await EnsureBrowserAsync(tab);
            // A close or a newer open while initializing wins over this request.
            if (openVersion != tab.OpenVersion) return;
            ApplyBrowserSurface();
            tab.NavigationId = 0; // Ignore the old completion even before the new Starting event.
            tab.Loading = true;
            UpdateTabState(tab, "페이지를 여는 중입니다.");
            tab.Core!.Navigate(uri.AbsoluteUri);
        }
        catch (Exception ex)
        {
            if (openVersion != tab.OpenVersion) return;
            tab.Loading = false;
            UpdateTabState(tab, $"브라우저를 열 수 없습니다: {ex.Message}");
        }
    }

    private void SetBrowserSurface(JsonElement message)
    {
        static double Number(JsonElement root, string name) => root.TryGetProperty(name, out var value)
            && value.TryGetDouble(out var number) && double.IsFinite(number) ? number : 0;
        var vw = Number(message, "viewportWidth");
        var vh = Number(message, "viewportHeight");
        _browserSurfaceAvailable = message.TryGetProperty("visible", out var visible)
            && visible.ValueKind == JsonValueKind.True && vw > 0 && vh > 0;
        if (_browserSurfaceAvailable)
        {
            // Normalize CSS coordinates, not devicePixelRatio (which also includes Windows DPI).
            var x = Math.Clamp(Number(message, "x") / vw, 0, 1);
            var y = Math.Clamp(Number(message, "y") / vh, 0, 1);
            var w = Math.Clamp(Number(message, "width") / vw, 0, 1 - x);
            var h = Math.Clamp(Number(message, "height") / vh, 0, 1 - y);
            _browserSurface = new Rect(x, y, w, h);
            _browserSurfaceAvailable = w > 0 && h > 0;
        }
        ApplyBrowserSurface();
        UpdateBrowserState();
    }

    /// <summary>Position the active tab in the reserved DOM slot; every other tab stays hidden.</summary>
    private void ApplyBrowserSurface()
    {
        foreach (var tab in _browserTabs.Values)
        {
            var isActive = tab.Id == _activeBrowserTabId;
            var visible = isActive && tab.Requested && _browserSurfaceAvailable && tab.Core is not null;
            if (visible)
            {
                Canvas.SetLeft(tab.Panel, _browserSurface.X * BrowserLayout.ActualWidth);
                Canvas.SetTop(tab.Panel, _browserSurface.Y * BrowserLayout.ActualHeight);
                tab.Panel.Width = _browserSurface.Width * BrowserLayout.ActualWidth;
                tab.Panel.Height = _browserSurface.Height * BrowserLayout.ActualHeight;
            }
            tab.Panel.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        }
        BrowserLayout.UpdateLayout();
    }

    private void OnBrowserLayoutSizeChanged(object sender, SizeChangedEventArgs e) => ApplyBrowserSurface();

    private void ResumeInAppBrowser(string? url)
    {
        var tab = ActiveTab;
        if (tab.Core is null && tab.Initialization is null) { _ = OpenInAppBrowserOnTabAsync(tab, url, false); return; }
        if (tab.NeedsReload || (TryNormalizeBrowserUri(url, out var requestedUri)
            && requestedUri.AbsoluteUri != tab.Url)) { _ = OpenInAppBrowserOnTabAsync(tab, url, false); return; }
        tab.Requested = true;
        ApplyBrowserSurface();
        if (tab.Status == "닫힘") tab.Status = string.Empty;
        UpdateTabState(tab);
    }

    private void CloseInAppBrowser()
    {
        var tab = ActiveTab;
        ++tab.OpenVersion;
        tab.Requested = false;
        tab.NeedsReload = tab.Loading;
        ApplyBrowserSurface();
        tab.Loading = false;
        tab.Core?.Stop();
        UpdateTabState(tab, "닫힘");
    }

    private void OnBrowserNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        var tab = TabForCore(sender);
        if (tab is null) return;
        // Navigate may queue this event after the user has already closed the panel.
        if (!tab.Requested)
        {
            e.Cancel = true;
            return;
        }
        tab.NavigationId = e.NavigationId;
        if (IsAllowedExternalUri(e.Uri))
        {
            tab.Loading = true;
            tab.Url = e.Uri;
            UpdateTabState(tab, "페이지를 여는 중입니다.");
            return;
        }

        e.Cancel = true;
        tab.Loading = false;
        UpdateTabState(tab, "http 또는 https 주소만 열 수 있습니다.");
    }

    private void OnBrowserNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        var tab = TabForCore(sender);
        if (tab is null) return;
        // Superseded or stopped/closed navigations must not overwrite current state.
        if (e.NavigationId != tab.NavigationId || !tab.Loading) return;
        tab.Loading = false;
        if (!tab.Requested) return;
        if (e.HttpStatusCode >= 400)
            UpdateTabState(tab, $"페이지 응답 오류 (HTTP {e.HttpStatusCode})");
        else if (!e.IsSuccess)
            UpdateTabState(tab, $"페이지를 불러오지 못했습니다. ({e.WebErrorStatus})");
        else
            UpdateTabState(tab, "탐색 완료");
    }

    private void OnBrowserHistoryChanged(object? sender, object e)
    {
        var tab = TabForCore(sender);
        if (tab is not null && tab.Id == _activeBrowserTabId) UpdateTabState(tab);
    }

    private void OnBrowserDocumentTitleChanged(object? sender, object e)
    {
        var tab = TabForCore(sender);
        if (tab is null) return;
        var title = tab.Core?.DocumentTitle?.Trim();
        tab.Title = string.IsNullOrWhiteSpace(title) ? "새 탭" : title;
        UpdateTabState(tab);
    }

    private void OnBrowserNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (IsProviderAuthNoiseUri(e.Uri))
        {
            NotifyProviderAuthBlocked(e.Uri);
            return;
        }
        var tab = TabForCore(sender) ?? ActiveTab;
        _ = OpenInAppBrowserOnTabAsync(tab, e.Uri, activate: tab.Id == _activeBrowserTabId);
    }

    private void UpdateBrowserState(string? status = null) => UpdateTabState(ActiveTab, status);

    /// <summary>Update per-tab status and post to the workspace only when the tab is active.</summary>
    private void UpdateTabState(BrowserTab tab, string? status = null)
    {
        if (status is not null) tab.Status = status;
        if (tab.Id == _activeBrowserTabId) PostBrowserState(tab.Status);
    }

    private void PostBrowserState(string status)
    {
        if (WebView.CoreWebView2 is null) return;
        var tab = ActiveTab;
        var state = JsonSerializer.Serialize(new
        {
            type = "inAppBrowser.state",
            visible = tab?.Core is not null && tab.Panel.IsVisible
                && tab.View.IsVisible && tab.View.ActualWidth > 0 && tab.View.ActualHeight > 0,
            url = tab is null ? string.Empty : (tab.Loading ? tab.Url : tab.Core?.Source ?? tab.Url),
            canGoBack = tab?.Core?.CanGoBack ?? false,
            canGoForward = tab?.Core?.CanGoForward ?? false,
            loading = tab?.Loading ?? false,
            status,
            activeTabId = _activeBrowserTabId,
            returnTabId = _browserReturnTabId,
            tabs = BrowserTabSummaries(),
        });
        WebView.CoreWebView2.PostWebMessageAsJson(state);
    }
}
