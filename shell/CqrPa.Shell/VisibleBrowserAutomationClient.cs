using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace CqrPa.Shell;

/// <summary>Private same-user IPC client used only for the external-page BrowserWebView.</summary>
internal sealed class VisibleBrowserAutomationClient : IDisposable
{
    private const int CommandTimeoutMs = 15_000;
    private const int MaxPendingCommands = 16;
    private readonly string _pipeName;
    private readonly Func<JsonElement, CancellationToken, Task<object>> _handler;
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _executionGate = new(1, 1);
    private readonly SemaphoreSlim _writerGate = new(1, 1);
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _inflight = new();
    private readonly object _orphanGate = new();
    private Task<object>? _orphanedCommand;
    private int _pendingCommands;
    private Task? _run;

    internal VisibleBrowserAutomationClient(int port, Func<JsonElement, CancellationToken, Task<object>> handler)
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
                using var connectionStop = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
                try
                {
                    while (!_stop.IsCancellationRequested && pipe.IsConnected)
                    {
                        var line = await reader.ReadLineAsync(_stop.Token);
                        if (line is null) break;
                        DispatchLine(line, writer, connectionStop.Token);
                    }
                }
                finally
                {
                    connectionStop.Cancel();
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

    private void DispatchLine(string line, StreamWriter writer, CancellationToken connectionToken)
    {
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            var messageType = root.TryGetProperty("type", out var type) ? type.GetString() : null;
            var id = root.TryGetProperty("id", out var idProperty) ? idProperty.GetString() : null;
            if (string.IsNullOrWhiteSpace(id)) return;
            if (messageType == "cancel")
            {
                if (_inflight.TryGetValue(id, out var pending)) pending.Cancel();
                return;
            }
            if (messageType != "command") return;
            if (Interlocked.Increment(ref _pendingCommands) > MaxPendingCommands)
            {
                Interlocked.Decrement(ref _pendingCommands);
                _ = WriteResultAsync(writer, id, false, null, "VISIBLE_BROWSER_QUEUE_SATURATED");
                return;
            }
            var cancellation = new CancellationTokenSource();
            if (!_inflight.TryAdd(id, cancellation))
            {
                cancellation.Dispose();
                Interlocked.Decrement(ref _pendingCommands);
                _ = WriteResultAsync(writer, id, false, null, "VISIBLE_BROWSER_DUPLICATE_COMMAND");
                return;
            }
            _ = ExecuteCommandAsync(root.Clone(), id, writer, cancellation, connectionToken);
        }
        catch
        {
            // Ignore malformed transport messages without dropping the connection.
        }
    }

    private async Task ExecuteCommandAsync(
        JsonElement command,
        string id,
        StreamWriter writer,
        CancellationTokenSource commandCancellation,
        CancellationToken connectionToken)
    {
        var action = command.TryGetProperty("action", out var property) ? property.GetString() : null;
        var fastPath = action == "targets";
        using var deadline = new CancellationTokenSource(CommandTimeoutMs);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(
            _stop.Token, connectionToken, commandCancellation.Token, deadline.Token);
        var enteredExecutionGate = false;
        try
        {
            if (!fastPath)
            {
                await _executionGate.WaitAsync(linked.Token);
                enteredExecutionGate = true;
                lock (_orphanGate)
                {
                    if (_orphanedCommand is { IsCompleted: false })
                        throw new InvalidOperationException("VISIBLE_BROWSER_PREVIOUS_COMMAND_STILL_RUNNING");
                    _orphanedCommand = null;
                }
            }

            var handlerTask = _handler(command, linked.Token);
            try
            {
                var result = await handlerTask.WaitAsync(linked.Token);
                await WriteResultAsync(writer, id, true, result, null);
            }
            catch (OperationCanceledException) when (deadline.IsCancellationRequested)
            {
                if (!handlerTask.IsCompleted && !fastPath)
                {
                    lock (_orphanGate) _orphanedCommand = handlerTask;
                }
                await WriteResultAsync(writer, id, false, null, "VISIBLE_BROWSER_COMMAND_TIMEOUT");
            }
            catch (OperationCanceledException)
            {
                if (!handlerTask.IsCompleted && !fastPath)
                {
                    lock (_orphanGate) _orphanedCommand = handlerTask;
                }
                throw;
            }
        }
        catch (OperationCanceledException) when (!_stop.IsCancellationRequested)
        {
            await WriteResultAsync(writer, id, false, null, "VISIBLE_BROWSER_COMMAND_CANCELLED");
        }
        catch (Exception ex)
        {
            await WriteResultAsync(writer, id, false, null, ex.Message);
        }
        finally
        {
            if (enteredExecutionGate) _executionGate.Release();
            _inflight.TryRemove(id, out _);
            commandCancellation.Dispose();
            Interlocked.Decrement(ref _pendingCommands);
        }
    }

    private async Task WriteResultAsync(
        StreamWriter writer,
        string id,
        bool ok,
        object? result,
        string? error)
    {
        try
        {
            await _writerGate.WaitAsync(_stop.Token);
            try
            {
                var message = ok
                    ? JsonSerializer.Serialize(new { type = "result", id, ok = true, result })
                    : JsonSerializer.Serialize(new { type = "result", id, ok = false, error });
                await writer.WriteLineAsync(message);
            }
            finally
            {
                _writerGate.Release();
            }
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
    }

    public void Dispose()
    {
        _stop.Cancel();
        foreach (var pending in _inflight.Values) pending.Cancel();
    }
}
