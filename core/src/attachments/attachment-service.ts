import { randomUUID } from 'node:crypto';
import {
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { assertWritablePath } from '../security/path-guard.js';
import { parseMultipart } from './multipart.js';
import {
  type AttachmentRecord,
  mimeFromFilename,
  sanitizeFilename,
} from './types.js';

export class AttachmentService {
  constructor(
    private readonly attachmentsDir: string,
    private readonly cqrRoot: string,
    private readonly maxBytes: number,
  ) {}

  async uploadFromRequest(req: IncomingMessage, sessionId: string): Promise<AttachmentRecord[]> {
    const files = await parseMultipart(req);
    if (files.length === 0) {
      throw new UploadError('NO_FILES', 'No files in upload');
    }

    const saved: AttachmentRecord[] = [];
    for (const file of files) {
      saved.push(this.saveFile(sessionId, file.filename, file.data, file.contentType));
    }
    return saved;
  }

  saveFile(
    sessionId: string,
    originalName: string,
    data: Buffer,
    contentTypeHint?: string,
  ): AttachmentRecord {
    if (data.length > this.maxBytes) {
      throw new UploadError('FILE_TOO_LARGE', `Max ${this.maxBytes} bytes`);
    }

    const mime = mimeFromFilename(originalName);
    const safeName = sanitizeFilename(originalName);
    const id = randomUUID();
    const sessionDir = path.join(this.attachmentsDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });

    const storedName = `${id}_${safeName}`;
    const storedPath = path.join(sessionDir, storedName);
    assertWritablePath(storedPath, this.cqrRoot);
    writeFileSync(storedPath, data);

    return {
      id,
      session_id: sessionId,
      original_name: originalName,
      stored_path: storedPath,
      mime: contentTypeHint?.split(';')[0]?.trim() || mime,
      size_bytes: data.length,
      created_at: new Date().toISOString(),
    };
  }

  get(id: string, sessionId?: string): AttachmentRecord | null {
    for (const dir of this.sessionDirs(sessionId)) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(`${id}_`)) continue;
        const storedPath = path.join(dir, name);
        const stat = statSync(storedPath);
        const original_name = name.slice(id.length + 1);
        return {
          id,
          session_id: path.basename(dir),
          original_name,
          stored_path: storedPath,
          mime: mimeFromFilename(original_name),
          size_bytes: stat.size,
          created_at: stat.mtime.toISOString(),
        };
      }
    }
    return null;
  }

  delete(id: string, sessionId?: string): boolean {
    const rec = this.get(id, sessionId);
    if (!rec) return false;
    assertWritablePath(rec.stored_path, this.cqrRoot);
    unlinkSync(rec.stored_path);
    return true;
  }

  readBytes(id: string, sessionId?: string): Buffer | null {
    const rec = this.get(id, sessionId);
    if (!rec || !existsSync(rec.stored_path)) return null;
    return readFileSync(rec.stored_path);
  }

  private sessionDirs(sessionId?: string): string[] {
    if (sessionId) return [path.join(this.attachmentsDir, sessionId)];
    if (!existsSync(this.attachmentsDir)) return [];
    return readdirSync(this.attachmentsDir)
      .map((n) => path.join(this.attachmentsDir, n))
      .filter((p) => statSync(p).isDirectory());
  }
}

export class UploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}
