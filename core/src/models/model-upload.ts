import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { assertWritablePath } from '../security/path-guard.js';
import { parseMultipart } from '../attachments/multipart.js';
import { sanitizeFilename } from '../attachments/types.js';
import type { ModelRegistry } from './model-registry.js';
import type { ModelKind, ModelRecord, ModelRegistryFile } from './types.js';

const LLM_EXT = new Set(['.gguf']);
const IMAGE_EXT = new Set(['.safetensors', '.ckpt']);

export class ModelUploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ModelUploadError';
  }
}

export class ModelUploadService {
  constructor(
    private readonly registry: ModelRegistry,
    private readonly cqrRoot: string,
    private readonly maxBytes: number,
  ) {}

  async uploadFromRequest(req: IncomingMessage): Promise<{
    models: ModelRecord[];
    registry: ModelRegistryFile;
  }> {
    const files = await parseMultipart(req);
    if (files.length === 0) {
      throw new ModelUploadError('NO_FILES', '업로드할 파일이 없습니다.');
    }

    const imported: ModelRecord[] = [];
    let doc: ModelRegistryFile | null = null;

    for (const file of files) {
      const result = this.importBuffer(file.filename, file.data);
      imported.push(result.model);
      doc = result.registry;
    }

    return { models: imported, registry: doc! };
  }

  importBuffer(
    originalName: string,
    data: Buffer,
  ): { model: ModelRecord; registry: ModelRegistryFile } {
    if (data.length > this.maxBytes) {
      throw new ModelUploadError(
        'FILE_TOO_LARGE',
        `모델 파일 최대 ${this.maxBytes} bytes`,
      );
    }

    const ext = path.extname(originalName).toLowerCase();
    let kind: ModelKind;
    if (LLM_EXT.has(ext)) kind = 'llm';
    else if (IMAGE_EXT.has(ext)) kind = 'image';
    else {
      throw new ModelUploadError(
        'EXTENSION_NOT_ALLOWED',
        '허용: .gguf (LLM), .safetensors / .ckpt (이미지)',
      );
    }

    const safeName = sanitizeFilename(originalName);
    const targetDir = this.registry.kindDir(kind);
    mkdirSync(targetDir, { recursive: true });

    const dest = uniqueDestPath(targetDir, safeName);
    assertWritablePath(dest, this.cqrRoot);
    writeFileSync(dest, data);

    const doc = this.registry.scan();
    const rel = path.relative(this.registry.modelsRoot, dest).replace(/\\/g, '/');
    const model = doc.models.find((m) => m.rel_path === rel);
    if (!model) {
      throw new ModelUploadError('IMPORT_FAILED', '스캔 후 모델을 찾지 못했습니다.');
    }
    return { model, registry: doc };
  }
}

function uniqueDestPath(dir: string, filename: string): string {
  let dest = path.join(dir, filename);
  if (!existsSync(dest)) return dest;
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let n = 1;
  while (existsSync(dest)) {
    dest = path.join(dir, `${base} (${n})${ext}`);
    n += 1;
  }
  return dest;
}
