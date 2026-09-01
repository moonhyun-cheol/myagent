using System.Net.Http;
using System.Text.Json;
using System.Windows;
using Application = System.Windows.Application;
using MessageBox = System.Windows.MessageBox;

namespace CqrPa.Shell;

internal static class UpdateApplyCoordinator
{
    internal static async Task RunPromptDownloadAndApplyAsync(
        Window owner,
        UpdateService updateService,
        AvailableUpdate update,
        CancellationToken cancellationToken)
    {
        if (owner is MainWindow mainWindow) mainWindow.RestoreFromTray();
        else
        {
            owner.Show();
            owner.Activate();
        }

        var notes = string.IsNullOrWhiteSpace(update.ReleaseNotes)
            ? "안정성 개선 및 최신 구성요소가 포함되어 있습니다."
            : update.ReleaseNotes.Trim();
        if (notes.Length > 1200) notes = notes[..1200] + "…";
        var accepted = MessageBox.Show(
            owner,
            $"MY Agent {update.Version} 업데이트가 있습니다.\n\n{notes}\n\n"
            + "지금 다운로드하고 다시 시작할까요?",
            "MY Agent 업데이트",
            MessageBoxButton.YesNo,
            MessageBoxImage.Information,
            MessageBoxResult.Yes);
        if (accepted != MessageBoxResult.Yes)
            throw new UpdatePromptDeclinedException();

        using var downloadCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var userCanceledDownload = false;
        var updaterLaunched = false;
        UpdateProgressWindow? progressWindow = null;
        try
        {
            progressWindow = new UpdateProgressWindow { Owner = owner };
            progressWindow.Canceled += () =>
            {
                userCanceledDownload = true;
                downloadCancellation.Cancel();
            };
            progressWindow.Show();
            owner.IsEnabled = false;
            var downloaded = await updateService.DownloadAsync(
                update,
                downloadCancellation.Token,
                progressWindow);
            progressWindow.SetStatus("설치를 시작하고 앱을 다시 실행합니다…");
            progressWindow.DisableCancel();
            progressWindow.AllowClose();
            if (owner is MainWindow updateMainWindow) updateMainWindow.PrepareForUpdateExit();
            updateService.LaunchUpdater(downloaded);
            updaterLaunched = true;
            progressWindow.Close();
            Application.Current.Shutdown(0);
        }
        catch (OperationCanceledException) when (userCanceledDownload)
        {
            ShowUpdateMessage(owner, "업데이트를 취소했습니다. 기존 버전으로 계속 실행합니다.");
            throw;
        }
        catch (UpdateTooOldException error)
        {
            updateService.LogFailure("minimum-sequence", error);
            ShowUpdateMessage(owner, error.Message);
            throw;
        }
        catch (InvalidDataException error)
        {
            updateService.LogFailure("security", error);
            ShowUpdateMessage(
                owner,
                "업데이트 파일의 서명을 확인할 수 없어 설치하지 않았습니다. 기존 버전은 그대로 실행됩니다.");
            throw;
        }
        catch (HttpRequestException error)
        {
            updateService.LogFailure("network", error);
            ShowUpdateMessage(
                owner,
                "업데이트를 다운로드하지 못했습니다. 네트워크를 확인한 뒤 다시 시작해 주세요.\n\n"
                + error.Message);
            throw;
        }
        catch (TaskCanceledException error)
        {
            updateService.LogFailure("timeout", error);
            if (!userCanceledDownload)
            {
                ShowUpdateMessage(
                    owner,
                    "업데이트 다운로드가 너무 오래 걸려 중단되었습니다. 네트워크를 확인한 뒤 다시 시작해 주세요.");
            }
            throw;
        }
        catch (Exception error) when (error is not UpdatePromptDeclinedException)
        {
            updateService.LogFailure("unexpected", error);
            ShowUpdateMessage(
                owner,
                "업데이트를 적용하지 못했습니다. 기존 버전으로 계속 실행합니다.\n\n"
                + error.Message);
            throw;
        }
        finally
        {
            if (progressWindow is not null && !updaterLaunched)
            {
                progressWindow.AllowClose();
                progressWindow.Close();
            }
            if (owner.IsVisible) owner.IsEnabled = true;
        }
    }

    internal static void ShowUpdateMessage(Window owner, string message)
    {
        if (owner is MainWindow mainWindow) mainWindow.RestoreFromTray();
        if (owner.IsVisible)
        {
            MessageBox.Show(
                owner,
                message,
                "MY Agent 업데이트",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
            return;
        }
        MessageBox.Show(
            message,
            "MY Agent 업데이트",
            MessageBoxButton.OK,
            MessageBoxImage.Warning);
    }
}

internal sealed class UpdatePromptDeclinedException : Exception
{
    public UpdatePromptDeclinedException() : base("Update prompt declined.") { }
}

internal sealed class UpdatePollingService : IDisposable
{
    private const int DefaultPollMs = 60 * 60 * 1000;
    private const int MinPollMs = 15 * 60 * 1000;
    private const int MaxPollMs = 24 * 60 * 60 * 1000;
    private const int DefaultIdleWatchMs = 60 * 1000;
    private const int DefaultSnoozeMs = 24 * 60 * 60 * 1000;

    private readonly MainWindow _owner;
    private readonly string _root;
    private readonly int _port;
    private readonly UpdateService _updateService;
    private readonly HttpClient _gateClient;
    private readonly object _sync = new();
    private System.Windows.Threading.DispatcherTimer? _feedPollTimer;
    private System.Windows.Threading.DispatcherTimer? _idleWatchTimer;
    private AvailableUpdate? _pendingUpdate;
    private DateTime _snoozeUntilUtc = DateTime.MinValue;
    private bool _promptInFlight;
    private bool _disposed;

    private bool _feedPollEnabled = true;

    public void ApplySettings(bool enabled, int? pollIntervalMs = null)
    {
        lock (_sync)
        {
            _feedPollEnabled = enabled;
        }
        if (pollIntervalMs is int intervalMs)
        {
            var clamped = Math.Clamp(intervalMs, MinPollMs, MaxPollMs);
            if (_feedPollTimer is not null)
                _feedPollTimer.Interval = TimeSpan.FromMilliseconds(clamped);
        }
        if (!enabled)
        {
            _feedPollTimer?.Stop();
            return;
        }
        if (_feedPollTimer is null)
            StartFeedPollTimer();
        else
            _feedPollTimer.Start();
    }

    public UpdatePollingService(MainWindow owner, string root, int port, UpdateService updateService)
    {
        _owner = owner;
        _root = root;
        _port = port;
        _updateService = updateService;
        _gateClient = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(5),
        };
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        Microsoft.Win32.SystemEvents.PowerModeChanged += OnPowerModeChanged;
        await Task.Delay(750, cancellationToken);
        await CheckFeedAsync(cancellationToken);
        StartFeedPollTimer();
    }

    public void TriggerFeedCheck()
    {
        _ = RunOnUiThreadAsync(async () =>
        {
            try
            {
                await CheckFeedAsync(CancellationToken.None);
            }
            catch
            {
                /* silent */
            }
        });
    }

    private void OnPowerModeChanged(object? sender, Microsoft.Win32.PowerModeChangedEventArgs e)
    {
        if (e.Mode != Microsoft.Win32.PowerModes.Resume) return;
        TriggerFeedCheck();
    }

    private void StartFeedPollTimer()
    {
        var interval = TimeSpan.FromMilliseconds(ReadPollIntervalMs());
        _feedPollTimer = new System.Windows.Threading.DispatcherTimer
        {
            Interval = interval,
        };
        _feedPollTimer.Tick += (_, _) =>
        {
            if (!_feedPollEnabled) return;
            TriggerFeedCheck();
        };
        if (_feedPollEnabled) _feedPollTimer.Start();
    }

    private void EnsureIdleWatchTimer()
    {
        if (_idleWatchTimer is not null) return;
        _idleWatchTimer = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(ReadIdleWatchMs()),
        };
        _idleWatchTimer.Tick += (_, _) => _ = RunOnUiThreadAsync(TryPromptWhenIdleAsync);
        _idleWatchTimer.Start();
    }

    private void StopIdleWatchTimer()
    {
        _idleWatchTimer?.Stop();
        _idleWatchTimer = null;
    }

    private async Task CheckFeedAsync(CancellationToken cancellationToken)
    {
        if (!_feedPollEnabled) return;
        var update = await _updateService.CheckAsync(cancellationToken);
        lock (_sync)
        {
            if (update is null)
            {
                _pendingUpdate = null;
                StopIdleWatchTimer();
                return;
            }
            _pendingUpdate = update;
        }
        EnsureIdleWatchTimer();
        await TryPromptWhenIdleAsync();
    }

    private async Task TryPromptWhenIdleAsync()
    {
        AvailableUpdate? pending;
        lock (_sync)
        {
            pending = _pendingUpdate;
            if (pending is null || _promptInFlight) return;
            if (DateTime.UtcNow < _snoozeUntilUtc) return;
        }

        if (!await QueryUpdateGateAsync(CancellationToken.None)) return;

        lock (_sync)
        {
            if (_pendingUpdate is null || _promptInFlight) return;
            _promptInFlight = true;
        }

        try
        {
            await UpdateApplyCoordinator.RunPromptDownloadAndApplyAsync(
                _owner,
                _updateService,
                pending,
                CancellationToken.None);
        }
        catch (UpdatePromptDeclinedException)
        {
            lock (_sync)
            {
                _snoozeUntilUtc = DateTime.UtcNow.AddMilliseconds(ReadSnoozeMs());
            }
        }
        catch
        {
            /* errors already surfaced */
        }
        finally
        {
            lock (_sync)
            {
                _promptInFlight = false;
            }
        }
    }

    private async Task<bool> QueryUpdateGateAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var response = await _gateClient.GetAsync(
                $"http://127.0.0.1:{_port}/system/update-gate",
                cancellationToken);
            if (!response.IsSuccessStatusCode) return false;
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
            return doc.RootElement.TryGetProperty("ready", out var ready)
                && ready.ValueKind == JsonValueKind.True;
        }
        catch
        {
            return false;
        }
    }

    private Task RunOnUiThreadAsync(Func<Task> action)
    {
        return _owner.Dispatcher.InvokeAsync(action).Task.Unwrap();
    }

    private static int ReadPollIntervalMs()
    {
        return ClampInterval(
            Environment.GetEnvironmentVariable("MY_AGENT_UPDATE_POLL_INTERVAL_MS"),
            DefaultPollMs,
            MinPollMs,
            MaxPollMs);
    }

    private static int ReadIdleWatchMs()
    {
        return ClampInterval(
            Environment.GetEnvironmentVariable("MY_AGENT_UPDATE_IDLE_WATCH_MS"),
            DefaultIdleWatchMs,
            15_000,
            5 * 60 * 1000);
    }

    private static int ReadSnoozeMs()
    {
        return ClampInterval(
            Environment.GetEnvironmentVariable("MY_AGENT_UPDATE_IDLE_PROMPT_SNOOZE_MS"),
            DefaultSnoozeMs,
            60 * 60 * 1000,
            7 * 24 * 60 * 60 * 1000);
    }

    private static int ClampInterval(string? raw, int fallback, int min, int max)
    {
        if (int.TryParse(raw, out var value))
            return Math.Clamp(value, min, max);
        return fallback;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Microsoft.Win32.SystemEvents.PowerModeChanged -= OnPowerModeChanged;
        _feedPollTimer?.Stop();
        StopIdleWatchTimer();
        _gateClient.Dispose();
    }
}
