import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  buildAutomatonToolArgs,
  buildCliArguments,
  getAutomatonCommandConfig,
  isAutomatonAsyncEnabled,
  isAutomatonTool,
} from './tool-map.js';
import { AutomatonMcpSession } from './mcp-session.js';
import { formatAutomatonEnvelope, formatAutomatonError } from './format-result.js';
import { AutomatonDispatchError } from './errors.js';
import {
  buildAutomatonJsonOutputPath,
  resolveAutomatonPython,
  resolveAutomatonRoot,
} from './paths.js';
import { pollProgressSidecar, startAutomatonProgressPolling } from './progress.js';
import { resolveAutomatonToolTimeoutMs } from './timeouts.js';
import {
  dispatchAutomatonToolRemote,
  probeOpenClawAdapterHealth,
  resolveOpenClawAdapterConfig,
  type OpenClawAdapterConfig,
} from './openclaw-adapter-client.js';

export interface AutomatonDispatchResult {
  tool: string;
  envelope: Record<string, unknown>;
  content: string;
}

export interface AutomatonDispatchOptions {
  progressFile?: string;
  onStatus?: (text: string) => void;
  onThought?: (text: string) => void;
  /** Prefer OpenClaw Adapter when configured (default true if URL+creds set). */
  preferRemote?: boolean;
  openclaw?: OpenClawAdapterConfig | null;
  /** On remote failure, fall back to local spawn (default true). */
  fallbackLocal?: boolean;
}

let sharedSession: AutomatonMcpSession | null = null;
let sharedRoot: string | undefined;

export function getAutomatonAdapter(configuredRoot?: string): AutomatonMcpSession {
  const root = configuredRoot ?? process.env.LIVE_AUTOMATON_ROOT;
  if (!sharedSession || sharedRoot !== root) {
    void sharedSession?.close();
    sharedSession = new AutomatonMcpSession(root);
    sharedRoot = root;
  }
  return sharedSession;
}

async function dispatchAutomatonToolAsync(
  message: string,
  matchedTool: string,
  configuredRoot?: string,
  options?: AutomatonDispatchOptions,
): Promise<AutomatonDispatchResult> {
  const config = getAutomatonCommandConfig(matchedTool);
  if (!config) {
    throw new AutomatonDispatchError('MCP_SPAWN_FAILED', `registry에 없는 longRunning tool: ${matchedTool}`);
  }

  const automatonRoot = resolveAutomatonRoot(configuredRoot);
  if (!automatonRoot) {
    throw new AutomatonDispatchError('MCP_SPAWN_FAILED', 'LIVE_AUTOMATON_ROOT not found');
  }

  const pythonPath = resolveAutomatonPython(automatonRoot);
  if (!pythonPath) {
    throw new AutomatonDispatchError('MCP_SPAWN_FAILED', 'automaton python.exe not found');
  }

  const progressFile = options?.progressFile?.trim();
  if (!progressFile) {
    throw new AutomatonDispatchError('MCP_SPAWN_FAILED', 'progressFile is required for async dispatch');
  }

  const scriptPath = path.join(automatonRoot, config.scriptRelativePath);
  if (!existsSync(scriptPath)) {
    throw new AutomatonDispatchError('MCP_SPAWN_FAILED', `script not found: ${scriptPath}`);
  }

  const mcpArgs = buildAutomatonToolArgs(matchedTool, message, progressFile);
  const jsonOutputPath = buildAutomatonJsonOutputPath(automatonRoot, matchedTool);
  const cliArgs = buildCliArguments(matchedTool, mcpArgs, {
    jsonOutput: jsonOutputPath,
    progressFile,
  });

  options?.onStatus?.('my_live_automaton — 독립 프로세스 시작…');

  try {
    const child = spawn(pythonPath, [scriptPath, ...cliArgs], {
      cwd: automatonRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        LIVE_AUTOMATON_ROOT: automatonRoot,
        LIVE_AUTOMATON_PYTHON: pythonPath,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    });
    child.unref();
  } catch (err) {
    throw new AutomatonDispatchError(
      'MCP_SPAWN_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  }

  const envelope = await pollProgressSidecar(matchedTool, {
    progressFile,
    jsonOutputPath,
    stallTimeoutMin: config.stallTimeoutMin,
    hardTimeoutSec: config.timeoutSec,
    onStatus: options?.onStatus,
    onThought: options?.onThought,
  });

  return {
    tool: matchedTool,
    envelope,
    content: formatAutomatonEnvelope(matchedTool, envelope),
  };
}

async function dispatchAutomatonToolSync(
  message: string,
  matchedTool: string,
  configuredRoot?: string,
  options?: AutomatonDispatchOptions,
): Promise<AutomatonDispatchResult> {
  const adapter = getAutomatonAdapter(configuredRoot);
  const args = buildAutomatonToolArgs(matchedTool, message, options?.progressFile);

  const stopPolling = options?.progressFile && (options?.onStatus || options?.onThought)
    ? startAutomatonProgressPolling(options.progressFile, {
      onStatus: options?.onStatus,
      onThought: options?.onThought,
    })
    : () => {};

  try {
    const timeoutMs = resolveAutomatonToolTimeoutMs(matchedTool);
    const envelope = await adapter.callTool(matchedTool, args, { timeoutMs });
    return {
      tool: matchedTool,
      envelope,
      content: formatAutomatonEnvelope(matchedTool, envelope),
    };
  } finally {
    stopPolling();
  }
}

async function dispatchAutomatonToolLocal(
  message: string,
  matchedTool: string,
  configuredRoot?: string,
  options?: AutomatonDispatchOptions,
): Promise<AutomatonDispatchResult> {
  const commandConfig = getAutomatonCommandConfig(matchedTool);
  const useAsync = isAutomatonAsyncEnabled() && commandConfig?.longRunning === true;
  if (useAsync) {
    return dispatchAutomatonToolAsync(message, matchedTool, configuredRoot, options);
  }
  return dispatchAutomatonToolSync(message, matchedTool, configuredRoot, options);
}

export async function dispatchAutomatonTool(
  message: string,
  matchedTool: string,
  configuredRoot?: string,
  options?: AutomatonDispatchOptions,
): Promise<AutomatonDispatchResult> {
  if (!isAutomatonTool(matchedTool)) {
    throw new Error(`not an automaton tool: ${matchedTool}`);
  }

  const remoteCfg =
    options?.openclaw
    ?? resolveOpenClawAdapterConfig({});
  const preferRemote = options?.preferRemote !== false && Boolean(remoteCfg);
  const fallbackLocal = options?.fallbackLocal !== false;

  try {
    if (preferRemote && remoteCfg) {
      try {
        return await dispatchAutomatonToolRemote(message, matchedTool, remoteCfg, options);
      } catch (remoteErr) {
        if (!fallbackLocal || !configuredRoot) {
          throw remoteErr;
        }
        options?.onStatus?.('OpenClaw 원격 실패 — 로컬 automaton으로 폴백…');
        options?.onThought?.(
          remoteErr instanceof Error ? remoteErr.message : String(remoteErr),
        );
        return await dispatchAutomatonToolLocal(message, matchedTool, configuredRoot, options);
      }
    }

    return await dispatchAutomatonToolLocal(message, matchedTool, configuredRoot, options);
  } catch (err) {
    if (err instanceof AutomatonDispatchError) {
      return {
        tool: matchedTool,
        envelope: {
          status: err.code.toLowerCase(),
          tool: matchedTool,
          message: err.message,
        },
        content: formatAutomatonError(err),
      };
    }
    throw err;
  }
}

export async function getAutomatonDiagnostics(configuredRoot?: string): Promise<Record<string, unknown>> {
  const remote = resolveOpenClawAdapterConfig({});
  const root = resolveAutomatonRoot(configuredRoot);

  if (remote) {
    const health = await probeOpenClawAdapterHealth(remote.baseUrl);
    return {
      configured: true,
      ok: health.ok,
      mode: 'openclaw_adapter',
      openclaw_adapter_base_url: remote.baseUrl,
      health: health.ok ? 'ok' : (health.error || `HTTP ${health.status}`),
      local_automaton_root: root ?? null,
      fallback_local: Boolean(root),
    };
  }

  if (!root) {
    return { configured: false, ok: false, error: 'LIVE_AUTOMATON_ROOT not found' };
  }

  // A health probe must not leave an MCP child alive: reuse a live session, else spawn a
  // throwaway one and close it, or embedders (verify scripts, CLI) never reach exit.
  const shared = getAutomatonAdapter(configuredRoot);
  const adapter = shared.isConnected() ? shared : new AutomatonMcpSession(configuredRoot);
  try {
    const tools = await adapter.listToolNames();
    return {
      configured: true,
      ok: true,
      mode: 'local_spawn',
      automaton_root: root,
      tools,
      async_spawn: isAutomatonAsyncEnabled(),
    };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      mode: 'local_spawn',
      automaton_root: root,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (adapter !== shared) await adapter.close();
  }
}
