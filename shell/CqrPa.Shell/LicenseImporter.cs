namespace CqrPa.Shell;

internal static class LicenseImporter
{
    public static int Run(string[] args, string root)
    {
        var idx = Array.FindIndex(args, a => a.Equals("--import-license", StringComparison.OrdinalIgnoreCase));
        if (idx < 0 || idx + 1 >= args.Length)
        {
            Console.Error.WriteLine("Usage: cqr-pa.exe --import-license <path>");
            return 1;
        }

        var src = Path.GetFullPath(args[idx + 1]);
        if (src.StartsWith(@"\\nas", StringComparison.OrdinalIgnoreCase) ||
            src.StartsWith(@"\\nas3", StringComparison.OrdinalIgnoreCase))
        {
            Console.Error.WriteLine("NAS paths are forbidden.");
            return 1;
        }

        var vault = Path.Combine(root, "data", "vault");
        Directory.CreateDirectory(vault);
        File.Copy(src, Path.Combine(vault, "license.ocx"), overwrite: true);
        Console.WriteLine("License imported.");
        return 0;
    }
}
