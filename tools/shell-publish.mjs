/**
 * Shared `dotnet publish` step for the WPF shell (bin/my-agent).
 *
 * A running MYAgent.exe keeps MYAgent.dll mapped, so MSBuild dies with MSB3021/MSB3027
 * ("being used by another process") and the deploy generators used to report that as
 * "need .NET 8 SDK". Detect the lock up front: reuse the existing publish output when
 * it is already newer than every shell source, otherwise stop with the pid to close.
 */
import {
  existsSync,
  openSync,
  closeSync,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ETXTBSY']);
const LOCK_MSBUILD_RE = /MSB3021|MSB3027|being used by another process|다른 프로세스가 사용/i;

function isLocked(file) {
  if (!existsSync(file)) return false;
  try {
    closeSync(openSync(file, 'r+'));
    return false;
  } catch (error) {
    return LOCK_CODES.has(error?.code);
  }
}

function runningShellPids() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq MYAgent.exe', '/NH', '/FO', 'CSV'], {
    encoding: 'utf8',
  });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((line) => /^"MYAgent\.exe","(\d+)"/i.exec(line.trim())?.[1])
    .filter(Boolean);
}

function sourceFiles(projDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'obj' || entry.name === 'bin') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(cs|xaml|csproj|resx|ico|png)$/i.test(entry.name)) continue;
      files.push(full);
    }
  };
  walk(projDir);
  return files.sort();
}

/** Content hash, so a touched-but-unchanged source does not look like a rebuild. */
function sourceFingerprint(projDir) {
  const hash = createHash('sha256');
  for (const file of sourceFiles(projDir)) {
    hash.update(path.relative(projDir, file).replace(/\\/g, '/'));
    hash.update(createHash('sha256').update(readFileSync(file)).digest());
  }
  return hash.digest('hex');
}

function newestSourceMtime(projDir) {
  return sourceFiles(projDir).reduce((newest, file) => Math.max(newest, statSync(file).mtimeMs), 0);
}

function readFingerprint(outDir) {
  try {
    return JSON.parse(readFileSync(path.join(outDir, '.shell-sources.json'), 'utf8')).sources ?? null;
  } catch {
    return null;
  }
}

function writeFingerprint(outDir, sources) {
  try {
    writeFileSync(
      path.join(outDir, '.shell-sources.json'),
      `${JSON.stringify({ sources, at: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    /* fingerprint is a cache hint only */
  }
}

function lockGuidance(pids) {
  const who = pids.length ? `pid ${pids.join(', ')}` : 'MYAgent.exe';
  return [
    `MY Agent 앱이 실행 중이라 셸(bin/my-agent)을 다시 빌드할 수 없습니다 (${who}).`,
    '  1) MY Agent 창을 닫으세요 (또는 작업 관리자에서 MYAgent.exe 종료)',
    `  2) 강제 종료: powershell -NoProfile -Command "Stop-Process -Name MYAgent -Force"`,
    '  3) 배포 생성기를 다시 실행하세요',
  ].join('\n');
}

function resolveDotnet() {
  const candidates = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'dotnet', 'dotnet.exe') : null,
    process.env['ProgramFiles(x86)']
      ? path.join(process.env['ProgramFiles(x86)'], 'dotnet', 'dotnet.exe')
      : null,
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? 'dotnet';
}

/**
 * @returns {{ ok: boolean, reused?: boolean, reason?: string }}
 */
export function publishShell({ root, projPath, outDir, allowBuildFallback = false, label = 'publish' }) {
  if (!existsSync(projPath)) return { ok: false, reason: `missing: ${projPath}` };
  mkdirSync(outDir, { recursive: true });

  const projDir = path.dirname(projPath);
  const exe = path.join(outDir, 'MYAgent.exe');
  const dll = path.join(outDir, 'MYAgent.dll');
  const locked = isLocked(dll) || isLocked(exe);
  const fingerprint = sourceFingerprint(projDir);

  if (locked) {
    const pids = runningShellPids();
    const recorded = readFingerprint(outDir);
    const fresh = existsSync(exe)
      ? recorded
        ? recorded === fingerprint
        : statSync(exe).mtimeMs >= newestSourceMtime(projDir)
      : false;
    if (fresh) {
      console.warn(
        `${label}: MY Agent 앱 실행 중 — 기존 셸 publish 결과를 재사용합니다 (소스 변경 없음, bin/my-agent 최신).`,
      );
      return { ok: true, reused: true };
    }
    return { ok: false, reason: lockGuidance(pids) };
  }

  const dotnet = resolveDotnet();
  const dotnetHome = path.join(root, '.tmp', 'dotnet-cli');
  const nugetPackages = path.join(root, '.tmp', 'nuget-packages');
  mkdirSync(dotnetHome, { recursive: true });
  mkdirSync(nugetPackages, { recursive: true });
  const dotnetEnv = {
    ...process.env,
    DOTNET_CLI_HOME: process.env.DOTNET_CLI_HOME || dotnetHome,
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    NUGET_PACKAGES: process.env.NUGET_PACKAGES || nugetPackages,
  };
  const restoreConfig = path.join(root, 'NuGet.Config');
  const restoreArgs = existsSync(restoreConfig) ? ['--configfile', restoreConfig] : [];
  const restore = spawnSync(dotnet, ['restore', projPath, '-r', 'win-x64', '-v', 'q', ...restoreArgs], {
    cwd: root,
    encoding: 'utf8',
    env: dotnetEnv,
  });
  const restoreOutput = `${restore.stdout ?? ''}${restore.stderr ?? ''}`;
  if (restoreOutput.trim()) {
    process.stdout.write(restoreOutput.endsWith('\n') ? restoreOutput : `${restoreOutput}\n`);
  }
  if (restore.status !== 0) {
    const detail = restore.error?.message ? `: ${restore.error.message}` : '';
    return { ok: false, reason: `${label}: shell restore failed (.NET/NuGet 오류 확인)${detail}` };
  }

  const pub = spawnSync(dotnet, ['publish', projPath, '-c', 'Release', '-o', outDir, '-v', 'q', '--no-restore'], {
    cwd: root,
    encoding: 'utf8',
    env: dotnetEnv,
  });
  const output = `${pub.stdout ?? ''}${pub.stderr ?? ''}`;
  if (output.trim()) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);

  if (pub.error?.code === 'ENOENT') {
    return { ok: false, reason: `${label}: dotnet 명령을 찾을 수 없습니다 (.NET 8 SDK 설치 필요)` };
  }
  if (pub.status === 0 && existsSync(exe)) {
    writeFingerprint(outDir, fingerprint);
    return { ok: true };
  }

  if (LOCK_MSBUILD_RE.test(output)) {
    return { ok: false, reason: lockGuidance(runningShellPids()) };
  }

  if (allowBuildFallback) {
    console.warn(`${label}: dotnet publish failed — falling back to dotnet build`);
    const built = spawnSync(dotnet, ['build', projPath, '-c', 'Release', '-v', 'q', '--no-restore'], {
      cwd: root,
      stdio: 'inherit',
      env: dotnetEnv,
    });
    if (built.status === 0) {
      writeFingerprint(outDir, fingerprint);
      return { ok: true };
    }
  }

  return { ok: false, reason: `${label}: shell publish failed (.NET 8 SDK / 빌드 오류 확인)` };
}
