namespace CqrPa.Shell;

internal static class CqrPaths
{
    public static string ResolveCqrRoot()
    {
        var env = Environment.GetEnvironmentVariable("MY_AGENT_ROOT");
        if (!string.IsNullOrWhiteSpace(env))
            return Path.GetFullPath(env);

        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 8 && dir != null; i++, dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "manifest.json")))
                return dir.FullName;
        }

        throw new InvalidOperationException("MY_AGENT_ROOT not found. Set MY_AGENT_ROOT environment variable.");
    }
}
