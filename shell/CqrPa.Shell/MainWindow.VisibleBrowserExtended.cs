using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;

namespace CqrPa.Shell;

/// <summary>
/// Extended agent actions for the user-visible WebView2 (scroll, wait, keys, select, history,
/// find, text/table extraction, console diagnostics, downloads). Every page script here is an
/// app-authored fixed function; agent input only travels as JSON arguments.
/// </summary>
public partial class MainWindow
{
    private const int VisibleWaitMaxMs = 12_000;
    private const int VisibleReadTextMax = 12_000;
    private const int VisibleDiagnosticMax = 100;
    private const int VisibleDownloadStartMs = 5_000;
    private const int VisibleDownloadFinishMs = 7_000;

    private sealed class PendingVisibleDownload
    {
        public PendingVisibleDownload(string directory) => Directory = directory;
        public string Directory { get; }
        public TaskCompletionSource<(CoreWebView2DownloadOperation Operation, string Path)> Started { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    private sealed record VisibleDiagnosticEntry(string kind, string level, string text, string? url, string at);

    // ── payload helpers ────────────────────────────────────────────────────────────────

    private static string? PayloadString(JsonElement payload, string name) =>
        payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(name, out var property)
            && property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;

    private static double? PayloadNumber(JsonElement payload, string name) =>
        payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(name, out var property)
            && property.ValueKind == JsonValueKind.Number && property.TryGetDouble(out var value)
            && double.IsFinite(value)
            ? value
            : null;

    private static bool PayloadBool(JsonElement payload, string name) =>
        payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(name, out var property)
            && property.ValueKind == JsonValueKind.True;

    private static string Clip(string? value, int max) =>
        string.IsNullOrEmpty(value) ? string.Empty : value.Length > max ? value[..max] : value;

    private BrowserTab RequireAutomatableTab(JsonElement payload) =>
        RequireVisibleBrowser(RequireAutomationControl(ResolveTab(PayloadTabId(payload))));

    private static string PageErrorMessage(JsonElement exceptionDetails)
    {
        var description = exceptionDetails.TryGetProperty("exception", out var exception)
            && exception.TryGetProperty("description", out var descriptionProperty)
            ? descriptionProperty.GetString()
            : exceptionDetails.TryGetProperty("text", out var text) ? text.GetString() : null;
        var line = (description ?? string.Empty).Split('\n')[0].Trim();
        if (line.StartsWith("Error: ", StringComparison.Ordinal)) line = line["Error: ".Length..];
        return line.Length == 0 ? "VISIBLE_BROWSER_SCRIPT_FAILED" : Clip(line, 240);
    }

    private static JsonElement ResultValue(string raw)
    {
        using var document = JsonDocument.Parse(raw);
        if (document.RootElement.TryGetProperty("exceptionDetails", out var details))
            throw new InvalidOperationException(PageErrorMessage(details));
        return document.RootElement.TryGetProperty("result", out var result)
            && result.TryGetProperty("value", out var value)
            ? value.Clone()
            : default;
    }

    /// <summary>Run a fixed page function with one JSON argument in the page's main world.</summary>
    private static async Task<JsonElement> EvaluatePageFunctionAsync(
        CoreWebView2 core, string functionDeclaration, object argument)
    {
        var expression = $"({functionDeclaration})({JsonSerializer.Serialize(argument)})";
        var raw = await core.CallDevToolsProtocolMethodAsync("Runtime.evaluate",
            JsonSerializer.Serialize(new { expression, returnByValue = true, awaitPromise = true, userGesture = true }));
        return ResultValue(raw);
    }

    private static async Task<JsonElement> CallOnElementAsync(
        CoreWebView2 core, string objectId, string functionDeclaration, object? argument = null)
    {
        var parameters = argument is null
            ? JsonSerializer.Serialize(new { objectId, functionDeclaration, returnByValue = true, awaitPromise = true, userGesture = true })
            : JsonSerializer.Serialize(new
            {
                objectId,
                functionDeclaration,
                arguments = new[] { new { value = argument } },
                returnByValue = true,
                awaitPromise = true,
                userGesture = true,
            });
        var raw = await core.CallDevToolsProtocolMethodAsync("Runtime.callFunctionOn", parameters);
        return ResultValue(raw);
    }

    /// <summary>Resolve snapshot ref (preferred) or CSS selector to a remote object id.</summary>
    private async Task<string?> ResolveTargetObjectIdAsync(BrowserTab tab, JsonElement payload, bool required)
    {
        var core = tab.Core!;
        if (!string.IsNullOrWhiteSpace(PayloadString(payload, "ref")))
            return await ResolveObjectIdAsync(core, ResolveAutomationRef(tab, payload));
        var selector = PayloadString(payload, "selector")?.Trim();
        if (!string.IsNullOrEmpty(selector))
        {
            var raw = await core.CallDevToolsProtocolMethodAsync("Runtime.evaluate", JsonSerializer.Serialize(new
            {
                expression = $"document.querySelector({JsonSerializer.Serialize(selector)})",
                returnByValue = false,
            }));
            using var document = JsonDocument.Parse(raw);
            if (document.RootElement.TryGetProperty("exceptionDetails", out _))
                throw new InvalidOperationException($"BROWSER_SELECTOR_INVALID: {Clip(selector, 200)}");
            if (document.RootElement.TryGetProperty("result", out var result)
                && result.TryGetProperty("objectId", out var objectIdProperty)
                && objectIdProperty.GetString() is { Length: > 0 } objectId)
                return objectId;
            throw new InvalidOperationException($"BROWSER_ELEMENT_NOT_FOUND: {Clip(selector, 200)}");
        }
        if (required) throw new InvalidOperationException("BROWSER_TARGET_REQUIRED: pass snapshot_id+ref or selector");
        return null;
    }

    // ── scroll / find ──────────────────────────────────────────────────────────────────

    private const string FindTextFunction = """
        function(a){
          const needle=String(a.text||'');const normalized=needle.toLocaleLowerCase();
          const stable=(el)=>{if(el.id)return '#'+CSS.escape(el.id);const n=el.getAttribute('name');if(n)return el.tagName.toLowerCase()+'[name="'+CSS.escape(n)+'"]';
            const t=el.getAttribute('data-testid');if(t)return '[data-testid="'+CSS.escape(t)+'"]';const parts=[];let c=el;
            while(c&&c!==document.body&&parts.length<5){const p=c.parentElement;if(!p)break;const tag=c.tagName.toLowerCase();
              const peers=Array.from(p.children).filter(x=>x.tagName===c.tagName);parts.unshift(peers.length>1?tag+':nth-of-type('+(peers.indexOf(c)+1)+')':tag);c=p;}
            return 'body > '+parts.join(' > ');};
          const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_ELEMENT);let cur=walker.nextNode();
          while(cur){const st=getComputedStyle(cur);const tv=(cur.textContent||'').replace(/\s+/g,' ').trim();
            if(st.display!=='none'&&st.visibility!=='hidden'&&tv.toLocaleLowerCase().includes(normalized)){
              const child=Array.from(cur.children).some(x=>(x.textContent||'').toLocaleLowerCase().includes(normalized));
              if(!child){cur.scrollIntoView({block:'center',inline:'nearest'});const prev=cur.style.outline;cur.style.outline='3px solid #0f8f83';
                setTimeout(()=>{cur.style.outline=prev;},1800);const at=tv.toLocaleLowerCase().indexOf(normalized);
                return {found:true,text:needle,selector:stable(cur),excerpt:tv.slice(Math.max(0,at-120),at+needle.length+240)};}}
            cur=walker.nextNode();}
          return {found:false,text:needle};}
        """;

    private async Task<object> AutomateBrowserFindAsync(JsonElement payload)
    {
        var tab = RequireAutomatableTab(payload);
        var core = tab.Core!;
        var text = (PayloadString(payload, "text") ?? string.Empty).Trim();
        if (text.Length == 0) throw new InvalidOperationException("BROWSER_FIND_TEXT_REQUIRED");
        var result = await EvaluatePageFunctionAsync(core, FindTextFunction, new { text });
        return new { target_id = "visible-browser", tab_id = tab.Id, url = core.Source ?? tab.Url, untrusted_web_content = true, result };
    }

    private async Task<object> AutomateBrowserScrollAsync(JsonElement payload)
    {
        var tab = RequireAutomatableTab(payload);
        var core = tab.Core!;
        var direction = PayloadString(payload, "direction") ?? "down";
        JsonElement position;
        switch (direction)
        {
            case "to-element":
            {
                var objectId = await ResolveTargetObjectIdAsync(tab, payload, required: true);
                position = await CallOnElementAsync(core, objectId!,
                    "function(){if(!(this instanceof Element))throw new Error('BROWSER_ELEMENT_NOT_FOUND');this.scrollIntoView({block:'center',inline:'nearest'});return {x:window.scrollX,y:window.scrollY};}");
                break;
            }
            case "to-text":
            {
                var text = (PayloadString(payload, "text") ?? string.Empty).Trim();
                if (text.Length == 0) throw new InvalidOperationException("BROWSER_FIND_TEXT_REQUIRED");
                var found = await EvaluatePageFunctionAsync(core, FindTextFunction, new { text });
                if (!found.TryGetProperty("found", out var ok) || ok.ValueKind != JsonValueKind.True)
                    throw new InvalidOperationException($"BROWSER_TEXT_NOT_FOUND: {Clip(text, 120)}");
                position = await EvaluatePageFunctionAsync(core, "function(){return {x:window.scrollX,y:window.scrollY};}", new { });
                break;
            }
            case "up":
            case "down":
            {
                var amount = Math.Clamp(Math.Abs(PayloadNumber(payload, "amount") ?? 700), 100, 4000);
                position = await EvaluatePageFunctionAsync(core,
                    "function(a){window.scrollBy({top:a.y,behavior:'instant'});return {x:window.scrollX,y:window.scrollY};}",
                    new { y = direction == "up" ? -amount : amount });
                break;
            }
            default:
                throw new InvalidOperationException("BROWSER_SCROLL_DIRECTION_INVALID");
        }
        return new { target_id = "visible-browser", tab_id = tab.Id, scrolled = true, direction, position, url = core.Source ?? tab.Url };
    }

    // ── wait ───────────────────────────────────────────────────────────────────────────

    private static bool BrowserUrlMatches(string current, string pattern)
    {
        if (pattern.Contains('*'))
        {
            var regex = "^" + Regex.Escape(pattern).Replace(@"\*\*", ".*").Replace(@"\*", "[^/]*") + "$";
            return Regex.IsMatch(current, regex, RegexOptions.IgnoreCase, TimeSpan.FromMilliseconds(200));
        }
        return current.Equals(pattern, StringComparison.OrdinalIgnoreCase)
            || current.Contains(pattern, StringComparison.OrdinalIgnoreCase);
    }

    private async Task<object> AutomateBrowserWaitAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        var tab = RequireAutomatableTab(payload);
        var core = tab.Core!;
        var timeout = (int)Math.Clamp(PayloadNumber(payload, "timeout_ms") ?? 5000, 100, VisibleWaitMaxMs);
        var selector = PayloadString(payload, "selector")?.Trim();
        var urlPattern = PayloadString(payload, "url")?.Trim();
        var state = PayloadString(payload, "state") is { } s && s is "attached" or "visible" or "hidden" or "detached" ? s : "visible";
        if (string.IsNullOrEmpty(selector) && string.IsNullOrEmpty(urlPattern))
            throw new InvalidOperationException("BROWSER_WAIT_TARGET_REQUIRED");
        var clock = Stopwatch.StartNew();
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            bool satisfied;
            if (!string.IsNullOrEmpty(selector))
            {
                try
                {
                    var value = await EvaluatePageFunctionAsync(core, """
                        function(a){const n=document.querySelector(a.s);if(a.state==='attached')return !!n;if(a.state==='detached')return !n;
                          let vis=false;if(n){const st=getComputedStyle(n);const r=n.getBoundingClientRect();vis=st.visibility!=='hidden'&&st.display!=='none'&&r.width>0&&r.height>0;}
                          return a.state==='hidden'?!vis:vis;}
                        """, new { s = selector, state });
                    satisfied = value.ValueKind == JsonValueKind.True;
                }
                catch (InvalidOperationException ex) when (ex.Message.Contains("SyntaxError", StringComparison.Ordinal)
                    || ex.Message.Contains("is not a valid selector", StringComparison.Ordinal))
                {
                    throw new InvalidOperationException($"BROWSER_SELECTOR_INVALID: {Clip(selector, 200)}");
                }
                catch (Exception) when (!cancellationToken.IsCancellationRequested)
                {
                    satisfied = false; // context destroyed during navigation; poll again
                }
            }
            else
            {
                satisfied = !tab.Loading && BrowserUrlMatches(core.Source ?? tab.Url, urlPattern!);
            }
            if (satisfied)
            {
                return new
                {
                    target_id = "visible-browser",
                    tab_id = tab.Id,
                    waited = true,
                    selector,
                    state = string.IsNullOrEmpty(selector) ? null : state,
                    url_pattern = urlPattern,
                    elapsed_ms = clock.ElapsedMilliseconds,
                    url = core.Source ?? tab.Url,
                };
            }
            if (clock.ElapsedMilliseconds >= timeout)
                throw new InvalidOperationException($"BROWSER_WAIT_TIMEOUT: {timeout}ms");
            await Task.Delay(200, cancellationToken);
        }
    }

    // ── keyboard ───────────────────────────────────────────────────────────────────────

    private static (string Key, string Code, int Vk, string? Text) ResolveBrowserKey(string name, bool shift)
    {
        switch (name.ToLowerInvariant())
        {
            case "enter": case "return": return ("Enter", "Enter", 13, "\r");
            case "tab": return ("Tab", "Tab", 9, null);
            case "escape": case "esc": return ("Escape", "Escape", 27, null);
            case "backspace": return ("Backspace", "Backspace", 8, null);
            case "delete": case "del": return ("Delete", "Delete", 46, null);
            case "insert": return ("Insert", "Insert", 45, null);
            case "space": case " ": return (" ", "Space", 32, " ");
            case "arrowup": case "up": return ("ArrowUp", "ArrowUp", 38, null);
            case "arrowdown": case "down": return ("ArrowDown", "ArrowDown", 40, null);
            case "arrowleft": case "left": return ("ArrowLeft", "ArrowLeft", 37, null);
            case "arrowright": case "right": return ("ArrowRight", "ArrowRight", 39, null);
            case "home": return ("Home", "Home", 36, null);
            case "end": return ("End", "End", 35, null);
            case "pageup": return ("PageUp", "PageUp", 33, null);
            case "pagedown": return ("PageDown", "PageDown", 34, null);
        }
        var function = Regex.Match(name, "^[Ff]([1-9]|1[0-9]|2[0-4])$");
        if (function.Success)
        {
            var n = int.Parse(function.Groups[1].Value);
            return ($"F{n}", $"F{n}", 111 + n, null);
        }
        if (name.Length == 1)
        {
            var c = name[0];
            if (char.IsAsciiLetter(c))
            {
                var upper = char.ToUpperInvariant(c);
                var text = shift ? upper.ToString() : name;
                return (text, $"Key{upper}", upper, text);
            }
            if (char.IsAsciiDigit(c)) return (name, $"Digit{c}", c, name);
            return (name, string.Empty, 0, name);
        }
        throw new InvalidOperationException($"BROWSER_KEY_INVALID: {Clip(name, 40)}");
    }

    private static Task DispatchKeyEventAsync(CoreWebView2 core, string type, int modifiers, string key, string code, int vk, string? text)
    {
        var parameters = new Dictionary<string, object?>
        {
            ["type"] = type,
            ["modifiers"] = modifiers,
            ["key"] = key,
            ["code"] = code,
            ["windowsVirtualKeyCode"] = vk,
            ["nativeVirtualKeyCode"] = vk,
        };
        if (text is not null)
        {
            parameters["text"] = text;
            parameters["unmodifiedText"] = text;
        }
        return core.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", JsonSerializer.Serialize(parameters));
    }

    private async Task<object> AutomateBrowserPressKeyAsync(JsonElement payload)
    {
        var tab = RequireAutomatableTab(payload);
        var core = tab.Core!;
        var chord = (PayloadString(payload, "key") ?? string.Empty).Trim();
        if (chord.Length == 0 || chord.Length > 80) throw new InvalidOperationException("BROWSER_KEY_INVALID");
        var objectId = await ResolveTargetObjectIdAsync(tab, payload, required: false);
        if (objectId is not null)
        {
            await CallOnElementAsync(core, objectId,
                "function(){if(!(this instanceof HTMLElement))throw new Error('BROWSER_ELEMENT_NOT_FOCUSABLE');this.scrollIntoView({block:'center',inline:'nearest'});this.focus();return true;}");
        }

        var parts = chord.Length > 1 && chord.EndsWith("++", StringComparison.Ordinal)
            ? chord[..^2].Split('+', StringSplitOptions.RemoveEmptyEntries).Append("+").ToArray()
            : chord == "+" ? new[] { "+" } : chord.Split('+', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) throw new InvalidOperationException("BROWSER_KEY_INVALID");
        var modifierKeys = new List<(string Key, string Code, int Vk, int Bit)>();
        foreach (var part in parts[..^1])
        {
            modifierKeys.Add(part.ToLowerInvariant() switch
            {
                "control" or "ctrl" => ("Control", "ControlLeft", 17, 2),
                "alt" => ("Alt", "AltLeft", 18, 1),
                "meta" or "cmd" or "command" or "win" => ("Meta", "MetaLeft", 91, 4),
                "shift" => ("Shift", "ShiftLeft", 16, 8),
                _ => throw new InvalidOperationException($"BROWSER_KEY_INVALID: {Clip(part, 40)}"),
            });
        }
        var modifiers = 0;
        foreach (var modifier in modifierKeys)
        {
            modifiers |= modifier.Bit;
            await DispatchKeyEventAsync(core, "rawKeyDown", modifiers, modifier.Key, modifier.Code, modifier.Vk, null);
        }
        var main = ResolveBrowserKey(parts[^1], (modifiers & 8) != 0);
        var printable = main.Text is not null && (modifiers & ~8) == 0;
        try
        {
            await DispatchKeyEventAsync(core, printable ? "keyDown" : "rawKeyDown", modifiers, main.Key, main.Code, main.Vk, printable ? main.Text : null);
            await DispatchKeyEventAsync(core, "keyUp", modifiers, main.Key, main.Code, main.Vk, null);
        }
        finally
        {
            for (var i = modifierKeys.Count - 1; i >= 0; i--)
            {
                modifiers &= ~modifierKeys[i].Bit;
                await DispatchKeyEventAsync(core, "keyUp", modifiers, modifierKeys[i].Key, modifierKeys[i].Code, modifierKeys[i].Vk, null);
            }
        }
        InvalidateAutomationSnapshot(tab);
        return new { target_id = "visible-browser", tab_id = tab.Id, pressed = chord, snapshot_invalidated = true, url = core.Source ?? tab.Url };
    }

    // ── select / history ───────────────────────────────────────────────────────────────

    private async Task<object> AutomateBrowserSelectAsync(JsonElement payload)
    {
        var tab = RequireAutomatableTab(payload);
        var core = tab.Core!;
        var value = PayloadString(payload, "value") ?? string.Empty;
        var objectId = await ResolveTargetObjectIdAsync(tab, payload, required: true);
        var selected = await CallOnElementAsync(core, objectId!, """
            function(v){if(!(this instanceof HTMLSelectElement))throw new Error('BROWSER_ELEMENT_NOT_SELECT');
              const want=String(v).trim();const opts=Array.from(this.options);const label=(o)=>(o.label||o.text||'').trim();
              const o=opts.find(x=>x.value===want)||opts.find(x=>label(x)===want)||opts.find(x=>label(x).toLowerCase()===want.toLowerCase());
              if(!o)throw new Error('BROWSER_OPTION_NOT_FOUND: '+want.slice(0,120));
              this.value=o.value;o.selected=true;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));
              return {value:o.value,label:label(o)};}
            """, value);
        InvalidateAutomationSnapshot(tab);
        return new { target_id = "visible-browser", tab_id = tab.Id, selected, snapshot_invalidated = true, url = core.Source ?? tab.Url };
    }

    private async Task<object> AutomateBrowserHistoryAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        var tab = RequireAutomatableTab(payload);
        var core = tab.Core!;
        var action = PayloadString(payload, "action") is "forward" or "reload" ? PayloadString(payload, "action")! : "back";
        var before = tab.NavigationId;
        switch (action)
        {
            case "back":
                if (!core.CanGoBack) throw new InvalidOperationException("BROWSER_HISTORY_UNAVAILABLE: no previous page");
                core.GoBack();
                break;
            case "forward":
                if (!core.CanGoForward) throw new InvalidOperationException("BROWSER_HISTORY_UNAVAILABLE: no next page");
                core.GoForward();
                break;
            default:
                core.Reload();
                break;
        }
        InvalidateAutomationSnapshot(tab);
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < 10_000)
        {
            if (tab.NavigationId != before) { if (!tab.Loading) break; }
            else if (clock.ElapsedMilliseconds > 1_500) break; // same-document history entry
            await Task.Delay(100, cancellationToken);
        }
        return new
        {
            target_id = "visible-browser",
            tab_id = tab.Id,
            action,
            loading = tab.Loading,
            title = core.DocumentTitle,
            snapshot_invalidated = true,
            url = core.Source ?? tab.Url,
        };
    }

    // ── extraction ─────────────────────────────────────────────────────────────────────

    private async Task<object> AutomateBrowserReadTextAsync(JsonElement payload)
    {
        var tab = RequireAutomatableTab(payload);
        var core = tab.Core!;
        var mode = PayloadString(payload, "mode") == "table" ? "table" : "text";
        var objectId = await ResolveTargetObjectIdAsync(tab, payload, required: false);
        const string extract = """
            function(a){const root=this instanceof Element?this:document.body;
              if(a.mode==='table'){const tables=root.matches('table')?[root]:Array.from(root.querySelectorAll('table'));
                const rows=tables.flatMap((t,i)=>Array.from(t.querySelectorAll('tr')).map(r=>({table:i+1,cells:Array.from(r.querySelectorAll('th,td')).map(c=>(c.textContent||'').replace(/\s+/g,' ').trim())})));
                const json=JSON.stringify(rows);return {content:json.slice(0,a.max),truncated:json.length>a.max,rows:rows.length};}
              const text=(root.innerText||root.textContent||'').replace(/\n{3,}/g,'\n\n').trim();
              return {content:text.slice(0,a.max),truncated:text.length>a.max,chars:text.length};}
            """;
        JsonElement result;
        if (objectId is not null)
        {
            result = await CallOnElementAsync(core, objectId, extract, new { mode, max = VisibleReadTextMax });
        }
        else
        {
            var raw = await core.CallDevToolsProtocolMethodAsync("Runtime.evaluate", JsonSerializer.Serialize(new
            {
                expression = $"({extract}).call(document.body,{JsonSerializer.Serialize(new { mode, max = VisibleReadTextMax })})",
                returnByValue = true,
            }));
            result = ResultValue(raw);
        }
        return new
        {
            target_id = "visible-browser",
            tab_id = tab.Id,
            mode,
            url = core.Source ?? tab.Url,
            untrusted_web_content = true,
            result,
        };
    }

    // ── console / network diagnostics ──────────────────────────────────────────────────

    private void AttachBrowserDiagnostics(BrowserTab tab, CoreWebView2 core)
    {
        void On(string eventName, Action<JsonElement> handler) =>
            core.GetDevToolsProtocolEventReceiver(eventName).DevToolsProtocolEventReceived += (_, e) =>
            {
                try
                {
                    using var document = JsonDocument.Parse(e.ParameterObjectAsJson);
                    handler(document.RootElement);
                }
                catch
                {
                    // Diagnostics are best-effort and must never disturb the page.
                }
            };

        On("Runtime.consoleAPICalled", root =>
        {
            var type = root.TryGetProperty("type", out var t) ? t.GetString() ?? "log" : "log";
            if (type is not ("error" or "warning" or "assert")) return;
            var text = root.TryGetProperty("args", out var args) && args.ValueKind == JsonValueKind.Array
                ? string.Join(" ", args.EnumerateArray().Select(arg =>
                    arg.TryGetProperty("value", out var v) ? v.ToString()
                    : arg.TryGetProperty("description", out var d) ? d.GetString() ?? string.Empty : string.Empty))
                : string.Empty;
            string? url = null;
            if (root.TryGetProperty("stackTrace", out var stack) && stack.TryGetProperty("callFrames", out var frames)
                && frames.ValueKind == JsonValueKind.Array && frames.GetArrayLength() > 0
                && frames[0].TryGetProperty("url", out var frameUrl))
                url = frameUrl.GetString();
            AddBrowserDiagnostic(tab, "console", type == "warning" ? "warning" : "error", text, url);
        });
        On("Runtime.exceptionThrown", root =>
        {
            if (!root.TryGetProperty("exceptionDetails", out var details)) return;
            var url = details.TryGetProperty("url", out var u) ? u.GetString() : null;
            AddBrowserDiagnostic(tab, "console", "error", PageErrorMessage(details), url);
        });
        On("Network.requestWillBeSent", root =>
        {
            if (!root.TryGetProperty("requestId", out var id) || !root.TryGetProperty("request", out var request)
                || !request.TryGetProperty("url", out var url)) return;
            if (tab.RequestUrls.Count > 500) tab.RequestUrls.Clear();
            tab.RequestUrls[id.GetString() ?? string.Empty] = Clip(url.GetString(), 500);
        });
        On("Network.responseReceived", root =>
        {
            if (!root.TryGetProperty("response", out var response)
                || !response.TryGetProperty("status", out var statusProperty)
                || !statusProperty.TryGetInt32(out var status) || status < 400) return;
            var statusText = response.TryGetProperty("statusText", out var st) ? st.GetString() : null;
            var url = response.TryGetProperty("url", out var u) ? u.GetString() : null;
            AddBrowserDiagnostic(tab, "http", "error", $"HTTP {status} {statusText}".Trim(), url);
        });
        On("Network.loadingFailed", root =>
        {
            if (root.TryGetProperty("canceled", out var canceled) && canceled.ValueKind == JsonValueKind.True) return;
            var error = root.TryGetProperty("errorText", out var e) ? e.GetString() : "failed";
            var id = root.TryGetProperty("requestId", out var r) ? r.GetString() ?? string.Empty : string.Empty;
            tab.RequestUrls.TryGetValue(id, out var url);
            AddBrowserDiagnostic(tab, "network", "error", error ?? "failed", url);
        });
        _ = EnableBrowserDiagnosticsAsync(core);
    }

    private static async Task EnableBrowserDiagnosticsAsync(CoreWebView2 core)
    {
        foreach (var method in new[] { "Runtime.enable", "Network.enable" })
        {
            try { await core.CallDevToolsProtocolMethodAsync(method, "{}"); }
            catch { /* diagnostics stay empty when the domain cannot be enabled */ }
        }
    }

    private static void AddBrowserDiagnostic(BrowserTab tab, string kind, string level, string text, string? url)
    {
        lock (tab.Diagnostics)
        {
            tab.Diagnostics.Add(new VisibleDiagnosticEntry(kind, level, Clip(text, 500),
                string.IsNullOrEmpty(url) ? null : Clip(url, 500), DateTimeOffset.UtcNow.ToString("O")));
            if (tab.Diagnostics.Count > VisibleDiagnosticMax)
                tab.Diagnostics.RemoveRange(0, tab.Diagnostics.Count - VisibleDiagnosticMax);
        }
    }

    private object BrowserConsoleLogs(JsonElement payload)
    {
        var tab = RequireAutomatableTab(payload);
        VisibleDiagnosticEntry[] entries;
        lock (tab.Diagnostics)
        {
            entries = tab.Diagnostics.ToArray();
            if (PayloadBool(payload, "clear")) tab.Diagnostics.Clear();
        }
        return new { target_id = "visible-browser", tab_id = tab.Id, url = tab.Core!.Source ?? tab.Url, untrusted_web_content = true, entries };
    }

    // ── downloads ──────────────────────────────────────────────────────────────────────

    /// <summary>The core chooses the folder, but it must stay under &lt;root&gt;\data\outputs\browser\*\downloads.</summary>
    private static string ValidateDownloadDirectory(string? requested)
    {
        if (string.IsNullOrWhiteSpace(requested) || !Path.IsPathFullyQualified(requested))
            throw new InvalidOperationException("BROWSER_DOWNLOAD_DIR_INVALID");
        var full = Path.GetFullPath(requested).TrimEnd(Path.DirectorySeparatorChar);
        string browserOutputs;
        try
        {
            browserOutputs = Path.Combine(CqrPaths.ResolveCqrRoot(), "data", "outputs", "browser") + Path.DirectorySeparatorChar;
        }
        catch
        {
            throw new InvalidOperationException("BROWSER_DOWNLOAD_DIR_INVALID");
        }
        if (!full.StartsWith(browserOutputs, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(Path.GetFileName(full), "downloads", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("BROWSER_DOWNLOAD_DIR_INVALID");
        return full;
    }

    private static string UniqueDownloadPath(string directory, string? suggested)
    {
        var name = Path.GetFileName(suggested ?? string.Empty);
        foreach (var invalid in Path.GetInvalidFileNameChars()) name = name.Replace(invalid, '_');
        name = name.Trim().Trim('.');
        if (name.Length == 0) name = $"download-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";
        if (name.Length > 120)
        {
            var ext = Path.GetExtension(name);
            name = name[..(120 - Math.Min(ext.Length, 20))] + (ext.Length <= 20 ? ext : string.Empty);
        }
        var stem = Path.GetFileNameWithoutExtension(name);
        var extension = Path.GetExtension(name);
        var candidate = Path.Combine(directory, name);
        for (var i = 1; File.Exists(candidate) && i < 1000; i++)
            candidate = Path.Combine(directory, $"{stem}-{i}{extension}");
        return candidate;
    }

    /// <summary>Called from DownloadStarting: accept only the download an agent action armed.</summary>
    private bool TryAcceptAutomationDownload(BrowserTab tab, CoreWebView2DownloadStartingEventArgs e)
    {
        var pending = tab.PendingDownload;
        if (pending is null) return false;
        tab.PendingDownload = null;
        try
        {
            var target = UniqueDownloadPath(pending.Directory, e.ResultFilePath);
            e.ResultFilePath = target;
            e.Handled = true;
            pending.Started.TrySetResult((e.DownloadOperation, target));
            UpdateTabState(tab, "에이전트가 요청한 파일을 저장하는 중입니다.");
            return true;
        }
        catch (Exception ex)
        {
            pending.Started.TrySetException(ex);
            return false;
        }
    }

    private async Task<object> AutomateBrowserDownloadAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        var tab = RequireAutomatableTab(payload);
        var core = tab.Core!;
        var directory = ValidateDownloadDirectory(PayloadString(payload, "download_dir"));
        var objectId = await ResolveTargetObjectIdAsync(tab, payload, required: true);
        Directory.CreateDirectory(directory);
        var pending = new PendingVisibleDownload(directory);
        tab.PendingDownload = pending;
        (CoreWebView2DownloadOperation Operation, string Path) started;
        try
        {
            await CallOnElementAsync(core, objectId!,
                "function(){if(!(this instanceof HTMLElement))throw new Error('BROWSER_ELEMENT_NOT_CLICKABLE');this.scrollIntoView({block:'center',inline:'nearest'});this.click();return true;}");
            var winner = await Task.WhenAny(pending.Started.Task, Task.Delay(VisibleDownloadStartMs, cancellationToken));
            if (winner != pending.Started.Task)
            {
                cancellationToken.ThrowIfCancellationRequested();
                throw new InvalidOperationException("BROWSER_DOWNLOAD_NOT_STARTED: the click did not start a download within 5s");
            }
            started = await pending.Started.Task;
        }
        finally
        {
            if (ReferenceEquals(tab.PendingDownload, pending)) tab.PendingDownload = null;
        }

        var operation = started.Operation;
        var finished = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        operation.StateChanged += (_, _) =>
        {
            if (operation.State != CoreWebView2DownloadState.InProgress) finished.TrySetResult(true);
        };
        if (operation.State != CoreWebView2DownloadState.InProgress) finished.TrySetResult(true);
        await Task.WhenAny(finished.Task, Task.Delay(VisibleDownloadFinishMs, cancellationToken));
        InvalidateAutomationSnapshot(tab);
        var state = operation.State;
        if (state == CoreWebView2DownloadState.Interrupted)
            throw new InvalidOperationException($"BROWSER_DOWNLOAD_FAILED: {operation.InterruptReason}");
        var completed = state == CoreWebView2DownloadState.Completed;
        UpdateTabState(tab, completed ? "에이전트가 요청한 파일을 저장했습니다." : "에이전트가 요청한 파일을 계속 저장하는 중입니다.");
        return new
        {
            target_id = "visible-browser",
            tab_id = tab.Id,
            downloaded = completed,
            state = completed ? "completed" : "in_progress",
            path = started.Path,
            filename = Path.GetFileName(started.Path),
            bytes = operation.BytesReceived,
            total_bytes = operation.TotalBytesToReceive,
            mime = operation.MimeType,
            download_url = operation.Uri,
            snapshot_invalidated = true,
            url = core.Source ?? tab.Url,
        };
    }
}
