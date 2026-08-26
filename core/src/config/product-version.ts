import { readFileSync } from 'node:fs';
import path from 'node:path';

export function readProductVersion(cqrRoot: string): string {
  try {
    const raw = readFileSync(path.join(cqrRoot, 'manifest.json'), 'utf8');
    const doc = JSON.parse(raw) as { version?: string };
    return doc.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
