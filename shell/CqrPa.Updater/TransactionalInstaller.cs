using System.Text.Json;

namespace CqrPa.Updater;

internal sealed record BackupEntry(string Path, bool Existed);

internal sealed class UpdateTransaction
{
    private readonly string _root;
    private readonly string _backupRoot;
    private readonly IReadOnlyList<BackupEntry> _entries;
    private readonly string _recordPath;

    public UpdateTransaction(
        string root,
        string backupRoot,
        IReadOnlyList<BackupEntry> entries,
        string recordPath)
    {
        _root = root;
        _backupRoot = backupRoot;
        _entries = entries;
        _recordPath = recordPath;
    }

    public void Commit()
    {
        WriteState("committed");
        try
        {
            Directory.Delete(_backupRoot, recursive: true);
        }
        catch
        {
            // A successful update must not be rolled back only because backup cleanup was delayed.
        }
    }

    public void Rollback()
    {
        WriteState("rolling_back");
        var failures = new List<Exception>();
        foreach (var entry in _entries.Reverse())
        {
            try
            {
                var destination = UpdateProtocol.ResolveUnder(_root, entry.Path);
                ClearReadOnly(destination);
                if (entry.Existed)
                {
                    var backup = UpdateProtocol.ResolveUnder(_backupRoot, entry.Path);
                    Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                    File.Copy(backup, destination, overwrite: true);
                }
                else if (File.Exists(destination))
                {
                    File.Delete(destination);
                }
            }
            catch (Exception error)
            {
                failures.Add(new IOException($"Rollback failed for {entry.Path}: {error.Message}", error));
            }
        }
        if (failures.Count == 0)
        {
            WriteState("rolled_back");
            return;
        }

        try { WriteState("rollback_failed"); } catch { }
        throw new AggregateException("One or more update files could not be restored.", failures);
    }

    private static void ClearReadOnly(string path)
    {
        if (!File.Exists(path)) return;
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReadOnly) != 0)
            File.SetAttributes(path, attributes & ~FileAttributes.ReadOnly);
    }

    private void WriteState(string state)
    {
        File.WriteAllText(
            _recordPath,
            JsonSerializer.Serialize(new
            {
                state,
                root = _root,
                backup_root = _backupRoot,
                entries = _entries,
                updated_at = DateTimeOffset.UtcNow,
            }, new JsonSerializerOptions { WriteIndented = true }));
    }
}

internal static class TransactionalInstaller
{
    public static void Preflight(string root, VerifiedUpdate update)
    {
        var fullRoot = Path.GetFullPath(root);
        EnsureDirectoryIsNotReparsePoint(fullRoot);
        EnsureDiskSpace(fullRoot, update);

        var touchedPaths = update.Files.Select(file => file.Path)
            .Concat(update.Deleted)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var probeDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            FindNearestExistingDirectory(Path.Combine(fullRoot, "data", "backups"), fullRoot),
        };

        foreach (var relative in touchedPaths)
        {
            var destination = UpdateProtocol.ResolveUnder(fullRoot, relative);
            EnsureDestinationChainIsSafe(fullRoot, destination);
            probeDirectories.Add(FindNearestExistingDirectory(Path.GetDirectoryName(destination)!, fullRoot));
            if (!File.Exists(destination)) continue;
            using var stream = new FileStream(
                destination,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
        }

        foreach (var directory in probeDirectories)
            ProbeDirectoryMutation(directory);
    }

    public static UpdateTransaction Apply(string root, VerifiedUpdate update)
    {
        var fullRoot = Path.GetFullPath(root);
        EnsureDirectoryIsNotReparsePoint(fullRoot);
        EnsureDiskSpace(fullRoot, update);

        var stamp = DateTimeOffset.UtcNow.ToString("yyyyMMdd-HHmmss");
        var backupRoot = Path.Combine(fullRoot, "data", "backups", $"managed-update-{update.Sequence}-{stamp}");
        Directory.CreateDirectory(backupRoot);
        var recordPath = Path.Combine(backupRoot, "transaction.json");
        var touchedPaths = update.Files.Select(file => file.Path)
            .Concat(update.Deleted)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(item => item, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var entries = new List<BackupEntry>();

        foreach (var relative in touchedPaths)
        {
            var destination = UpdateProtocol.ResolveUnder(fullRoot, relative);
            EnsureDestinationChainIsSafe(fullRoot, destination);
            var existed = File.Exists(destination);
            entries.Add(new BackupEntry(relative, existed));
            if (!existed) continue;
            var backup = UpdateProtocol.ResolveUnder(backupRoot, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(backup)!);
            File.Copy(destination, backup, overwrite: false);
        }

        var transaction = new UpdateTransaction(fullRoot, backupRoot, entries, recordPath);
        File.WriteAllText(
            recordPath,
            JsonSerializer.Serialize(new
            {
                state = "prepared",
                root = fullRoot,
                backup_root = backupRoot,
                entries,
                created_at = DateTimeOffset.UtcNow,
            }, new JsonSerializerOptions { WriteIndented = true }));

        try
        {
            foreach (var relative in update.Deleted)
            {
                var destination = UpdateProtocol.ResolveUnder(fullRoot, relative);
                ClearReadOnly(destination);
                if (File.Exists(destination)) File.Delete(destination);
            }

            foreach (var file in update.Files)
            {
                var source = UpdateProtocol.ResolveUnder(update.StageRoot, file.Path);
                var destination = UpdateProtocol.ResolveUnder(fullRoot, file.Path);
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                ClearReadOnly(destination);
                var temporary = $"{destination}.cqr-update-{Guid.NewGuid():N}.tmp";
                try
                {
                    File.Copy(source, temporary, overwrite: false);
                    File.Move(temporary, destination, overwrite: true);
                }
                finally
                {
                    if (File.Exists(temporary)) File.Delete(temporary);
                }
            }

            foreach (var file in update.Files)
            {
                var destination = UpdateProtocol.ResolveUnder(fullRoot, file.Path);
                if (!File.Exists(destination)
                    || new FileInfo(destination).Length != file.Size
                    || !string.Equals(
                        UpdateProtocol.Sha256File(destination),
                        file.Sha256,
                        StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException($"Installed file verification failed: {file.Path}");
                }
            }

            File.WriteAllText(
                recordPath,
                JsonSerializer.Serialize(new
                {
                    state = "applied",
                    root = fullRoot,
                    backup_root = backupRoot,
                    entries,
                    applied_at = DateTimeOffset.UtcNow,
                }, new JsonSerializerOptions { WriteIndented = true }));
            return transaction;
        }
        catch (Exception applyError)
        {
            try
            {
                transaction.Rollback();
            }
            catch (Exception rollbackError)
            {
                throw new AggregateException(
                    "Update apply failed and rollback was incomplete.",
                    applyError,
                    rollbackError);
            }
            throw;
        }
    }

    private static void ClearReadOnly(string path)
    {
        if (!File.Exists(path)) return;
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReadOnly) != 0)
            File.SetAttributes(path, attributes & ~FileAttributes.ReadOnly);
    }

    private static string FindNearestExistingDirectory(string candidate, string root)
    {
        var current = Path.GetFullPath(candidate);
        while (!Directory.Exists(current))
        {
            var parent = Path.GetDirectoryName(current);
            if (string.IsNullOrWhiteSpace(parent)
                || !parent.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                return root;
            current = parent;
        }
        return current;
    }

    private static void ProbeDirectoryMutation(string directory)
    {
        var token = Guid.NewGuid().ToString("N");
        var created = Path.Combine(directory, $".cqr-update-permission-{token}.tmp");
        var moved = $"{created}.moved";
        try
        {
            File.WriteAllText(created, "permission-check");
            File.Move(created, moved);
            File.Delete(moved);
        }
        catch (UnauthorizedAccessException error)
        {
            throw new UnauthorizedAccessException(
                $"Update permission check failed for directory: {directory}",
                error);
        }
        finally
        {
            TryDeleteProbe(created);
            TryDeleteProbe(moved);
        }
    }

    private static void TryDeleteProbe(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
            // The original permission error is more useful than cleanup noise.
        }
    }

    private static void EnsureDiskSpace(string root, VerifiedUpdate update)
    {
        var installBytes = update.Files.Sum(file => file.Size);
        var backupBytes = update.Files
            .Select(file => UpdateProtocol.ResolveUnder(root, file.Path))
            .Concat(update.Deleted.Select(file => UpdateProtocol.ResolveUnder(root, file)))
            .Where(File.Exists)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Sum(file => new FileInfo(file).Length);
        var safetyMargin = 100L * 1024 * 1024;
        var required = checked(installBytes + backupBytes + safetyMargin);
        var driveRoot = Path.GetPathRoot(root)
            ?? throw new IOException("Install drive could not be resolved.");
        if (new DriveInfo(driveRoot).AvailableFreeSpace < required)
            throw new IOException($"Not enough disk space for update. Required: {required} bytes.");
    }

    private static void EnsureDirectoryIsNotReparsePoint(string directory)
    {
        if (!Directory.Exists(directory)) throw new DirectoryNotFoundException(directory);
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException($"Update root cannot be a reparse point: {directory}");
    }

    private static void EnsureDestinationChainIsSafe(string root, string destination)
    {
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        var current = Path.GetDirectoryName(destination);
        while (!string.IsNullOrEmpty(current)
               && current.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
        {
            if (Directory.Exists(current)
                && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidDataException($"Update destination crosses a reparse point: {current}");
            }
            if (string.Equals(current, fullRoot, StringComparison.OrdinalIgnoreCase)) break;
            current = Path.GetDirectoryName(current);
        }
        if (File.Exists(destination)
            && (File.GetAttributes(destination) & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidDataException($"Update destination is a reparse point: {destination}");
        }
    }
}
