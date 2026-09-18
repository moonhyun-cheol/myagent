using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Windows;
using WpfDataFormats = System.Windows.DataFormats;
using WpfDataObject = System.Windows.IDataObject;
using WpfDragEventArgs = System.Windows.DragEventArgs;
using WpfDragEventHandler = System.Windows.DragEventHandler;
using WpfDragDropEffects = System.Windows.DragDropEffects;

namespace CqrPa.Shell;

public partial class MainWindow
{
    private readonly Dictionary<string, string[]> _externalFileDrops = new(StringComparer.Ordinal);

    private void InitializeExternalFileDrop()
    {
        AddHandler(DragDrop.DragEnterEvent, new WpfDragEventHandler(OnExternalFileDragEnter), true);
        AddHandler(DragDrop.DragOverEvent, new WpfDragEventHandler(OnExternalFileDragOver), true);
        AddHandler(DragDrop.DragLeaveEvent, new WpfDragEventHandler(OnExternalFileDragLeave), true);
        AddHandler(DragDrop.DropEvent, new WpfDragEventHandler(OnExternalFileDrop), true);
    }

    private static string[] ExternalFiles(WpfDataObject data) =>
        data.GetDataPresent(WpfDataFormats.FileDrop)
            ? (data.GetData(WpfDataFormats.FileDrop) as string[] ?? [])
                .Where(File.Exists)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            : [];

    private void OnExternalFileDragEnter(object sender, WpfDragEventArgs e) => UpdateExternalFileDrag(e);

    private void OnExternalFileDragOver(object sender, WpfDragEventArgs e) => UpdateExternalFileDrag(e);

    private void UpdateExternalFileDrag(WpfDragEventArgs e)
    {
        var files = ExternalFiles(e.Data);
        if (files.Length == 0) return;
        e.Effects = WpfDragDropEffects.Copy;
        e.Handled = true;
        PostExternalDropState("dragging", null, null, null, e);
    }

    private void OnExternalFileDragLeave(object sender, WpfDragEventArgs e)
    {
        PostExternalDropState("idle", null, null, null);
    }

    private void OnExternalFileDrop(object sender, WpfDragEventArgs e)
    {
        var files = ExternalFiles(e.Data);
        if (files.Length == 0) return;
        e.Effects = WpfDragDropEffects.Copy;
        e.Handled = true;
        var requestId = Guid.NewGuid().ToString("N");
        if (_externalFileDrops.Count >= 32) _externalFileDrops.Clear();
        _externalFileDrops[requestId] = files;
        PostExternalDropState("request", requestId, files.Select(Path.GetFileName).ToArray(), null, e);
    }

    private void RejectExternalFileDrop(JsonElement message)
    {
        var requestId = message.TryGetProperty("requestId", out var requestProperty)
            ? requestProperty.GetString()
            : null;
        if (!string.IsNullOrWhiteSpace(requestId)) _externalFileDrops.Remove(requestId);
    }

    private async Task UploadExternalFileDropAsync(JsonElement message)
    {
        var requestId = message.TryGetProperty("requestId", out var requestProperty)
            ? requestProperty.GetString()
            : null;
        var sessionId = message.TryGetProperty("sessionId", out var sessionProperty)
            ? sessionProperty.GetString()
            : null;
        if (string.IsNullOrWhiteSpace(requestId)
            || string.IsNullOrWhiteSpace(sessionId)
            || !_externalFileDrops.Remove(requestId, out var files)) return;

        try
        {
            using var form = new MultipartFormDataContent();
            foreach (var path in files)
            {
                var content = new StreamContent(File.OpenRead(path));
                content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
                form.Add(content, "file", Path.GetFileName(path));
            }
            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
            using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{_port}/attachments")
            {
                Content = form,
            };
            request.Headers.Add("X-CQR-Session", sessionId);
            using var response = await http.SendAsync(request);
            var body = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
                throw new InvalidOperationException($"업로드 실패 ({(int)response.StatusCode})");
            using var parsed = JsonDocument.Parse(body);
            var attachments = parsed.RootElement.TryGetProperty("attachments", out var value)
                ? value.Clone()
                : JsonSerializer.SerializeToElement(Array.Empty<object>());
            PostExternalDropState("completed", requestId, null, new { sessionId, attachments });
        }
        catch (Exception ex)
        {
            PostExternalDropState("failed", requestId, null, new { sessionId, message = ex.Message });
        }
    }

    private void PostExternalDropState(
        string phase,
        string? requestId,
        string?[]? files,
        object? detail,
        WpfDragEventArgs? dragEvent = null)
    {
        double? xRatio = null;
        double? yRatio = null;
        if (dragEvent is not null && WebView.ActualWidth > 0 && WebView.ActualHeight > 0)
        {
            var point = dragEvent.GetPosition(WebView);
            xRatio = Math.Clamp(point.X / WebView.ActualWidth, 0, 1);
            yRatio = Math.Clamp(point.Y / WebView.ActualHeight, 0, 1);
        }
        var payload = JsonSerializer.Serialize(new
        {
            type = "composer.externalDrop",
            phase,
            requestId,
            files,
            xRatio,
            yRatio,
            detail,
        });
        _ = Dispatcher.InvokeAsync(() => WebView.CoreWebView2?.PostWebMessageAsJson(payload));
    }
}
