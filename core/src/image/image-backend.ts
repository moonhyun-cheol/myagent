import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { IImageBackend, ImageGenRequest, ImageGenResult } from './types.js';
import { OpenAiImageBackend } from './openai-image.js';
import type { ProviderStore } from '../providers/provider-store.js';

const STUB_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export function findSdBinary(cqrRoot: string): string | null {
  const p = path.join(cqrRoot, 'runtime', 'sd-cpp', 'sd.exe');
  return existsSync(p) ? p : null;
}

export class StubImageBackend implements IImageBackend {
  readonly name = 'stub';

  isAvailable(): boolean {
    return true;
  }

  async generate(req: ImageGenRequest, outputPath: string): Promise<ImageGenResult> {
    writeFileSync(outputPath, STUB_PNG);
    const meta = outputPath + '.json';
    writeFileSync(
      meta,
      JSON.stringify({ prompt: req.prompt, stub: true, init: req.initImagePath ?? null }, null, 2),
    );
    return {
      output_path: outputPath,
      url: '',
      mime: 'image/png',
      backend_used: this.name,
      seed: Math.floor(Math.random() * 1_000_000),
      stub: true,
    };
  }
}

export class SdCppBackend implements IImageBackend {
  readonly name = 'sd-cpp';

  constructor(private readonly binaryPath: string) {}

  isAvailable(): boolean {
    return existsSync(this.binaryPath);
  }

  async generate(req: ImageGenRequest, outputPath: string): Promise<ImageGenResult> {
    const modelDir = path.dirname(req.initImagePath ?? outputPath);
    const args = [
      '-p',
      req.prompt,
      '-o',
      outputPath,
      '-W',
      String(req.width ?? 512),
      '-H',
      String(req.height ?? 512),
    ];
    if (req.initImagePath && existsSync(req.initImagePath)) {
      args.push('-i', req.initImagePath);
    }

    await runProcess(this.binaryPath, args, 120_000);
    if (!existsSync(outputPath)) {
      throw new Error('SD_OUTPUT_MISSING');
    }
    return {
      output_path: outputPath,
      url: '',
      mime: 'image/png',
      backend_used: this.name,
      seed: Math.floor(Math.random() * 1_000_000),
      stub: false,
    };
  }
}

export class AutoImageBackend implements IImageBackend {
  readonly name = 'auto';
  private backends: IImageBackend[];

  constructor(cqrRoot: string, providerStore?: ProviderStore) {
    this.backends = [];
    if (providerStore) {
      const openai = providerStore.resolveProvider('openai');
      if (openai?.secret.api_key) {
        this.backends.push(
          new OpenAiImageBackend(
            openai.baseUrl,
            openai.secret.api_key,
            openai.secret.model_id?.startsWith('dall-e') ? openai.secret.model_id : 'dall-e-3',
          ),
        );
      }
    }
    const sd = findSdBinary(cqrRoot);
    if (sd) this.backends.push(new SdCppBackend(sd));
    this.backends.push(new StubImageBackend());
  }

  isAvailable(): boolean {
    return true;
  }

  async generate(req: ImageGenRequest, outputPath: string): Promise<ImageGenResult> {
    for (const b of this.backends) {
      if (!b.isAvailable()) continue;
      try {
        return await b.generate(req, outputPath);
      } catch {
        continue;
      }
    }
    return new StubImageBackend().generate(req, outputPath);
  }
}

function runProcess(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    const t = setTimeout(() => {
      proc.kill();
      reject(new Error('SD_TIMEOUT'));
    }, timeoutMs);
    proc.on('error', reject);
    proc.on('exit', (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error(`SD_EXIT_${code}`));
    });
  });
}

export function readImageMeta(outputPath: string): Record<string, unknown> | null {
  const meta = outputPath + '.json';
  if (!existsSync(meta)) return null;
  try {
    return JSON.parse(readFileSync(meta, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
