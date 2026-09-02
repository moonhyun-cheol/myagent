using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Windows;
using MessageBox = System.Windows.MessageBox;

namespace CqrPa.Shell;

internal sealed record WorkEnvironmentPendingState(
    bool LauncherUpdateAvailable,
    string? LauncherVersion,
    string? LauncherNotes,
    bool CatalogUpdateAvailable,
    int? CatalogFeedSequence,
    int? CatalogCachedSequence)
{
    public bool AnyPending => LauncherUpdateAvailable || CatalogUpdateAvailable;
}

internal static class WorkEnvironmentUpdateCoordinator
{
    internal static async Task RunPromptAndApplyAsync(
        Window owner,
        int port,
        WorkEnvironmentPendingState pending,
        CancellationToken cancellationToken)
    {
        if (owner is MainWindow mainWindow) mainWindow.RestoreFromTray();
        else
        {
            owner.Show();
            owner.Activate();
        }

        var lines = new List<string>();
        if (pending.LauncherUpdateAvailable)
        {
            var version = string.IsNullOrWhiteSpace(pending.LauncherVersion)
                ? "새 버전"
                : pending.LauncherVersion.Trim();
            lines.Add($"• 작업 환경 프로그램(WorkKitLauncher) {version}");
        }
        if (pending.CatalogUpdateAvailable)
        {
            lines.Add("• 작업 키트 목록(프로필 카탈로그)");
        }
        var notes = string.Join('\n', lines);
        if (!string.IsNullOrWhiteSpace(pending.LauncherNotes) && pending.LauncherUpdateAvailable)
        {
            var trimmed = pending.LauncherNotes.Trim();
            if (trimmed.Length > 600) trimmed = trimmed[..600] + "…";
            notes += $"\n\n{trimmed}";
        }
        var accepted = MessageBox.Show(
            owner,
            $"작업 환경 업데이트가 있습니다.\n\n{notes}\n\n"
            + "지금 다운로드하고 적용할까요? MY Agent 채팅은 그대로 둡니다.",
            "작업 환경 업데이트",
            MessageBoxButton.YesNo,
            MessageBoxImage.Information,
            MessageBoxResult.Yes);
        if (accepted != MessageBoxResult.Yes)
            throw new WorkEnvironmentUpdatePromptDeclinedException();

        owner.IsEnabled = false;
        try
        {
            if (pending.CatalogUpdateAvailable)
            {
                await RefreshCatalogAsync(port, cancellationToken);
            }
            if (pending.LauncherUpdateAvailable)
            {
                LaunchCompanionUpdate(owner);
            }
            ShowMessage(
                owner,
                pending.LauncherUpdateAvailable
                    ? "작업 환경 업데이트를 시작했습니다. 완료 후 작업 환경을 다시 열 수 있습니다."
                    : "작업 키트 목록을 최신으로 가져왔습니다. 작업 환경에서 받기·적용하세요.");
        }
        finally
        {
            if (owner.IsVisible) owner.IsEnabled = true;
        }
    }

    private static async Task RefreshCatalogAsync(int port, CancellationToken cancellationToken)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
        using var response = await client.PostAsync(
            $"http://127.0.0.1:{port}/profiles/catalog/refresh",
            new StringContent("{}", Encoding.UTF8, "application/json"),
            cancellationToken);
        response.EnsureSuccessStatusCode();
    }

    private static void LaunchCompanionUpdate(Window owner)
    {
        var root = owner is MainWindow mainWindow ? mainWindow.CqrRoot : CqrPaths.ResolveCqrRoot();
        var exe = FindLauncherExecutable(root);
        if (exe is null)
        {
            throw new InvalidOperationException("WorkKitLauncher.exe를 찾지 못했습니다.");
        }
        var start = new ProcessStartInfo
        {
            FileName = exe,
            WorkingDirectory = Path.GetDirectoryName(exe) ?? root,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add("--companion-update");
        start.Environment["MY_AGENT_ROOT"] = root;
        _ = Process.Start(start)
            ?? throw new InvalidOperationException("작업 환경 업데이트를 시작하지 못했습니다.");
    }

    internal static string? FindLauncherExecutable(string root)
    {
        foreach (var candidate in new[]
        {
            Path.Combine(root, "WorkKitLauncher.exe"),
            Path.Combine(root, "bin", "work-kit-launcher", "WorkKitLauncher.exe"),
        })
        {
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    internal static void ShowMessage(Window owner, string message)
    {
        if (owner is MainWindow mainWindow) mainWindow.RestoreFromTray();
        MessageBox.Show(
            owner,
            message,
            "작업 환경 업데이트",
            MessageBoxButton.OK,
            MessageBoxImage.Information);
    }
}

internal sealed class WorkEnvironmentUpdatePromptDeclinedException : Exception
{
    public WorkEnvironmentUpdatePromptDeclinedException() : base("Work environment update prompt declined.") { }
}

internal sealed class WorkEnvironmentUpdatePollingService : IDisposable
{
    private const int DefaultPollMs = 60 * 60 * 1000;
    private const int MinPollMs = 15 * 60 * 1000;
    private const int MaxPollMs = 24 * 60 * 60 * 1000;
    private const int DefaultIdleWatchMs = 60 * 1000;
    private const int DefaultSnoozeMs = 24 * 60 * 60 * 1000;

    private readonly MainWindow _owner;
    private readonly int _port;
    private readonly HttpClient _http;
    private readonly HttpClient _gateClient;
    private readonly object _sync = new();
    private System.Windows.Threading.DispatcherTimer? _feedPollTimer;
    private System.Windows.Threading.DispatcherTimer? _idleWatchTimer;
    private WorkEnvironmentPendingState? _pending;
    private DateTime _snoozeUntilUtc = DateTime.MinValue;
    private bool _promptInFlight;
    private bool _disposed;
    private bool _feedPollEnabled = true;

    public WorkEnvironmentUpdatePollingService(MainWindow owner, int port)
    {
        _owner = owner;
        _port = port;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(25) };
        _gateClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (string.Equals(
                Environment.GetEnvironmentVariable("MY_AGENT_UPDATE_CHECK"),
                "0",
                StringComparison.OrdinalIgnoreCase))
        {
            return;
        }
        if (WorkEnvironmentUpdateCoordinator.FindLauncherExecutable(_owner.CqrRoot) is null)
        {
            return;
        }

        Microsoft.Win32.SystemEvents.PowerModeChanged += OnPowerModeChanged;
        await Task.Delay(1500, cancellationToken);
        await CheckPendingAsync(cancellationToken);
        StartFeedPollTimer();
    }

    private void OnPowerModeChanged(object? sender, Microsoft.Win32.PowerModeChangedEventArgs e)
    {
        if (e.Mode != Microsoft.Win32.PowerModes.Resume) return;
        TriggerPendingCheck();
    }

    private void StartFeedPollTimer()
    {
        var interval = TimeSpan.FromMilliseconds(ReadPollIntervalMs());
        _feedPollTimer = new System.Windows.Threading.DispatcherTimer { Interval = interval };
        _feedPollTimer.Tick += (_, _) =>
        {
            if (!_feedPollEnabled) return;
            TriggerPendingCheck();
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

    public void TriggerPendingCheck()
    {
        _ = RunOnUiThreadAsync(async () =>
        {
            try
            {
                await CheckPendingAsync(CancellationToken.None);
            }
            catch
            {
                /* silent */
            }
        });
    }

    private async Task CheckPendingAsync(CancellationToken cancellationToken)
    {
        if (!_feedPollEnabled) return;
        WorkEnvironmentPendingState? pending;
        try
        {
            pending = await FetchPendingAsync(cancellationToken);
        }
        catch
        {
            return;
        }
        lock (_sync)
        {
            if (pending is null || !pending.AnyPending)
            {
                _pending = null;
                StopIdleWatchTimer();
                return;
            }
            _pending = pending;
        }
        EnsureIdleWatchTimer();
        await TryPromptWhenIdleAsync();
    }

    private async Task<WorkEnvironmentPendingState?> FetchPendingAsync(CancellationToken cancellationToken)
    {
        using var response = await _http.GetAsync(
            $"http://127.0.0.1:{_port}/system/work-environment/pending",
            cancellationToken);
        if (!response.IsSuccessStatusCode) return null;
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = doc.RootElement;
        var launcher = root.GetProperty("launcher");
        var catalog = root.GetProperty("catalog");
        return new WorkEnvironmentPendingState(
            launcher.TryGetProperty("update_available", out var launcherAvailable)
                && launcherAvailable.ValueKind == JsonValueKind.True,
            launcher.TryGetProperty("version", out var launcherVersion) && launcherVersion.ValueKind == JsonValueKind.String
                ? launcherVersion.GetString()
                : null,
            launcher.TryGetProperty("release_notes", out var launcherNotes) && launcherNotes.ValueKind == JsonValueKind.String
                ? launcherNotes.GetString()
                : null,
            catalog.TryGetProperty("update_available", out var catalogAvailable)
                && catalogAvailable.ValueKind == JsonValueKind.True,
            catalog.TryGetProperty("feed_sequence", out var feedSeq) && feedSeq.TryGetInt32(out var feedSequence)
                ? feedSequence
                : null,
            catalog.TryGetProperty("cached_sequence", out var cachedSeq) && cachedSeq.TryGetInt32(out var cachedSequence)
                ? cachedSequence
                : null);
    }

    private async Task TryPromptWhenIdleAsync()
    {
        WorkEnvironmentPendingState? pending;
        lock (_sync)
        {
            pending = _pending;
            if (pending is null || _promptInFlight) return;
            if (DateTime.UtcNow < _snoozeUntilUtc) return;
        }

        if (!await QueryUpdateGateAsync(CancellationToken.None)) return;

        lock (_sync)
        {
            if (_pending is null || _promptInFlight) return;
            _promptInFlight = true;
        }

        try
        {
            await WorkEnvironmentUpdateCoordinator.RunPromptAndApplyAsync(
                _owner,
                _port,
                pending,
                CancellationToken.None);
            lock (_sync)
            {
                _pending = null;
            }
            StopIdleWatchTimer();
        }
        catch (WorkEnvironmentUpdatePromptDeclinedException)
        {
            lock (_sync)
            {
                _snoozeUntilUtc = DateTime.UtcNow.AddMilliseconds(ReadSnoozeMs());
            }
        }
        catch
        {
            /* surfaced in coordinator */
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
            Environment.GetEnvironmentVariable("MY_AGENT_COMPANION_UPDATE_POLL_INTERVAL_MS")
            ?? Environment.GetEnvironmentVariable("MY_AGENT_UPDATE_POLL_INTERVAL_MS"),
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
        _http.Dispose();
        _gateClient.Dispose();
    }
}
