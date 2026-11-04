using System.Diagnostics;
using System.Windows.Threading;

namespace CqrPa.Shell;

/// <summary>
/// Background watchdog for "the window stopped responding" reports.
/// <list type="bullet">
/// <item>UI thread: posts a heartbeat to the WPF dispatcher every second. When it is not
/// processed for <see cref="UiHangThreshold"/>, writes <c>ui_hang</c> (and <c>ui_hang_end</c>
/// with the total duration once it recovers).</item>
/// <item>Local API: probes <c>/health</c>; after consecutive failures writes
/// <c>api_unresponsive</c> with the node process state, then <c>api_recovered</c>.</item>
/// <item>Self-recovery: when the shell-owned node process has <b>exited</b>, it is started
/// again (at most <see cref="ApiRestartBudget"/> times per <see cref="ApiRestartWindow"/>).
/// A node process that is still running but slow is never restarted, so in-flight chats are
/// not cut off. When the budget is used up the window is told to show the problem.</item>
/// </list>
/// PC sleep is detected by the watchdog's own wait overshooting and is not reported as a hang.
/// Writes go to <see cref="ShellStartupLog"/>. Must never throw.
/// </summary>
internal sealed class ShellHealthMonitor : IDisposable
{
    private static readonly TimeSpan Heartbeat = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan UiHangThreshold = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan ApiProbeInterval = TimeSpan.FromSeconds(15);
    private const int ApiFailThreshold = 2;
    private const int ApiRestartBudget = 3;
    private static readonly TimeSpan ApiRestartWindow = TimeSpan.FromMinutes(10);

    private readonly Dispatcher _dispatcher;
    private readonly ApiProcessHost _api;
    private readonly Action _onApiRestarted;
    private readonly Action _onApiGaveUp;
    private readonly Queue<DateTime> _apiRestarts = new();
    private readonly CancellationTokenSource _cts = new();
    private Thread? _thread;
    private long _lastBeat;
    private int _beatPending;

    public ShellHealthMonitor(Dispatcher dispatcher, ApiProcessHost api, Action onApiRestarted, Action onApiGaveUp)
    {
        _dispatcher = dispatcher;
        _api = api;
        _onApiRestarted = onApiRestarted;
        _onApiGaveUp = onApiGaveUp;
    }

    public void Start()
    {
        if (_thread is not null) return;
        _lastBeat = Stopwatch.GetTimestamp();
        _thread = new Thread(Run) { IsBackground = true, Name = "MYAgent health monitor" };
        _thread.Start();
    }

    private void Run()
    {
        var token = _cts.Token;
        var uiHung = false;
        var uiHangStarted = 0L;
        var apiFails = 0;
        var apiReported = false;
        var apiGaveUp = false;
        var nextApiProbe = Stopwatch.GetTimestamp() + ToTicks(ApiProbeInterval);

        while (!token.IsCancellationRequested)
        {
            try
            {
                if (Interlocked.CompareExchange(ref _beatPending, 1, 0) == 0)
                {
                    _dispatcher.BeginInvoke(DispatcherPriority.Normal, () =>
                    {
                        Interlocked.Exchange(ref _lastBeat, Stopwatch.GetTimestamp());
                        Interlocked.Exchange(ref _beatPending, 0);
                    });
                }

                var waitStarted = Stopwatch.GetTimestamp();
                if (token.WaitHandle.WaitOne(Heartbeat)) break;
                var now = Stopwatch.GetTimestamp();

                // The watchdog itself overslept: PC sleep/hibernate, not an app hang.
                if (Stopwatch.GetElapsedTime(waitStarted, now) > Heartbeat + UiHangThreshold)
                {
                    ShellStartupLog.Write($"system_gap: watchdog paused {Stopwatch.GetElapsedTime(waitStarted, now).TotalSeconds:F0}s (PC 절전 가능)");
                    Interlocked.Exchange(ref _lastBeat, now);
                    nextApiProbe = now + ToTicks(ApiProbeInterval);
                    continue;
                }

                var sinceBeat = Stopwatch.GetElapsedTime(Interlocked.Read(ref _lastBeat), now);
                if (!uiHung && sinceBeat > UiHangThreshold)
                {
                    uiHung = true;
                    uiHangStarted = Interlocked.Read(ref _lastBeat);
                    ShellStartupLog.Write($"ui_hang: 화면 스레드가 {sinceBeat.TotalSeconds:F0}초째 응답 없음 {DescribeShellProcess()} {_api.DescribeNodeProcess()}");
                }
                else if (uiHung && sinceBeat < Heartbeat + Heartbeat)
                {
                    uiHung = false;
                    ShellStartupLog.Write($"ui_hang_end: 화면 스레드 복구 (멈춤 약 {Stopwatch.GetElapsedTime(uiHangStarted, now).TotalSeconds:F0}초)");
                }

                if (now >= nextApiProbe)
                {
                    nextApiProbe = now + ToTicks(ApiProbeInterval);
                    if (_api.ProbeReady())
                    {
                        if (apiReported) ShellStartupLog.Write($"api_recovered: 로컬 서비스 응답 재개 {_api.DescribeNodeProcess()}");
                        apiFails = 0;
                        apiReported = false;
                        apiGaveUp = false;
                    }
                    else
                    {
                        if (++apiFails >= ApiFailThreshold && !apiReported)
                        {
                            apiReported = true;
                            ShellStartupLog.Write($"api_unresponsive: 로컬 서비스(/health port={_api.Port})가 {apiFails}회 연속 응답 없음 {_api.DescribeNodeProcess()}");
                        }
                        if (!apiGaveUp && _api.NeedsRestart && !token.IsCancellationRequested)
                        {
                            var outcome = TryRecoverApi(token);
                            if (outcome == RecoveryOutcome.Recovered)
                            {
                                apiFails = 0;
                                apiReported = false;
                            }
                            else if (outcome == RecoveryOutcome.BudgetExhausted || outcome == RecoveryOutcome.StartFailed)
                            {
                                apiGaveUp = true;
                                ShellStartupLog.Write(outcome == RecoveryOutcome.StartFailed
                                    ? $"api_gave_up: 로컬 서비스를 다시 시작하지 못함 ({_api.LastStartFailure ?? "unknown"})"
                                    : $"api_gave_up: 로컬 서비스가 {ApiRestartWindow.TotalMinutes:F0}분 안에 {ApiRestartBudget}회 넘게 종료돼 자동 재시작을 멈춤");
                                _dispatcher.BeginInvoke(_onApiGaveUp);
                            }
                        }
                        nextApiProbe = Stopwatch.GetTimestamp() + ToTicks(ApiProbeInterval);
                    }
                }
            }
            catch (Exception ex)
            {
                // Dispatcher shut down or similar: stop quietly after recording once.
                if (!token.IsCancellationRequested)
                    ShellStartupLog.WriteException("health monitor stopped", ex);
                return;
            }
        }
    }

    private static long ToTicks(TimeSpan span) => (long)(span.TotalSeconds * Stopwatch.Frequency);

    private bool CanRestartApi()
    {
        var cutoff = DateTime.UtcNow - ApiRestartWindow;
        while (_apiRestarts.Count > 0 && _apiRestarts.Peek() < cutoff) _apiRestarts.Dequeue();
        return _apiRestarts.Count < ApiRestartBudget;
    }

    private enum RecoveryOutcome { Recovered, Skipped, NotReadyYet, StartFailed, BudgetExhausted }

    /// <summary>Restart an exited node (never while the core updater is replacing files).</summary>
    private RecoveryOutcome TryRecoverApi(CancellationToken token)
    {
        if (ShellProblems.IsUpdaterRunning())
        {
            ShellStartupLog.Write("api_restart: skipped (업데이트 진행 중)");
            return RecoveryOutcome.Skipped;
        }
        if (!CanRestartApi()) return RecoveryOutcome.BudgetExhausted;
        _apiRestarts.Enqueue(DateTime.UtcNow);
        ShellStartupLog.Write($"api_restart: 꺼진 로컬 서비스를 다시 시작 ({_api.DescribeNodeProcess()}) attempt={_apiRestarts.Count}/{ApiRestartBudget}");
        if (!_api.TryRestartAfterExit())
            return token.IsCancellationRequested ? RecoveryOutcome.Skipped : RecoveryOutcome.StartFailed;
        if (token.IsCancellationRequested) return RecoveryOutcome.Skipped;
        if (!_api.WaitForHealth(_api.RecommendedHealthTimeout))
        {
            ShellStartupLog.Write("api_restart: 다시 시작했지만 제한 시간 안에 준비되지 않음");
            // A crash-on-start shows up as another exit and spends the budget on the next probe.
            return RecoveryOutcome.NotReadyYet;
        }
        ShellStartupLog.Write($"api_restarted: 로컬 서비스 복구 {_api.DescribeNodeProcess()}");
        _dispatcher.BeginInvoke(_onApiRestarted);
        return RecoveryOutcome.Recovered;
    }

    internal static string DescribeShellProcess()
    {
        try
        {
            using var self = Process.GetCurrentProcess();
            return $"shell ws_mb={self.WorkingSet64 / 1048576} handles={self.HandleCount} threads={self.Threads.Count}";
        }
        catch
        {
            return "shell state unavailable";
        }
    }

    public void Dispose()
    {
        // Not disposed: the background thread may still be inside WaitOne on its handle.
        try { _cts.Cancel(); } catch { /* ignore */ }
    }
}
