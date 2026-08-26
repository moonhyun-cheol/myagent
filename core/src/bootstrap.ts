import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BootstrapPaths {
  cqrRoot: string;
  coreDir: string;
  dataDir: string;
  vaultDir: string;
  attachmentsDir: string;
  logsDir: string;
  runtimeNode: string;
}

export function resolveCqrRootFromModule(metaUrl: string): string {
  const fromEnv = process.env.MY_AGENT_ROOT?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const here = path.dirname(fileURLToPath(metaUrl));
  return path.resolve(here, '..', '..');
}

export function resolveCqrRoot(): string {
  return resolveCqrRootFromModule(import.meta.url);
}

export function getBootstrapPaths(cqrRoot?: string): BootstrapPaths {
  const root = cqrRoot ?? resolveCqrRoot();
  return {
    cqrRoot: root,
    coreDir: path.join(root, 'core'),
    dataDir: path.join(root, 'data'),
    vaultDir: path.join(root, 'data', 'vault'),
    attachmentsDir: path.join(root, 'data', 'attachments'),
    logsDir: path.join(root, 'logs'),
    runtimeNode: path.join(root, 'runtime', 'node', 'node.exe'),
  };
}

export function ensureDataDirs(paths: BootstrapPaths): void {
  const dirs = [
    paths.dataDir,
    paths.vaultDir,
    path.join(paths.dataDir, 'config'),
    path.join(paths.dataDir, 'profile'),
    path.join(paths.dataDir, 'sessions'),
    path.join(paths.dataDir, 'projects'),
    path.join(paths.dataDir, 'skills'),
    path.join(paths.dataDir, 'agent-plugins'),
    path.join(paths.dataDir, 'models', 'llm'),
    path.join(paths.dataDir, 'models', 'image'),
    path.join(paths.dataDir, 'outputs', 'images'),
    path.join(paths.dataDir, 'outputs', 'research'),
    path.join(paths.dataDir, 'outputs', 'browser'),
    path.join(paths.dataDir, 'outputs', 'crawl'),
    path.join(paths.dataDir, 'outputs', 'web'),
    paths.attachmentsDir,
    paths.logsDir,
  ];
  for (const d of dirs) {
    mkdirSync(d, { recursive: true });
  }
}
