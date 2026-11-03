using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace CqrPa.Shell;

internal sealed class SingleInstanceGuard : IDisposable
{
    private readonly Mutex _mutex;
    private readonly EventWaitHandle _activateEvent;
    private readonly EventWaitHandle _ackEvent;
    private readonly CancellationTokenSource _cancellation = new();
    private Action? _onActivate;

    private SingleInstanceGuard(Mutex mutex, EventWaitHandle activateEvent, EventWaitHandle ackEvent)
    {
        _mutex = mutex;
        _activateEvent = activateEvent;
        _ackEvent = ackEvent;
        var thread = new Thread(ListenForActivate)
        {
            IsBackground = true,
            Name = "MYAgent.SingleInstance.Activate",
        };
        thread.Start();
    }

    /// <summary>Result of handing a launch to the running primary instance.</summary>
    public enum SecondaryOutcome
    {
        /// <summary>The primary restored its window and acknowledged.</summary>
        Acknowledged,
        /// <summary>The primary exists but did not answer (hung, shutting down, or an older build).</summary>
        NoResponse,
    }

    public static bool TryBecomePrimary(string root, out SingleInstanceGuard? guard)
        => TryBecomePrimary(root, TimeSpan.Zero, out guard, out _);

    public static bool TryBecomePrimary(
        string root,
        TimeSpan ackTimeout,
        out SingleInstanceGuard? guard,
        out SecondaryOutcome secondaryOutcome)
    {
        guard = null;
        secondaryOutcome = SecondaryOutcome.Acknowledged;
        var mutexName = BuildResourceName("Shell", root);
        var eventName = BuildResourceName("Activate", root);
        var ackName = BuildResourceName("ActivateAck", root);
        var mutex = new Mutex(initiallyOwned: false, mutexName);
        bool owned;
        try
        {
            owned = mutex.WaitOne(TimeSpan.Zero);
        }
        catch (AbandonedMutexException)
        {
            // The previous owner died without releasing it; ownership now passes to us.
            ShellStartupLog.Write("single_instance: previous owner abandoned the mutex; taking over");
            owned = true;
        }
        if (!owned)
        {
            mutex.Dispose();
            secondaryOutcome = SignalActivate(eventName, ackName, ackTimeout)
                ? SecondaryOutcome.Acknowledged
                : SecondaryOutcome.NoResponse;
            return false;
        }

        EventWaitHandle activateEvent;
        EventWaitHandle ackEvent;
        try
        {
            activateEvent = new EventWaitHandle(false, EventResetMode.AutoReset, eventName);
            ackEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ackName);
        }
        catch
        {
            mutex.ReleaseMutex();
            mutex.Dispose();
            throw;
        }

        guard = new SingleInstanceGuard(mutex, activateEvent, ackEvent);
        return true;
    }

    public void SetActivateHandler(Action onActivate) => _onActivate = onActivate;

    private void ListenForActivate()
    {
        var stop = _cancellation.Token.WaitHandle;
        var handles = new WaitHandle[] { _activateEvent, stop };
        while (!_cancellation.IsCancellationRequested)
        {
            var index = WaitHandle.WaitAny(handles, 500);
            if (index != 0) continue;
            try
            {
                // Runs synchronously on the UI dispatcher, so the ack below proves the
                // window is alive rather than merely the listener thread.
                _onActivate?.Invoke();
                _ackEvent.Set();
            }
            catch
            {
                // Activation must never tear down the primary instance.
            }
        }
    }

    private static bool SignalActivate(string eventName, string ackName, TimeSpan ackTimeout)
    {
        try
        {
            using var ack = new EventWaitHandle(false, EventResetMode.AutoReset, ackName);
            ack.Reset();
            using var activate = EventWaitHandle.OpenExisting(eventName);
            activate.Set();
            return ackTimeout <= TimeSpan.Zero || ack.WaitOne(ackTimeout);
        }
        catch
        {
            // The primary instance may still be starting.
            if (ackTimeout <= TimeSpan.Zero) return true;
            try
            {
                // Give a starting primary a moment to create its activation event, then retry once.
                Thread.Sleep(ackTimeout);
                using var ack = new EventWaitHandle(false, EventResetMode.AutoReset, ackName);
                using var activate = EventWaitHandle.OpenExisting(eventName);
                activate.Set();
                return ack.WaitOne(ackTimeout);
            }
            catch
            {
                return false;
            }
        }
    }

    private static string BuildResourceName(string kind, string root)
    {
        var hash = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(root).ToUpperInvariant())));
        return $@"Local\MYAgent_{kind}_{hash[..24]}";
    }

    public void Dispose()
    {
        _cancellation.Cancel();
        _activateEvent.Dispose();
        _ackEvent.Dispose();
        try
        {
            _mutex.ReleaseMutex();
            _mutex.Dispose();
        }
        catch
        {
            // Mutex cleanup is best effort during shutdown.
        }
    }
}
