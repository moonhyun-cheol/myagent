import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const OPTIONAL_RUNTIME_IDS = ['playwright', 'ffmpeg', 'markitdown', 'repomix', 'ast_grep'] as const;
export type OptionalRuntimeId = (typeof OPTIONAL_RUNTIME_IDS)[number];

function expandOptionalRuntimeId(id: string): OptionalRuntimeId[] {
  const clean = id.trim().toLowerCase();
  if (clean === 'oss_sidecars') return ['markitdown', 'repomix', 'ast_grep'];
  if ((OPTIONAL_RUNTIME_IDS as readonly string[]).includes(clean)) return [clean as OptionalRuntimeId];
  return [];
}

export interface CatalogFeature {
  id: string;
  label: string;
  summary: string;
  detail?: string;
}

export interface CatalogOptionalRuntime extends CatalogFeature {
  size_hint?: string;
  bootstrap: string;
  markers: string[];
  default_selected?: boolean;
}

export interface OptionalRuntimeCatalog {
  version: number;
  core_features: CatalogFeature[];
  license_features: CatalogFeature[];
  later_streams: CatalogFeature[];
  optional_runtimes: CatalogOptionalRuntime[];
}

export interface OptionalRuntimeSelection {
  version: number;
  selected: string[];
  skipped: string[];
  updated_at?: string;
}

export interface OptionalRuntimeStatusItem {
  id: string;
  label: string;
  summary: string;
  detail?: string;
  size_hint?: string;
  selected: boolean;
  installed: boolean;
  missing_markers: string[];
}

let installLock: Promise<unknown> | null = null;

function catalogPath(cqrRoot: string): string {
  return path.join(cqrRoot, 'core', 'config', 'defaults', 'optional-runtimes.json');
}

function selectionPath(cqrRoot: string): string {
  return path.join(cqrRoot, 'data', 'config', 'optional-runtimes.json');
}

export function loadOptionalRuntimeCatalog(cqrRoot: string): OptionalRuntimeCatalog {
  const raw = JSON.parse(readFileSync(catalogPath(cqrRoot), 'utf8')) as OptionalRuntimeCatalog;
  if (!Array.isArray(raw.optional_runtimes) || !Array.isArray(raw.core_features)) {
    throw new Error('optional-runtimes catalog is invalid');
  }
  return raw;
}

function catalogDefaultIds(cqrRoot: string): OptionalRuntimeId[] {
  try {
    return loadOptionalRuntimeCatalog(cqrRoot)
      .optional_runtimes.filter((item) => item.default_selected)
      .map((item) => item.id)
      .filter((id): id is OptionalRuntimeId => (OPTIONAL_RUNTIME_IDS as readonly string[]).includes(id));
  } catch {
    return ['repomix', 'ast_grep'];
  }
}

function emptySelection(cqrRoot: string): OptionalRuntimeSelection {
  const selected = catalogDefaultIds(cqrRoot);
  return {
    version: 1,
    selected,
    skipped: OPTIONAL_RUNTIME_IDS.filter((id) => !selected.includes(id)),
  };
}

export function loadOptionalRuntimeSelection(cqrRoot: string): OptionalRuntimeSelection {
  const fp = selectionPath(cqrRoot);
  if (!existsSync(fp)) {
    return emptySelection(cqrRoot);
  }
  try {
    const doc = JSON.parse(readFileSync(fp, 'utf8')) as Partial<OptionalRuntimeSelection>;
    const selected = [
      ...new Set(
        (Array.isArray(doc.selected) ? doc.selected : []).flatMap((id) =>
          typeof id === 'string' ? expandOptionalRuntimeId(id) : [],
        ),
      ),
    ];
    const skipped = OPTIONAL_RUNTIME_IDS.filter((id) => !selected.includes(id));
    return {
      version: 1,
      selected,
      skipped,
      updated_at: typeof doc.updated_at === 'string' ? doc.updated_at : undefined,
    };
  } catch {
    return emptySelection(cqrRoot);
  }
}

export function saveOptionalRuntimeSelection(
  cqrRoot: string,
  selected: string[],
): OptionalRuntimeSelection {
  const unique = [...new Set(selected.flatMap((id) => expandOptionalRuntimeId(id)))];
  const doc: OptionalRuntimeSelection = {
    version: 1,
    selected: unique,
    skipped: OPTIONAL_RUNTIME_IDS.filter((id) => !unique.includes(id)),
    updated_at: new Date().toISOString(),
  };
  const dest = selectionPath(cqrRoot);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return doc;
}

function markersMissing(cqrRoot: string, markers: string[]): string[] {
  return markers.filter((rel) => !existsSync(path.join(cqrRoot, ...rel.split('/'))));
}

export function describeOptionalRuntimes(cqrRoot: string): {
  catalog: OptionalRuntimeCatalog;
  selection: OptionalRuntimeSelection;
  optionals: OptionalRuntimeStatusItem[];
} {
  const catalog = loadOptionalRuntimeCatalog(cqrRoot);
  const selection = loadOptionalRuntimeSelection(cqrRoot);
  const optionals = catalog.optional_runtimes.map((item) => {
    const missing = markersMissing(cqrRoot, item.markers ?? []);
    return {
      id: item.id,
      label: item.label,
      summary: item.summary,
      detail: item.detail,
      size_hint: item.size_hint,
      selected: selection.selected.includes(item.id),
      installed: missing.length === 0,
      missing_markers: missing,
    };
  });
  return { catalog, selection, optionals };
}

function powershellExe(): string {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function runPowershellFile(
  cqrRoot: string,
  script: string,
  extraArgs: string[],
): Promise<{ ok: boolean; code: number; log: string }> {
  if (!existsSync(script)) {
    return Promise.resolve({ ok: false, code: 1, log: `missing ${script}` });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn(
      powershellExe(),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...extraArgs],
      {
        cwd: cqrRoot,
        windowsHide: true,
        env: { ...process.env, MY_AGENT_INSTALL_SKIP_OPTIONAL: '0' },
      },
    );
    child.stdout?.on('data', (d: Buffer) => chunks.push(d));
    child.stderr?.on('data', (d: Buffer) => chunks.push(d));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, 20 * 60 * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const log = Buffer.concat(chunks).toString('utf8').trim();
      resolve({ ok: (code ?? 1) === 0, code: code ?? 1, log });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 1, log: err.message });
    });
  });
}

export async function installOptionalRuntimes(
  cqrRoot: string,
  ids: string[],
): Promise<{ ok: boolean; installed: string[]; log: string; selection: OptionalRuntimeSelection }> {
  const wanted = [...new Set(ids.flatMap((id) => expandOptionalRuntimeId(id)))];
  if (wanted.length === 0) {
    return {
      ok: false,
      installed: [],
      log: 'No valid optional runtime ids',
      selection: loadOptionalRuntimeSelection(cqrRoot),
    };
  }
  if (installLock) {
    const err = new Error('OPTIONAL_RUNTIME_BUSY');
    (err as Error & { code?: string }).code = 'OPTIONAL_RUNTIME_BUSY';
    throw err;
  }
  const catalog = loadOptionalRuntimeCatalog(cqrRoot);
  const work = (async () => {
    const logs: string[] = [];
    const installed: string[] = [];
    for (const id of wanted) {
      const item = catalog.optional_runtimes.find((entry) => entry.id === id);
      const rel = item?.bootstrap ?? `tools/bootstrap-${id}-if-needed.ps1`;
      const script = path.join(cqrRoot, ...rel.split('/'));
      const result = await runPowershellFile(cqrRoot, script, ['-Root', cqrRoot]);
      logs.push(result.log || `${id} exit ${result.code}`);
      if (!result.ok) {
        return { ok: false, installed, log: logs.join('\n').slice(-4000) };
      }
      installed.push(id);
    }
    const prev = loadOptionalRuntimeSelection(cqrRoot);
    saveOptionalRuntimeSelection(cqrRoot, [...prev.selected, ...installed]);
    return { ok: true, installed, log: logs.join('\n').slice(-4000) };
  })();
  installLock = work;
  try {
    const result = await work;
    return { ...result, selection: loadOptionalRuntimeSelection(cqrRoot) };
  } finally {
    installLock = null;
  }
}
