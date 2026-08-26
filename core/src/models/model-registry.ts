import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';
import type { ModelKind, ModelRecord, ModelRegistryFile } from './types.js';

const LLM_EXT = new Set(['.gguf']);
const IMAGE_EXT = new Set(['.safetensors', '.ckpt']);

export class ModelRegistry {
  private registryPath: string;

  constructor(
    readonly modelsRoot: string,
    private readonly cqrRoot: string,
  ) {
    this.registryPath = path.join(modelsRoot, 'registry.json');
  }

  kindDir(kind: ModelKind): string {
    return path.join(this.modelsRoot, kind);
  }

  load(): ModelRegistryFile {
    if (!existsSync(this.registryPath)) {
      return { version: 1, default_llm_id: null, default_image_id: null, models: [] };
    }
    try {
      const doc = JSON.parse(readFileSync(this.registryPath, 'utf8')) as ModelRegistryFile;
      return {
        version: 1,
        default_llm_id: doc.default_llm_id ?? null,
        default_image_id: doc.default_image_id ?? null,
        models: Array.isArray(doc.models) ? doc.models : [],
      };
    } catch {
      return { version: 1, default_llm_id: null, default_image_id: null, models: [] };
    }
  }

  save(doc: ModelRegistryFile): void {
    assertWritablePath(this.registryPath, this.cqrRoot);
    writeFileSync(this.registryPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  }

  scan(): ModelRegistryFile {
    const prev = this.load();
    const found: ModelRecord[] = [];
    const now = new Date().toISOString();

    this.walkKind('llm', path.join(this.modelsRoot, 'llm'), LLM_EXT, found, now);
    this.walkKind('image', path.join(this.modelsRoot, 'image'), IMAGE_EXT, found, now);

    const prevByPath = new Map(prev.models.map((m) => [m.rel_path, m]));
    for (const m of found) {
      const old = prevByPath.get(m.rel_path);
      if (old) {
        m.last_verified = old.last_verified;
        m.verified_ok = old.verified_ok;
        m.verify_note = old.verify_note;
      }
    }

    let defaultLlm = prev.default_llm_id;
    let defaultImage = prev.default_image_id;
    if (defaultLlm && !found.some((m) => m.id === defaultLlm)) defaultLlm = null;
    if (defaultImage && !found.some((m) => m.id === defaultImage)) defaultImage = null;

    const doc: ModelRegistryFile = {
      version: 1,
      default_llm_id: defaultLlm,
      default_image_id: defaultImage,
      models: found,
    };
    this.save(doc);
    return doc;
  }

  setDefault(kind: ModelKind, id: string | null): ModelRegistryFile {
    const doc = this.load();
    if (id) {
      const m = doc.models.find((x) => x.id === id && x.kind === kind);
      if (!m) throw new Error('MODEL_NOT_FOUND');
    }
    if (kind === 'llm') doc.default_llm_id = id;
    else doc.default_image_id = id;
    this.save(doc);
    return doc;
  }

  updateVerification(id: string, ok: boolean, note: string | null): ModelRegistryFile {
    const doc = this.load();
    const m = doc.models.find((x) => x.id === id);
    if (!m) throw new Error('MODEL_NOT_FOUND');
    m.verified_ok = ok;
    m.verify_note = note;
    m.last_verified = new Date().toISOString();
    this.save(doc);
    return doc;
  }

  getById(id: string): ModelRecord | undefined {
    return this.load().models.find((m) => m.id === id);
  }

  private walkKind(
    kind: ModelKind,
    dir: string,
    exts: Set<string>,
    out: ModelRecord[],
    now: string,
  ): void {
    if (!existsSync(dir)) return;
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const name of readdirSync(current)) {
        const full = path.join(current, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          stack.push(full);
          continue;
        }
        const ext = path.extname(name).toLowerCase();
        if (!exts.has(ext)) continue;
        const rel = path.relative(this.modelsRoot, full).replace(/\\/g, '/');
        out.push({
          id: stableId(rel),
          kind,
          filename: name,
          path: full,
          rel_path: rel,
          format: ext.slice(1),
          size_bytes: st.size,
          last_scanned: now,
          last_verified: null,
          verified_ok: null,
          verify_note: null,
        });
      }
    }
  }
}

function stableId(relPath: string): string {
  return createHash('sha256').update(relPath, 'utf8').digest('hex').slice(0, 16);
}

export function isGgufMagic(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const buf = readFileSync(filePath).subarray(0, 4);
  return buf.toString('utf8') === 'GGUF';
}

/** Remove registry file (dev reset only). */
export function clearRegistry(registryPath: string, cqrRoot: string): void {
  if (existsSync(registryPath)) {
    assertWritablePath(registryPath, cqrRoot);
    unlinkSync(registryPath);
  }
}
