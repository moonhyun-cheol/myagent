using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace CqrPa.Shell;

/// <summary>Private same-user IPC client used only for the external-page BrowserWebView.</summary>
internal sealed class VisibleBrowserAutomationClient : IDisposable
{
    private readonly string _pipeName;
    private readonly Func<JsonElement, Task<object>> _handler;
    private readonly CancellationTokenSource _stop = new();
    private Task? _run;

    internal VisibleBrowserAutomationClient(int port, Func<JsonElement, Task<object>> handler)
    {
        _pipeName = $"my-agent-visible-browser-{port}";
        _handler = handler;
    }

    internal void Start() => _run ??= Task.Run(RunAsync);

    private async Task RunAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            try
            {
                await using var pipe = new NamedPipeClientStream(
                    ".", _pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
                await pipe.ConnectAsync(3000, _stop.Token);
                using var reader = new StreamReader(pipe, Encoding.UTF8, false, 4096, leaveOpen: true);
                await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, leaveOpen: true)
                {
                    AutoFlush = true,
                    NewLine = "\n",
                };
                while (!_stop.IsCancellationRequested && pipe.IsConnected)
                {
                    var line = await reader.ReadLineAsync(_stop.Token);
                    if (line is null) break;
                    await HandleLineAsync(line, writer);
                }
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested)
            {
                break;
            }
            catch
            {
                try { await Task.Delay(750, _stop.Token); }
                catch (OperationCanceledException) { break; }
            }
        }
    }

    private async Task HandleLineAsync(string line, StreamWriter writer)
    {
        string? id = null;
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (!root.TryGetProperty("type", out var type) || type.GetString() != "command") return;
            id = root.TryGetProperty("id", out var idProperty) ? idProperty.GetString() : null;
            if (string.IsNullOrWhiteSpace(id)) return;
            var result = await _handler(root.Clone());
            await writer.WriteLineAsync(JsonSerializer.Serialize(new { type = "result", id, ok = true, result }));
        }
        catch (Exception ex)
        {
            if (!string.IsNullOrWhiteSpace(id))
                await writer.WriteLineAsync(JsonSerializer.Serialize(new { type = "result", id, ok = false, error = ex.Message }));
        }
    }

    public void Dispose()
    {
        _stop.Cancel();
    }
}
