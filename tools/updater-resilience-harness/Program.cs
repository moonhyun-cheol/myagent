using System.Text;

namespace CqrPa.Updater;

internal static class Program
{
    public static int Main()
    {
        var sandbox = Path.Combine(Path.GetTempPath(), $"my-agent-updater-test-{Guid.NewGuid():N}");
        try
        {
            Directory.CreateDirectory(Path.Combine(sandbox, "data"));
            TestApplyRollbackAndReadOnly(sandbox);
            TestLockedFilePreflight(sandbox);
            TestApplyFailureRollback(sandbox);
            Console.WriteLine("updater resilience behavior harness OK");
            return 0;
        }
        finally
        {
            ClearReadOnlyRecursively(sandbox);
            if (Directory.Exists(sandbox)) Directory.Delete(sandbox, recursive: true);
        }
    }

    private static void TestApplyRollbackAndReadOnly(string sandbox)
    {
        var (root, stage, destination, update) = CreateFixture(sandbox, "rollback", "old", "new");
        File.SetAttributes(destination, File.GetAttributes(destination) | FileAttributes.ReadOnly);
        TransactionalInstaller.Preflight(root, update);
        var transaction = TransactionalInstaller.Apply(root, update);
        Assert(File.ReadAllText(destination) == "new", "update content was not installed");
        transaction.Rollback();
        Assert(File.ReadAllText(destination) == "old", "rollback did not restore read-only file");
        Directory.Delete(stage, recursive: true);
    }

    private static void TestLockedFilePreflight(string sandbox)
    {
        var (root, stage, destination, update) = CreateFixture(sandbox, "locked", "old", "new");
        using (new FileStream(destination, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            try
            {
                TransactionalInstaller.Preflight(root, update);
                throw new Exception("locked managed file was not rejected before shutdown");
            }
            catch (IOException)
            {
                // Expected: no product process has been stopped at this point.
            }
        }
        Directory.Delete(stage, recursive: true);
    }

    private static void TestApplyFailureRollback(string sandbox)
    {
        var (root, stage, destination, validUpdate) = CreateFixture(sandbox, "apply-failure", "old", "new");
        var invalidFile = validUpdate.Files[0] with { Sha256 = new string('0', 64) };
        var invalidUpdate = validUpdate with { Files = new[] { invalidFile } };
        try
        {
            TransactionalInstaller.Apply(root, invalidUpdate);
            throw new Exception("invalid installed hash did not fail");
        }
        catch (InvalidDataException)
        {
            Assert(File.ReadAllText(destination) == "old", "apply failure did not restore previous content");
        }
        Directory.Delete(stage, recursive: true);
    }

    private static (string Root, string Stage, string Destination, VerifiedUpdate Update) CreateFixture(
        string sandbox,
        string name,
        string oldContent,
        string newContent)
    {
        var root = Path.Combine(sandbox, name, "root");
        var stage = Path.Combine(sandbox, name, "stage");
        var relative = "app/sample.txt";
        var destination = Path.Combine(root, "app", "sample.txt");
        var source = Path.Combine(stage, "app", "sample.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        Directory.CreateDirectory(Path.GetDirectoryName(source)!);
        File.WriteAllText(destination, oldContent, Encoding.UTF8);
        File.WriteAllText(source, newContent, Encoding.UTF8);
        var file = new UpdateFile(relative, new FileInfo(source).Length, UpdateProtocol.Sha256File(source));
        return (root, stage, destination, new VerifiedUpdate(50, 1, "test", "stable", stage, new[] { file }, Array.Empty<string>()));
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    private static void ClearReadOnlyRecursively(string root)
    {
        if (!Directory.Exists(root)) return;
        foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
            File.SetAttributes(file, File.GetAttributes(file) & ~FileAttributes.ReadOnly);
    }
}