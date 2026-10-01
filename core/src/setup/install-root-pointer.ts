/**
 * Install-root pointer — producer side of the WorkKitLauncher contract
 * (company repo `manager/INSTALL-ROOT-POINTER.md`).
 *
 * File: %LOCALAPPDATA%\MYAgent\install-root.json (outside the install root).
 * Written by the installer right after INSTALL-DONE.txt and by the core on every boot,
 * so moved/restored/updated/reinstalled trees self-heal the pointer. Last write wins.
 *
 * Contract: never throw — a pointer failure must not block install or startup.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const INSTALL_ROOT_POINTER_DIR = 'MYAgent';
export const INSTALL_ROOT_POINTER_FILE = 'install-root.json';

export interface InstallRootPointerDoc {
  install_root: string;
  cqr_root?: string;
  updated_at?: string;
  manifest_version?: string;
}

export interface InstallRootPointerResult {
  ok: boolean;
  path: string | null;
  error?: string;
  doc?: InstallRootPointerDoc;
}

export interface InstallRootPointerOptions {
  /** Override %LOCALAPPDATA% (tests). Defaults to process.env.LOCALAPPDATA. */
  localAppData?: string;
  now?: Date;
  /** Optional sink for the failure log line (never required). */
  log?: (line: string) => void;
}

export function resolveInstallRootPointerPath(localAppData = process.env.LOCALAPPDATA): string | null {
  const base = localAppData?.trim();
  if (!base) return null;
  return path.join(base, INSTALL_ROOT_POINTER_DIR, INSTALL_ROOT_POINTER_FILE);
}

function readManifestVersion(cqrRoot: string): string | undefined {
  try {
    const doc = JSON.parse(readFileSync(path.join(cqrRoot, 'manifest.json'), 'utf8')) as { version?: unknown };
    return typeof doc.version === 'string' && doc.version.trim() ? doc.version.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Atomic (temp write + rename) pointer write. Swallows every error. */
export function writeInstallRootPointer(
  cqrRoot: string,
  opts: InstallRootPointerOptions = {},
): InstallRootPointerResult {
  let target: string | null = null;
  let temp: string | null = null;
  try {
    target = resolveInstallRootPointerPath(opts.localAppData ?? process.env.LOCALAPPDATA);
    if (!target) throw new Error('LOCALAPPDATA_UNSET');
    const root = path.resolve(cqrRoot);
    const doc: InstallRootPointerDoc = {
      install_root: root,
      cqr_root: root,
      updated_at: (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
    const version = readManifestVersion(root);
    if (version) doc.manifest_version = version;
    mkdirSync(path.dirname(target), { recursive: true });
    temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    renameSync(temp, target);
    temp = null;
    return { ok: true, path: target, doc };
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    if (temp) {
      try {
        rmSync(temp, { force: true });
      } catch {
        /* ignore */
      }
    }
    try {
      opts.log?.(`install-root-pointer write failed: ${error}`);
    } catch {
      /* ignore */
    }
    return { ok: false, path: target, error };
  }
}
