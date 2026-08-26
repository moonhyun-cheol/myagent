/**
 * Execute a local agent plugin (node or powershell) as a subprocess.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentPluginRecord } from './agent-plugin-store.js';
import { auditPluginEvent } from './agent-plugin-store.js';

const MAX_OUT = 100_000;

function truncate(text: string): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= MAX_OUT) return text;
  return `${buf.subarray(0, MAX_OUT).toString('utf8')}\n… (output truncated)`;
}

function resolveNodeExe(cqrRoot: string): string | null {
  const portable = path.join(path.resolve(cqrRoot), 'runtime', 'node', 'node.exe');
  if (existsSync(portable)) return portable;
  // same process node
  if (process.execPath && existsSync(process.execPath)) return process.execPath;
  return null;
}

export function runAgentPlugin(
  cqrRoot: string,
  workspaceRoot: string,
  plugin: AgentPluginRecord,
  args: Record<string, unknown>,
  opts?: { confirm?: boolean },
): string {
  const risk = plugin.manifest.risk;
  if ((risk === 'write' || risk === 'network') && opts?.confirm !== true) {
    return JSON.stringify(
      {
        ok: false,
        error: `plugin ${plugin.manifest.name} has risk=${risk}; pass confirm=true after user approval`,
      },
      null,
      2,
    );
  }

  const entry = plugin.manifest.runner.entry;
  const entryPath = path.join(plugin.dir, entry);
  if (!existsSync(entryPath)) {
    return JSON.stringify(
      { ok: false, error: `plugin entry missing: ${entry}` },
      null,
      2,
    );
  }

  // Path sandbox: entry must resolve inside plugin dir
  const resolvedEntry = path.resolve(entryPath);
  const resolvedDir = path.resolve(plugin.dir);
  const rel = path.relative(resolvedDir, resolvedEntry);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return JSON.stringify({ ok: false, error: 'entry escapes plugin directory' }, null, 2);
  }

  const timeoutMs = plugin.manifest.runner.timeout_ms ?? 60_000;
  const payload = JSON.stringify({ arguments: args ?? {} });
  const env = {
    ...process.env,
    MY_AGENT_ROOT: path.resolve(cqrRoot),
    CQR_WORKSPACE_ROOT: path.resolve(workspaceRoot),
    CQR_PLUGIN_ID: plugin.id,
    CQR_PLUGIN_NAME: plugin.manifest.name,
  };

  const kind = plugin.manifest.runner.kind;
  let proc: ReturnType<typeof spawnSync>;

  if (kind === 'node') {
    const nodeExe = resolveNodeExe(cqrRoot);
    if (!nodeExe) {
      return JSON.stringify({ ok: false, error: 'Node runtime not found for plugin runner' }, null, 2);
    }
    proc = spawnSync(nodeExe, [resolvedEntry], {
      cwd: resolvedDir,
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_OUT * 2,
      env,
      input: payload,
    });
  } else if (kind === 'powershell') {
    proc = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolvedEntry],
      {
        cwd: resolvedDir,
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: MAX_OUT * 2,
        env: {
          ...env,
          CQR_PLUGIN_ARGS_JSON: payload,
        },
        input: payload,
      },
    );
  } else {
    return JSON.stringify({ ok: false, error: `unsupported runner kind: ${kind}` }, null, 2);
  }

  const stdout = truncate(String(proc.stdout ?? ''));
  const stderr = truncate(String(proc.stderr ?? ''));
  const timedOut = Boolean(proc.error?.message?.includes('ETIMEDOUT'));
  const exitCode = timedOut ? null : (proc.status ?? 1);
  const ok = exitCode === 0 && !timedOut && !proc.error;

  auditPluginEvent(cqrRoot, {
    event: ok ? 'exec' : 'exec_fail',
    id: plugin.id,
    name: plugin.manifest.name,
    exit_code: exitCode,
  });

  if (!ok) {
    return JSON.stringify(
      {
        ok: false,
        exit_code: exitCode,
        error: timedOut
          ? `plugin timed out after ${timeoutMs}ms`
          : proc.error?.message || stderr || stdout || 'plugin failed',
        stdout,
        stderr,
      },
      null,
      2,
    );
  }

  return stdout.trim() || JSON.stringify({ ok: true, note: '(no stdout)' });
}
