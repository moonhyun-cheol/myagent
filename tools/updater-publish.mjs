import {
  existsSync,
  mkdirSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function resolveDotnet() {
  const candidates = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'dotnet', 'dotnet.exe') : null,
    process.env['ProgramFiles(x86)']
      ? path.join(process.env['ProgramFiles(x86)'], 'dotnet', 'dotnet.exe')
      : null,
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) ?? 'dotnet';
}

export function publishUpdater({ root, outDir, label = 'publish-updater' }) {
  const project = path.join(root, 'shell', 'CqrPa.Updater', 'CqrPa.Updater.csproj');
  if (!existsSync(project)) return { ok: false, reason: `missing: ${project}` };
  mkdirSync(outDir, { recursive: true });
  const dotnetHome = path.join(root, '.tmp', 'dotnet-cli');
  const nugetPackages = path.join(root, '.tmp', 'nuget-packages');
  mkdirSync(dotnetHome, { recursive: true });
  mkdirSync(nugetPackages, { recursive: true });
  const env = {
    ...process.env,
    DOTNET_CLI_HOME: process.env.DOTNET_CLI_HOME || dotnetHome,
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    NUGET_PACKAGES: process.env.NUGET_PACKAGES || nugetPackages,
  };
  const restoreConfig = path.join(root, 'NuGet.Config');
  const restoreArgs = existsSync(restoreConfig) ? ['--configfile', restoreConfig] : [];
  const dotnet = resolveDotnet();
  const restore = spawnSync(
    dotnet,
    ['restore', project, '-r', 'win-x64', '-v', 'q', ...restoreArgs],
    { cwd: root, encoding: 'utf8', env },
  );
  const restoreOutput = `${restore.stdout ?? ''}${restore.stderr ?? ''}`;
  if (restoreOutput.trim()) process.stdout.write(restoreOutput.endsWith('\n') ? restoreOutput : `${restoreOutput}\n`);
  if (restore.status !== 0) {
    return { ok: false, reason: `${label}: updater restore failed` };
  }

  const publish = spawnSync(
    dotnet,
    ['publish', project, '-c', 'Release', '-o', outDir, '-v', 'q', '--no-restore'],
    { cwd: root, encoding: 'utf8', env },
  );
  const publishOutput = `${publish.stdout ?? ''}${publish.stderr ?? ''}`;
  if (publishOutput.trim()) process.stdout.write(publishOutput.endsWith('\n') ? publishOutput : `${publishOutput}\n`);
  const executable = path.join(outDir, 'MYAgent.Updater.exe');
  if (publish.status !== 0 || !existsSync(executable)) {
    return { ok: false, reason: `${label}: updater publish failed` };
  }
  return { ok: true, executable };
}
