// Real production Window/XAML + two native WebView2s. No API process or user browser profile.
// Run: dotnet run --project tools/lab/in-app-browser-smoke/BrowserSmoke.csproj
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using CqrPa.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

internal static class Program
{
    const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr handle, uint flags);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    static void Click(FrameworkElement el, double x, double y) { var p = el.PointToScreen(new System.Windows.Point(x, y)); SetCursorPos((int)p.X, (int)p.Y); mouse_event(2, 0, 0, 0, UIntPtr.Zero); mouse_event(4, 0, 0, 0, UIntPtr.Zero); }
    static object? Invoke(object target, string name, params object?[] args) => target.GetType().GetMethod(name, Private)!.Invoke(target, args);
    static object Field(object target, string name) => target.GetType().GetField(name, Private)!.GetValue(target)!;
    static void Set(object target, string name, object value) => target.GetType().GetField(name, Private)!.SetValue(target, value);
    static void Check(bool value, string message) { if (!value) throw new Exception(message); Console.WriteLine("PASS " + message); }
    static async Task Until(Func<bool> predicate, string message, int timeout = 15000)
    {
        var end = DateTime.UtcNow.AddMilliseconds(timeout);
        while (!predicate()) { if (DateTime.UtcNow > end) throw new TimeoutException(message); await Task.Delay(40); }
    }
    [STAThread] static int Main()
    {
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        int code = 1;
        app.Startup += async (_, _) =>
        {
            try { await Run(); code = 0; }
            catch (Exception e) { Console.Error.WriteLine(e); }
            finally { app.Shutdown(code); }
        };
        app.Run();
        return code;
    }
    static async Task Run()
    {
        var root = Path.Combine(Path.GetTempPath(), "my-agent-browser-smoke-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        using var server = new TcpListener(IPAddress.Loopback, 0);
        server.Start();
        int port = ((IPEndPoint)server.LocalEndpoint).Port;
        var fixture = $"http://127.0.0.1:{port}";
        _ = Task.Run(async () =>
        {
            try
            {
                while (true)
                {
                    var client = await server.AcceptTcpClientAsync();
                    _ = Task.Run(async () =>
                    {
                        using (client)
                        {
                            try
                            {
                                using var stream = client.GetStream();
                                using var reader = new StreamReader(stream, Encoding.ASCII, leaveOpen: true);
                                var request = await reader.ReadLineAsync() ?? "";
                                while (!string.IsNullOrEmpty(await reader.ReadLineAsync())) { }
                                if (request.Contains("/slow")) await Task.Delay(1800);
                                var status = request.Contains("/missing") ? "404 Not Found" : "200 OK";
                                var body = Encoding.UTF8.GetBytes("<!doctype html><title>Browser fixture</title><body style='background:#27a57d'><button id='target' style='position:fixed;inset:0' onclick='document.title=\"clicked\"'>Browser fixture</button></body>");
                                await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n"));
                                await stream.WriteAsync(body);
                            }
                            catch (IOException) { }
                        }
                    });
                }
            }
            catch (Exception e) when (e is SocketException or ObjectDisposedException) { }
        });
        using var api = new ApiProcessHost(root); // Never Start().
        var window = (MainWindow)Activator.CreateInstance(typeof(MainWindow), Private, null, new object[] { root, port, api }, null)!;
        // Disable API startup and placement tracking, not browser production logic.
        window.Loaded -= (RoutedEventHandler)Delegate.CreateDelegate(typeof(RoutedEventHandler), window, typeof(MainWindow).GetMethod("OnLoaded", Private)!);
        var placement = Field(window, "_windowPlacement");
        ((DispatcherTimer)Field(placement, "_saveTimer")).Stop();
        Set(placement, "_tracking", true); // StartTracking becomes a no-op; no settings writes.
        var workspace = (WebView2CompositionControl)window.FindName("WebView");
        var browser = (WebView2)window.FindName("BrowserWebView");
        var panel = (FrameworkElement)window.FindName("InAppBrowserPanel");
        string Status() => (string)Field(window, "_browserStatus");
        try
        {
            ((FrameworkElement)window.FindName("StartupOverlay")).Visibility = Visibility.Collapsed;
            window.Show(); window.Activate(); window.Topmost = true;
            window.Left = 20; window.Top = 20;
            window.Width = 1100; window.Height = 780;
            var env = await CoreWebView2Environment.CreateAsync(userDataFolder: Path.Combine(root, "workspace"));
            await workspace.EnsureCoreWebView2Async(env);
            workspace.CoreWebView2.WebMessageReceived += (EventHandler<CoreWebView2WebMessageReceivedEventArgs>)Delegate.CreateDelegate(typeof(EventHandler<CoreWebView2WebMessageReceivedEventArgs>), window, typeof(MainWindow).GetMethod("OnWorkspaceWebMessageReceived", Private)!);
            var ready = new TaskCompletionSource();
            workspace.CoreWebView2.NavigationCompleted += (_, _) => ready.TrySetResult();
            workspace.NavigateToString("""
                <!doctype html><title>Workspace fixture</title><body style='margin:0;background:#eeeeee'>
                <button id='chat' style='position:fixed;left:5%;top:20%;width:15%;height:30%' onclick='document.title="chat clicked"'>Chat</button>
                <div id='slot' style='position:fixed;left:55%;top:12%;width:45%;height:88%'></div>
                <script>
                window.states=[];chrome.webview.addEventListener('message',e=>{if(e.data.type==='inAppBrowser.state')states.push(e.data)});
                window.surface=(visible=true)=>{const r=document.getElementById('slot').getBoundingClientRect();chrome.webview.postMessage({type:'inAppBrowser.surface',visible,x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight})};
                onresize=()=>surface();requestAnimationFrame(()=>surface());
                </script></body>
                """);
            await ready.Task.WaitAsync(TimeSpan.FromSeconds(15));
            async Task Send(string type, string? url = null) => await workspace.ExecuteScriptAsync($"chrome.webview.postMessage({JsonSerializer.Serialize(new { type = "inAppBrowser." + type, url })})");
            async Task<JsonElement> State()
            {
                await Send("getState"); await Task.Delay(120);
                return JsonDocument.Parse(await workspace.ExecuteScriptAsync("states.at(-1)")).RootElement.Clone();
            }
            async Task Navigate(string path, string expected)
            {
                await Send("open", fixture + path);
                await Until(() => browser.Source?.AbsolutePath == path && Status() == expected && !(bool)Field(window, "_browserLoading"), path + " expected " + expected);
                Check((await State()).GetProperty("status").GetString() == expected, path + " state bridge " + expected);
            }
            await Send("open", fixture + "/slow");
            await Send("close");
            await Task.Delay(2200);
            Check(!panel.IsVisible && !(await State()).GetProperty("visible").GetBoolean(), "close during initialization cannot reopen panel");
            await Navigate("/ok", "탐색 완료");
            Check((await State()).GetProperty("visible").GetBoolean(), "native browser visible acknowledged by shell");
            void Layout(string label)
            {
                window.UpdateLayout();
                var origin = workspace.PointToScreen(new System.Windows.Point(workspace.ActualWidth * .55, workspace.ActualHeight * .12));
                var right = browser.PointToScreen(new System.Windows.Point(0, 0));
                Check(Math.Abs(origin.X - right.X) < 2 && Math.Abs(origin.Y - right.Y) < 2 && browser.ActualWidth > 200, label + " native browser matches reserved DOM slot");
                Check(Math.Abs(workspace.ActualWidth - ((FrameworkElement)window.FindName("BrowserLayout")).ActualWidth) < 1, label + " no extra Preview/native column");
                var p = browser.PointToScreen(new System.Windows.Point(browser.ActualWidth / 2, browser.ActualHeight / 2));
                var hit = WindowFromPoint(new Point { X = (int)p.X, Y = (int)p.Y });
                GetWindowThreadProcessId(hit, out var process);
                Console.WriteLine($"HIT {label}: screen={p}, hwnd={hit}, pid={process}, browser={browser.CoreWebView2.BrowserProcessId}, workspace={workspace.CoreWebView2.BrowserProcessId}");
                Check(process == browser.CoreWebView2.BrowserProcessId, label + " native hit belongs to browser HWND (not workspace)");
                Check(GetAncestor(hit, 2) == new System.Windows.Interop.WindowInteropHelper(window).Handle, label + " hit is inside this test window");
            }
            await Task.Delay(400); Layout("1100px");
            Click(browser, browser.ActualWidth / 2, browser.ActualHeight / 2);
            await Until(() => browser.CoreWebView2.DocumentTitle == "clicked", "native mouse input");
            Check(browser.CoreWebView2.DocumentTitle == "clicked", "real mouse click reaches web page");
            Click(workspace, workspace.ActualWidth * .12, workspace.ActualHeight * .3);
            await Until(() => workspace.CoreWebView2.DocumentTitle == "chat clicked", "composition workspace mouse input");
            Check(workspace.CoreWebView2.DocumentTitle == "chat clicked", "real mouse click reaches composition workspace outside slot");
            await workspace.ExecuteScriptAsync("surface(false)"); await Task.Delay(150);
            Check(!panel.IsVisible, "document/modal/close hides native surface without unloading page");
            await workspace.ExecuteScriptAsync("surface(true)"); await Task.Delay(150);
            Check(panel.IsVisible && browser.CoreWebView2.DocumentTitle == "clicked", "reopen restores page state without navigating");
            window.Width = 640; await Task.Delay(400); Layout("640px minimum");
            window.Width = 1400; await Task.Delay(400); Layout("1400px resize");
            await Navigate("/missing", "페이지 응답 오류 (HTTP 404)");
            using (var unused = new TcpListener(IPAddress.Loopback, 0))
            {
                unused.Start(); var closedPort = ((IPEndPoint)unused.LocalEndpoint).Port; unused.Stop();
                await Send("open", $"http://127.0.0.1:{closedPort}/");
                await Until(() => Status().Contains("페이지를 불러오지 못했습니다."), "network error state");
                var failed = await State();
                Check(!failed.GetProperty("loading").GetBoolean() && !failed.GetProperty("status").GetString()!.Contains("탐색 완료"), "network failure is not navigation success");
            }
            await Navigate("/first", "탐색 완료");
            await Navigate("/second", "탐색 완료");
            Check((await State()).GetProperty("canGoBack").GetBoolean(), "history enabled");
            await Send("back");
            await Until(() => browser.Source?.AbsolutePath == "/first" && !(bool)Field(window, "_browserLoading"), "back");
            await Send("forward");
            await Until(() => browser.Source?.AbsolutePath == "/second" && !(bool)Field(window, "_browserLoading"), "forward");
            await Send("reload"); await Task.Delay(300);
            Check(Status() == "탐색 완료", "back / forward / reload");
            await Send("open", fixture + "/slow");
            await Until(() => (bool)Field(window, "_browserLoading"), "slow navigation started");
            await Send("open", fixture + "/newest");
            await Until(() => browser.Source?.AbsolutePath == "/newest" && Status() == "탐색 완료", "latest navigation wins");
            await Task.Delay(2000);
            Check(Status() == "탐색 완료", "superseded completion cannot corrupt new state");
            await Send("open", fixture + "/slow");
            await Until(() => (bool)Field(window, "_browserLoading"), "slow before close");
            await Send("close"); await Task.Delay(2100);
            var closed = await State();
            Check(!closed.GetProperty("visible").GetBoolean() && !closed.GetProperty("loading").GetBoolean() && closed.GetProperty("status").GetString() == "닫힘", "close stays closed after pending completion");
            Check(Math.Abs(workspace.ActualWidth - ((FrameworkElement)window.FindName("BrowserLayout")).ActualWidth) < 1, "close restores full workspace width");
            await Navigate("/reopened", "탐색 완료"); await Task.Delay(200); Layout("reopen");
            await Send("resume", fixture + "/resumed-new-url");
            await Until(() => browser.Source?.AbsolutePath == "/resumed-new-url" && Status() == "탐색 완료", "resume changed URL");
            Check(true, "local to external mode change navigates new URL");
            workspace.ZoomFactor = 1.25; await Task.Delay(350); Layout("125% zoom");
            workspace.ZoomFactor = 1.5; await Task.Delay(350); Layout("150% zoom");
            workspace.ZoomFactor = 1;
            if (Environment.GetCommandLineArgs().Contains("--apple"))
            {
                await Send("open", "https://developer.apple.com/design/human-interface-guidelines");
                await Until(() => browser.CoreWebView2.DocumentTitle.Contains("Human Interface Guidelines") && Status() == "탐색 완료" && !(bool)Field(window, "_browserLoading"), "live Apple HIG navigation", 60000);
                await Task.Delay(500); Layout("live Apple HIG");
                Check((await browser.ExecuteScriptAsync("document.body.innerText")).Contains("Human Interface Guidelines"), "live Apple HIG document rendered");
            }
            Console.WriteLine("PASS ALL native browser regression checks");
        }
        finally
        {
            Set(placement, "_tracking", false);
            ((DispatcherTimer)Field(placement, "_saveTimer")).Stop();
            Set(window, "_allowExit", true);
            browser.Dispose(); workspace.Dispose(); window.Close();
            server.Stop();
            Console.WriteLine("Isolated runtime data: " + root);
        }
    }
}
