using System.Diagnostics;
using System.Net.Http;

namespace CqrPa.Host;

internal static class Program
{
    private const int DefaultPort = 10200;

    [STAThread]
    private static int Main(string[] args)
    {
        var root = ResolveCqrRoot();
        Environment.SetEnvironmentVariable("MY_AGENT_ROOT", root);

        if (args.Contains("--import-license", StringComparer.OrdinalIgnoreCase))
        {
            return ImportLicense(args, root);
        }

        var port = DefaultPort;
        var nodeScript = Path.Combine(root, "core", "dist", "main.js");
        if (!File.Exists(nodeScript))
        {
            Console.Error.WriteLine($"API not built. Run: npm run build");
            Console.Error.WriteLine($"Missing: {nodeScript}");
            return 1;
        }

        var node = FindNode(root);
        var api = StartApi(node, nodeScript, root, port);
        if (api == null)
            return 1;

        try
        {
            if (!WaitForHealth(port, TimeSpan.FromSeconds(15)))
            {
                Console.Error.WriteLine("API health check failed.");
                return 1;
            }

            Console.WriteLine($"MY Agent running at http://127.0.0.1:{port}");
            Console.WriteLine("Press Ctrl+C to stop.");

            if (args.Contains("--no-browser"))
            {
                api.WaitForExit();
                return api.ExitCode;
            }

            Process.Start(new ProcessStartInfo($"http://127.0.0.1:{port}") { UseShellExecute = true });
            api.WaitForExit();
            return api.ExitCode;
        }
        finally
        {
            if (!api.HasExited)
            {
                try { api.Kill(entireProcessTree: true); } catch { /* ignore */ }
            }
        }
    }

    private static string ResolveCqrRoot()
    {
        var env = Environment.GetEnvironmentVariable("MY_AGENT_ROOT");
        if (!string.IsNullOrWhiteSpace(env))
            return Path.GetFullPath(env);

        // shell/CqrPa.Host/bin/... -> repo root (../../.. from project dir when dev)
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 6 && dir != null; i++, dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "manifest.json")))
                return dir.FullName;
        }

        throw new InvalidOperationException("Cannot resolve MY_AGENT_ROOT. Set MY_AGENT_ROOT env var.");
    }

    private static string FindNode(string root)
    {
        var embedded = Path.Combine(root, "runtime", "node", "node.exe");
        if (File.Exists(embedded))
            return embedded;
        return "node";
    }

    private static Process? StartApi(string node, string script, string root, int port)
    {
        var psi = new ProcessStartInfo
        {
            FileName = node,
            Arguments = $"\"{script}\"",
            WorkingDirectory = root,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.Environment["MY_AGENT_ROOT"] = root;
        psi.Environment["CQR_API_PORT"] = port.ToString();

        var p = Process.Start(psi);
        if (p == null)
            return null;

        p.OutputDataReceived += (_, e) => { if (e.Data != null) Console.WriteLine(e.Data); };
        p.ErrorDataReceived += (_, e) => { if (e.Data != null) Console.Error.WriteLine(e.Data); };
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        return p;
    }

    private static bool WaitForHealth(int port, TimeSpan timeout)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var json = http.GetStringAsync($"http://127.0.0.1:{port}/health").GetAwaiter().GetResult();
                if (json.Contains("MY Agent", StringComparison.Ordinal))
                    return true;
            }
            catch
            {
                Thread.Sleep(200);
            }
        }
        return false;
    }

    private static int ImportLicense(string[] args, string root)
    {
        var idx = Array.FindIndex(args, a => a.Equals("--import-license", StringComparison.OrdinalIgnoreCase));
        if (idx < 0 || idx + 1 >= args.Length)
        {
            Console.Error.WriteLine("Usage: cqr-pa.exe --import-license <path-to-license.ocx>");
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
        var dest = Path.Combine(vault, "license.ocx");
        File.Copy(src, dest, overwrite: true);
        Console.WriteLine($"Imported license -> {dest}");
        return 0;
    }
}
