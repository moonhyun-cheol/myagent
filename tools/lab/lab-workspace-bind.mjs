#!/usr/bin/env node
/**
 * Shared Dev workspace binding for live labs.
 * Knowledge/product turns need the MY Agent product root;
 * coding mutate cases use the isolated realuse toy app.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function productRoot() {
  return root;
}

export function realuseAppRoot() {
  return path.join(root, 'data', '_realuse_lab', 'app');
}

/** Seed fixtures/cqrpa-realuse-app → data/_realuse_lab/app for coding live bars. */
export function ensureRealuseApp() {
  const dest = realuseAppRoot();
  const src = path.join(root, 'tools', 'lab', 'fixtures', 'cqrpa-realuse-app');
  if (!existsSync(src)) {
    mkdirSync(dest, { recursive: true });
    writeFileSync(
      path.join(dest, 'README.md'),
      '# realuse stub\n\n# live-bt-ok-seed\n',
      'utf8',
    );
    writeFileSync(
      path.join(dest, 'package.json'),
      JSON.stringify(
        {
          name: 'cqrpa-realuse-app',
          private: true,
          scripts: {
            test: 'node -e "console.log(\'cqrpa-realuse-app test OK\')"',
            check: 'node -e "console.log(\'check OK\')"',
            build: 'node -e "require(\'fs\').mkdirSync(\'dist\',{recursive:true}); require(\'fs\').writeFileSync(\'dist/index.html\',\'ok\')"',
          },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    return dest;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  if (existsSync(dest)) {
    try {
      rmSync(dest, { recursive: true, force: true });
    } catch {
      /* keep existing */
    }
  }
  try {
    cpSync(src, dest, { recursive: true });
  } catch {
    mkdirSync(dest, { recursive: true });
  }
  return dest;
}

/**
 * PUT /config/dev-workspace
 * @param {string} base API base
 * @param {string} absPath workspace root
 */
export async function bindDevWorkspace(base, absPath) {
  const url = `${String(base).replace(/\/$/, '')}/config/dev-workspace`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dev_workspace_root: absPath }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`dev-workspace bind ${res.status}: ${t.slice(0, 240)}`);
  }
  return res.json().catch(() => ({}));
}

/**
 * @param {string} base
 * @param {'knowledge'|'coding'|'secretary'|string} plane
 */
export async function bindWorkspaceForPlane(base, plane) {
  if (plane === 'coding') {
    const app = ensureRealuseApp();
    await bindDevWorkspace(base, app);
    return app;
  }
  const prod = productRoot();
  await bindDevWorkspace(base, prod);
  return prod;
}
