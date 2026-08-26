import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { findLlamaServerBinary } from './llama-backend.js';

export interface LocalServerInfo {
  baseUrl: string;
  port: number;
  modelPath: string;
}

export class LocalLlamaRuntime {
  private proc: ChildProcess | null = null;
  private port = 0;
  private modelPath: string | null = null;

  constructor(private readonly cqrRoot: string) {}

  async ensureServer(modelPath: string): Promise<LocalServerInfo> {
    if (!existsSync(modelPath)) {
      throw new Error('LOCAL_MODEL_MISSING');
    }

    const binary = findLlamaServerBinary(this.cqrRoot);
    if (!binary.found || !binary.path) {
      throw new Error('LLAMA_BINARY_MISSING');
    }

    if (this.proc && this.modelPath === modelPath && this.port > 0) {
      const alive = await this.healthOk(this.port);
      if (alive) {
        return { baseUrl: `http://127.0.0.1:${this.port}/v1`, port: this.port, modelPath };
      }
      this.shutdown();
    }

    this.port = await pickFreePort(18100, 18899);
    this.modelPath = modelPath;

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        binary.path!,
        [
          '-m',
          modelPath,
          '--host',
          '127.0.0.1',
          '--port',
          String(this.port),
          '-c',
          '4096',
          '-ngl',
          '0',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      this.proc = proc;

      let stderr = '';
      proc.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString();
      });

      const deadline = Date.now() + 45_000;
      const poll = setInterval(async () => {
        if (Date.now() > deadline) {
          clearInterval(poll);
          this.shutdown();
          reject(new Error(`LLAMA_SERVER_TIMEOUT: ${stderr.slice(0, 200)}`));
          return;
        }
        if (await this.healthOk(this.port)) {
          clearInterval(poll);
          resolve();
        }
      }, 500);

      proc.on('error', (e) => {
        clearInterval(poll);
        reject(e);
      });

      proc.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          clearInterval(poll);
          reject(new Error(`LLAMA_SERVER_EXIT_${code}: ${stderr.slice(0, 200)}`));
        }
      });
    });

    return { baseUrl: `http://127.0.0.1:${this.port}/v1`, port: this.port, modelPath };
  }

  shutdown(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.modelPath = null;
    this.port = 0;
  }

  private async healthOk(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

const runtimes = new Map<string, LocalLlamaRuntime>();

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function pickFreePort(min: number, max: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = min + Math.floor(Math.random() * (max - min + 1));
    if (await isPortFree(port)) return port;
  }
  throw new Error('NO_FREE_PORT');
}

export function getLocalLlamaRuntime(cqrRoot: string): LocalLlamaRuntime {
  let rt = runtimes.get(cqrRoot);
  if (!rt) {
    rt = new LocalLlamaRuntime(cqrRoot);
    runtimes.set(cqrRoot, rt);
  }
  return rt;
}

/** @internal test helper */
export async function testOllamaReachable(baseUrl: string, apiKey: string): Promise<{ ok: boolean; note: string }> {
  if (apiKey.startsWith('stub:')) {
    return { ok: true, note: 'STUB_OLLAMA_OK' };
  }
  const root = baseUrl.replace(/\/v1\/?$/, '');
  try {
    const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, note: `HTTP ${res.status}` };
    const data = (await res.json()) as { models?: unknown[] };
    const count = data.models?.length ?? 0;
    return { ok: true, note: `OK (${count} models)` };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, note: msg.slice(0, 240) };
  }
}
