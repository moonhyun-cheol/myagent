import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isGgufMagic } from '../models/model-registry.js';

export interface LlamaBinaryInfo {
  found: boolean;
  path: string | null;
}

export function findLlamaServerBinary(cqrRoot: string): LlamaBinaryInfo {
  const candidates = [
    path.join(cqrRoot, 'runtime', 'llama-cpp', 'llama-server.exe'),
    path.join(cqrRoot, 'runtime', 'llama-cpp', 'server.exe'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { found: true, path: p };
  }
  return { found: false, path: null };
}

/** Lightweight validation without loading full model weights. */
export function quickVerifyGguf(modelPath: string): { ok: boolean; note: string } {
  if (!existsSync(modelPath)) {
    return { ok: false, note: 'FILE_MISSING' };
  }
  const st = statSync(modelPath);
  if (st.size < 1024) {
    return { ok: false, note: 'FILE_TOO_SMALL' };
  }
  if (!isGgufMagic(modelPath)) {
    return { ok: false, note: 'NOT_GGUF_MAGIC' };
  }
  return { ok: true, note: 'GGUF_MAGIC_OK' };
}

/** Deep verify: spawn llama-server briefly if binary present. */
export async function deepVerifyWithServer(
  modelPath: string,
  binaryPath: string,
  timeoutMs = 15000,
): Promise<{ ok: boolean; note: string }> {
  const quick = quickVerifyGguf(modelPath);
  if (!quick.ok) return quick;

  const port = 18080 + Math.floor(Math.random() * 1000);
  return new Promise((resolve) => {
    const proc = spawn(
      binaryPath,
      ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-c', '512', '-ngl', '0'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );

    let stderr = '';
    proc.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });

    const timer = setTimeout(() => {
      proc.kill();
      resolve({ ok: false, note: 'LLAMA_SERVER_TIMEOUT' });
    }, timeoutMs);

    const poll = setInterval(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          clearInterval(poll);
          clearTimeout(timer);
          proc.kill();
          resolve({ ok: true, note: 'LLAMA_SERVER_HEALTH_OK' });
        }
      } catch {
        /* not ready */
      }
    }, 400);

    proc.on('exit', (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        resolve({ ok: false, note: `LLAMA_SERVER_EXIT_${code}: ${stderr.slice(0, 200)}` });
      }
    });
  });
}
