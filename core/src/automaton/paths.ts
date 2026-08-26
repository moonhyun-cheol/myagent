import { existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const DEFAULT_AUTOMATON = 'C:\\minyoung_coding\\my_live_automaton';

export function resolveAutomatonRoot(configured?: string): string | null {
  const candidates = [
    process.env.LIVE_AUTOMATON_ROOT?.trim(),
    configured?.trim(),
    DEFAULT_AUTOMATON,
  ].filter(Boolean) as string[];

  for (const raw of candidates) {
    const resolved = path.resolve(raw);
    if (existsSync(path.join(resolved, '00_python_file'))) {
      return resolved;
    }
  }
  return null;
}

export function resolveAutomatonPython(automatonRoot: string): string | null {
  // workspace_paths.resolve_live_automaton_python_candidates 와 동일 순서:
  // 부모 워크스페이스 .venv → repo .venv (공용 venv에 runtime deps가 더 완비된 경우가 많음)
  const candidates = [
    process.env.LIVE_AUTOMATON_PYTHON,
    path.join(path.dirname(automatonRoot), '.venv', 'Scripts', 'python.exe'),
    path.join(automatonRoot, '.venv', 'Scripts', 'python.exe'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return path.resolve(candidate);
  }
  return null;
}

export function pythonFileRoot(automatonRoot: string): string {
  return path.join(automatonRoot, '00_python_file');
}

export function buildAutomatonJsonOutputPath(automatonRoot: string, commandId: string): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const rid = randomBytes(6).toString('hex');
  const dir = path.join(automatonRoot, 'data', 'output', 'mcp');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${commandId}_${ts}Z_${rid}.json`);
}
