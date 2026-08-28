using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace CqrPa.Shell;

internal sealed class SingleInstanceGuard : IDisposable
{
    private readonly Mutex _mutex;
    private readonly EventWaitHandle _activateEvent;
    private readonly CancellationTokenSource _cancellation = new();
    private Action? _onActivate;

    private SingleInstanceGuard(Mutex mutex, EventWaitHandle activateEvent)
    {
        _mutex = mutex;
        _activateEvent = activateEvent;
        var thread = new Thread(ListenForActivate)
        {
            IsBackground = true,
            Name = "MYAgent.SingleInstance.Activate",
        };
        thread.Start();
    }

    public static bool TryBecomePrimary(string root, out SingleInstanceGuard? guard)
    {
        guard = null;
        var mutexName = BuildResourceName("Shell", root);
        var eventName = BuildResourceName("Activate", root);
        var mutex = new Mutex(initiallyOwned: false, mutexName);
        if (!mutex.WaitOne(TimeSpan.Zero))
        {
            mutex.Dispose();
            SignalActivate(eventName);
            return false;
        }

        EventWaitHandle activateEvent;
        try
        {
            activateEvent = new EventWaitHandle(false, EventResetMode.AutoReset, eventName);
        }
        catch
        {
            mutex.ReleaseMutex();
            mutex.Dispose();
            throw;
        }

        guard = new SingleInstanceGuard(mutex, activateEvent);
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
                _onActivate?.Invoke();
            }
            catch
            {
                // Activation must never tear down the primary instance.
            }
        }
    }

    private static void SignalActivate(string eventName)
    {
        try
        {
            using var activate = EventWaitHandle.OpenExisting(eventName);
            activate.Set();
        }
        catch
        {
            // The primary instance may still be starting.
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
