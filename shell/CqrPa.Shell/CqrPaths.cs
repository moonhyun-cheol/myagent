namespace CqrPa.Shell;

public static class CqrPaths
{
    public static string ResolveCqrRoot() => ResolveCqrRoot(out _);

    /// <summary>
    /// The install that owns this executable wins. <c>MY_AGENT_ROOT</c> is only a fallback:
    /// the shell exports it to its own children, so a MY Agent launched from inside another
    /// MY Agent (terminal, file open) inherited the other install's root, collided with that
    /// install's single-instance mutex and exited silently.
    /// </summary>
    public static string ResolveCqrRoot(out string source)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 8 && dir != null; i++, dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "manifest.json")))
            {
                source = "exe_manifest";
                return dir.FullName;
            }
        }

        var env = Environment.GetEnvironmentVariable("MY_AGENT_ROOT");
        if (!string.IsNullOrWhiteSpace(env))
        {
            source = "env_MY_AGENT_ROOT";
            return Path.GetFullPath(env);
        }

        throw new InvalidOperationException(
            $"manifest.json not found above {AppContext.BaseDirectory}, and MY_AGENT_ROOT is not set.");
    }
}
