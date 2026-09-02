namespace CqrPa.WorkKitLauncher;

internal static class LauncherCompanionUpdate
{
    public static int Run(string root)
    {
        try
        {
            var service = LauncherUpdateService.TryCreate(root);
            if (service is null) return 0;
            var update = service.CheckAsync(CancellationToken.None).GetAwaiter().GetResult();
            if (update is null) return 0;
            var downloaded = service.DownloadAsync(update, CancellationToken.None).GetAwaiter().GetResult();
            service.LaunchApplier(downloaded);
            return 0;
        }
        catch (Exception error)
        {
            serviceLog(root, error);
            return 1;
        }
    }

    private static void serviceLog(string root, Exception error)
    {
        try
        {
            var logDirectory = Path.Combine(root, "data", "logs");
            Directory.CreateDirectory(logDirectory);
            File.AppendAllText(
                Path.Combine(logDirectory, "launcher-update-check.log"),
                $"{DateTimeOffset.UtcNow:O} companion-update: {error.GetType().Name}: {error.Message}{Environment.NewLine}",
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        }
        catch
        {
            // Best effort.
        }
    }
}
