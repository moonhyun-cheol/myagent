using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace CqrPa.Shell;

public partial class MainWindow
{
    private VisibleBrowserAutomationClient? _visibleBrowserAutomation;

    private void StartVisibleBrowserAutomation()
    {
        if (_visibleBrowserAutomation is not null) return;
        _visibleBrowserAutomation = new VisibleBrowserAutomationClient(_port, ExecuteVisibleBrowserCommandAsync);
        _visibleBrowserAutomation.Start();
        Closed += (_, _) => _visibleBrowserAutomation?.Dispose();
    }

    private Task<object> ExecuteVisibleBrowserCommandAsync(JsonElement command) => Dispatcher.InvokeAsync(async () =>
    {
        var action = command.TryGetProperty("action", out var actionProperty) ? actionProperty.GetString() : null;
        var payload = command.TryGetProperty("payload", out var payloadProperty) ? payloadProperty : default;
        return action switch
        {
            "targets" => BrowserAutomationState(),
            "navigate" => await AutomateBrowserNavigateAsync(payload),
            "snapshot" => await CaptureBrowserSnapshotAsync(payload),
            "click" => await AutomateBrowserClickAsync(payload),
            "fill" => await AutomateBrowserFillAsync(payload),
            "screenshot" => await CaptureBrowserScreenshotAsync(payload),
            "tab.create" => BrowserTabCreate(payload),
            "tab.close" => BrowserTabClose(payload),
            "tab.activate" => BrowserTabActivate(payload),
            "tab.list" => BrowserTabList(),
            "tab.control.acquire" => BrowserTabControlAcquire(payload),
            "tab.control.release" => BrowserTabControlRelease(payload),
            _ => throw new InvalidOperationException("VISIBLE_BROWSER_ACTION_UNSUPPORTED"),
        };
    }).Task.Unwrap();

    private static string? PayloadTabId(JsonElement payload) =>
        payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("tab_id", out var property)
            ? property.GetString()
            : null;

    private object BrowserAutomationState()
    {
        var tab = PeekActiveTab();
        return new
        {
            id = "visible-browser",
            kind = "visible",
            connected = true,
            available = tab?.Core is not null,
            visible = tab?.Core is not null && tab.Panel.IsVisible && tab.View.IsVisible,
            url = tab?.Core?.Source ?? tab?.Url ?? string.Empty,
            loading = tab?.Loading ?? false,
            title = tab?.Title ?? "현재 인앱 웹 페이지",
            active_tab_id = _activeBrowserTabId,
            tabs = BrowserTabSummaries(),
        };
    }

    private object BrowserTabState(BrowserTab tab) => new
    {
        target_id = "visible-browser",
        tab_id = tab.Id,
        active_tab_id = _activeBrowserTabId,
        available = tab.Core is not null,
        visible = tab.Core is not null && tab.Panel.IsVisible && tab.View.IsVisible,
        url = tab.Core?.Source ?? tab.Url,
        loading = tab.Loading,
        title = tab.Title,
        tabs = BrowserTabSummaries(),
    };

    private object BrowserTabCreate(JsonElement payload)
    {
        var tab = CreateTab(PayloadTabId(payload));
        return new { created = true, tab_id = tab.Id, active_tab_id = _activeBrowserTabId, tabs = BrowserTabSummaries() };
    }

    private object BrowserTabClose(JsonElement payload)
    {
        var requested = PayloadTabId(payload);
        CloseTab(requested);
        return new { closed = true, tab_id = requested, active_tab_id = _activeBrowserTabId, tabs = BrowserTabSummaries() };
    }

    private object BrowserTabActivate(JsonElement payload)
    {
        ActivateTab(PayloadTabId(payload));
        return new { activated = true, active_tab_id = _activeBrowserTabId, tabs = BrowserTabSummaries() };
    }

    private object BrowserTabList() =>
        new { active_tab_id = _activeBrowserTabId, tabs = BrowserTabSummaries() };

    private static string? PayloadOwner(JsonElement payload) =>
        payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("owner", out var property)
            ? property.GetString()
            : null;

    private object BrowserTabControlAcquire(JsonElement payload)
    {
        AcquireAutomationControl(PayloadTabId(payload), PayloadOwner(payload));
        return BrowserTabList();
    }

    private object BrowserTabControlRelease(JsonElement payload)
    {
        ReleaseAutomationControl(PayloadTabId(payload), PayloadOwner(payload));
        return BrowserTabList();
    }

    private static BrowserTab RequireAutomationControl(BrowserTab tab)
    {
        if (tab.ControlTakenOver) throw new InvalidOperationException("VISIBLE_BROWSER_CONTROL_TAKEN_OVER");
        return tab;
    }

    private async Task<object> AutomateBrowserNavigateAsync(JsonElement payload)
    {
        var url = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("url", out var property)
            ? property.GetString()
            : null;
        if (!TryNormalizeBrowserUri(url, out var uri))
            throw new InvalidOperationException("VISIBLE_BROWSER_URL_INVALID");
        var tab = RequireAutomationControl(ResolveTab(PayloadTabId(payload), createIfMissing: true));
        await OpenInAppBrowserOnTabAsync(tab, uri.AbsoluteUri, activate: tab.Id == _activeBrowserTabId);
        return BrowserTabState(tab);
    }

    private BrowserTab RequireVisibleBrowser(BrowserTab tab)
    {
        // A tab remains a visible-browser target while another tab is active. Keeping
        // the native surface hidden must not interrupt an observed agent operation.
        if (tab.Core is null || !tab.Requested)
            throw new InvalidOperationException("VISIBLE_BROWSER_NOT_READY");
        if (!IsAllowedExternalUri(tab.Core.Source ?? tab.Url))
            throw new InvalidOperationException("VISIBLE_BROWSER_EXTERNAL_PAGE_REQUIRED");
        return tab;
    }

    private async Task<object> CaptureBrowserSnapshotAsync(JsonElement payload)
    {
        var tab = RequireVisibleBrowser(RequireAutomationControl(ResolveTab(PayloadTabId(payload))));
        var core = tab.Core!;
        var raw = await core.CallDevToolsProtocolMethodAsync("Accessibility.getFullAXTree", "{}");
        using var document = JsonDocument.Parse(raw);
        var refs = new Dictionary<string, long>(StringComparer.Ordinal);
        var nodes = new List<object>();
        var sequence = 0;
        if (document.RootElement.TryGetProperty("nodes", out var sourceNodes))
        {
            foreach (var node in sourceNodes.EnumerateArray())
            {
                if (nodes.Count >= 300) break;
                if (node.TryGetProperty("ignored", out var ignored) && ignored.ValueKind == JsonValueKind.True) continue;
                var role = AxValue(node, "role");
                var name = AxValue(node, "name");
                if (string.IsNullOrWhiteSpace(role) || string.IsNullOrWhiteSpace(name)) continue;
                if (!IsSnapshotRole(role)) continue;
                string? reference = null;
                if (IsActionableSnapshotRole(role)
                    && node.TryGetProperty("backendDOMNodeId", out var backendProperty)
                    && backendProperty.TryGetInt64(out var backendNodeId) && backendNodeId > 0)
                {
                    reference = $"e{++sequence}";
                    refs[reference] = backendNodeId;
                }
                nodes.Add(new { @ref = reference, role, name = name.Length > 500 ? name[..500] : name });
            }
        }
        tab.SnapshotId = Guid.NewGuid().ToString("N");
        tab.SnapshotNavigationId = tab.NavigationId;
        tab.Refs = refs;
        return new
        {
            target_id = "visible-browser",
            tab_id = tab.Id,
            snapshot_id = tab.SnapshotId,
            url = core.Source ?? tab.Url,
            navigation_id = tab.NavigationId,
            untrusted_web_content = true,
            nodes,
        };
    }

    private static string AxValue(JsonElement node, string propertyName)
    {
        if (!node.TryGetProperty(propertyName, out var property)
            || !property.TryGetProperty("value", out var value)) return string.Empty;
        return value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : value.ToString();
    }

    private static bool IsSnapshotRole(string role) => role is
        "RootWebArea" or "heading" or "link" or "button" or "textbox" or "searchbox"
        or "checkbox" or "radio" or "combobox" or "menuitem" or "option" or "tab"
        or "switch" or "slider" or "StaticText";

    private static bool IsActionableSnapshotRole(string role) => role is
        "link" or "button" or "textbox" or "searchbox" or "checkbox" or "radio"
        or "combobox" or "menuitem" or "option" or "tab" or "switch" or "slider";

    private static long ResolveAutomationRef(BrowserTab tab, JsonElement payload)
    {
        var snapshotId = payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty("snapshot_id", out var snapshotProperty)
            ? snapshotProperty.GetString()
            : null;
        var reference = payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty("ref", out var refProperty)
            ? refProperty.GetString()
            : null;
        if (string.IsNullOrWhiteSpace(snapshotId) || snapshotId != tab.SnapshotId
            || tab.SnapshotNavigationId != tab.NavigationId)
            throw new InvalidOperationException("STALE_BROWSER_REF");
        if (string.IsNullOrWhiteSpace(reference) || !tab.Refs.TryGetValue(reference, out var backendNodeId))
            throw new InvalidOperationException("BROWSER_REF_NOT_FOUND");
        return backendNodeId;
    }

    private async Task<string> ResolveObjectIdAsync(CoreWebView2 core, long backendNodeId)
    {
        var raw = await core.CallDevToolsProtocolMethodAsync(
            "DOM.resolveNode", JsonSerializer.Serialize(new { backendNodeId }));
        using var document = JsonDocument.Parse(raw);
        if (!document.RootElement.TryGetProperty("object", out var remoteObject)
            || !remoteObject.TryGetProperty("objectId", out var objectIdProperty))
            throw new InvalidOperationException("BROWSER_NODE_NOT_RESOLVABLE");
        return objectIdProperty.GetString() ?? throw new InvalidOperationException("BROWSER_NODE_NOT_RESOLVABLE");
    }

    private async Task<JsonElement> CallOnNodeAsync(CoreWebView2 core, string objectId, string functionDeclaration, object[]? arguments = null)
    {
        var parameters = arguments is null
            ? JsonSerializer.Serialize(new { objectId, functionDeclaration, returnByValue = true, awaitPromise = true })
            : JsonSerializer.Serialize(new { objectId, functionDeclaration, arguments, returnByValue = true, awaitPromise = true });
        var raw = await core.CallDevToolsProtocolMethodAsync("Runtime.callFunctionOn", parameters);
        using var document = JsonDocument.Parse(raw);
        if (document.RootElement.TryGetProperty("exceptionDetails", out _))
            throw new InvalidOperationException("VISIBLE_BROWSER_SCRIPT_FAILED");
        return document.RootElement.Clone();
    }

    private async Task<object> AutomateBrowserClickAsync(JsonElement payload)
    {
        var tab = RequireVisibleBrowser(RequireAutomationControl(ResolveTab(PayloadTabId(payload))));
        var core = tab.Core!;
        var backendNodeId = ResolveAutomationRef(tab, payload);
        var objectId = await ResolveObjectIdAsync(core, backendNodeId);
        await CallOnNodeAsync(core, objectId,
            "function(){if(!(this instanceof Element))return {ok:false};this.scrollIntoView({block:'center',inline:'center'});this.click();return {ok:true};}");
        InvalidateAutomationSnapshot(tab);
        return new { tab_id = tab.Id, clicked = true, snapshot_invalidated = true, url = core.Source ?? tab.Url };
    }

    private async Task<object> AutomateBrowserFillAsync(JsonElement payload)
    {
        var tab = RequireVisibleBrowser(RequireAutomationControl(ResolveTab(PayloadTabId(payload))));
        var core = tab.Core!;
        var backendNodeId = ResolveAutomationRef(tab, payload);
        var value = payload.TryGetProperty("value", out var valueProperty) ? valueProperty.GetString() ?? string.Empty : string.Empty;
        var objectId = await ResolveObjectIdAsync(core, backendNodeId);
        var result = await CallOnNodeAsync(core, objectId,
            "function(value){if(this instanceof HTMLInputElement&&this.type==='password')throw new Error('PASSWORD_FIELD_BLOCKED');if(this instanceof HTMLInputElement){const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(this,value);}else if(this instanceof HTMLTextAreaElement){const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(this,value);}else if(this.isContentEditable){this.textContent=value;}else{throw new Error('ELEMENT_NOT_EDITABLE');}this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));this.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true};}",
            [new { value }]);
        if (result.ToString().Contains("PASSWORD_FIELD_BLOCKED", StringComparison.Ordinal))
            throw new InvalidOperationException("PASSWORD_FIELD_BLOCKED");
        InvalidateAutomationSnapshot(tab);
        return new { tab_id = tab.Id, filled = true, snapshot_invalidated = true, url = core.Source ?? tab.Url };
    }

    private static void InvalidateAutomationSnapshot(BrowserTab tab)
    {
        tab.SnapshotId = null;
        tab.Refs.Clear();
    }

    private async Task<object> CaptureBrowserScreenshotAsync(JsonElement payload)
    {
        var tab = RequireVisibleBrowser(RequireAutomationControl(ResolveTab(PayloadTabId(payload))));
        var core = tab.Core!;
        await using var stream = new MemoryStream();
        await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);
        return new
        {
            target_id = "visible-browser",
            tab_id = tab.Id,
            url = core.Source ?? tab.Url,
            image_base64 = Convert.ToBase64String(stream.ToArray()),
        };
    }
}
