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

export function readApiPortDefault(cqrRoot: string, fallback = 10200): number {
  try {
    const raw = readFileSync(path.join(cqrRoot, 'manifest.json'), 'utf8');
    const doc = JSON.parse(raw) as { api_port_default?: unknown };
    const port = Number(doc.api_port_default);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
  } catch {
    return fallback;
  }
}
