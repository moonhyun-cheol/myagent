import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { publishShell } from './shell-publish.mjs';
import { publishUpdater } from './updater-publish.mjs';

export const PRODUCT_BUILD_LANES = ['defaults', 'core', 'rulebook', 'ui'];
export const RELEASE_BUILD_LANES = [...PRODUCT_BUILD_LANES, 'shell', 'updater'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'bin', 'obj', '.git', '.build']);

function hashFiles(root, inputs, exclusions = []) {
  const hash = createHash('sha256');
  const visit = (absolute) => {
    const relative = path.relative(root, absolute).replace(/\\/g, '/');
    if (exclusions.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) return;
    if (!existsSync(absolute)) {
      hash.update(`missing:${relative}\0`);
      return;
    }
    const info = statSync(absolute);
    if (info.isDirectory()) {
      for (const entry of readdirSync(absolute, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
        visit(path.join(absolute, entry.name));
      }
      return;
    }
    hash.update(`${relative}\0`);
    hash.update(createHash('sha256').update(readFileSync(absolute)).digest());
  };
  for (const input of inputs) visit(path.join(root, input));
  return hash.digest('hex');
}

function laneDefinitions(root) {
  return {
    defaults: {
      inputs: [
        'tools/sync-skill-routing.mjs',
        'tools/sync-automaton-tools.mjs',
        'tools/sync-ui-facts.mjs',
        'tools/sync-product-facts.mjs',
        'core/config/defaults/skills/manifest.json',
        'core/config/defaults/automaton-tools.manifest.json',
        'core/src/routes/dispatch.ts',
        'shell/CqrPa.Shell/MainWindow.xaml',
        'ui/workspace/src/components/GeminiNavSidebar.tsx',
        'ui/workspace/src/components/ProjectsTree.tsx',
        'ui/workspace/src/components/ConfirmModal.tsx',
        'ui/workspace/src/components/ChatPane.tsx',
        'ui/workspace/src/lib/confirmDialog.ts',
      ],
      outputs: [
        'core/config/defaults/routing.json',
        'core/config/defaults/ui-facts.json',
        'core/config/defaults/product-facts.json',
      ],
    },
    core: {
      inputs: [
        'core/src',
        'core/config/defaults',
        'tsconfig.json',
        'package.json',
        'package-lock.json',
        'tools/build-lanes.mjs',
      ],
      outputs: ['core/dist'],
    },
    rulebook: {
      inputs: ['rulebook/docs', 'manifest.json', 'tools/build-rulebook.mjs'],
      exclusions: ['rulebook/docs/generated'],
      outputs: ['rulebook/docs/generated'],
    },
    ui: {
      inputs: [
        'ui/workspace/src',
        'ui/workspace/package.json',
        'ui/workspace/package-lock.json',
        'ui/workspace/tsconfig.json',
        'ui/workspace/tsconfig.app.json',
        'ui/workspace/vite.config.ts',
      ],
      outputs: ['ui/workspace/dist'],
    },
    shell: {
      inputs: ['shell/CqrPa.Shell', 'ui/assets/my-agent-app.ico', 'tools/shell-publish.mjs'],
      outputs: ['bin/my-agent'],
    },
    updater: {
      inputs: ['shell/CqrPa.Updater', 'tools/updater-publish.mjs'],
      outputs: ['bin/my-agent-updater'],
    },
  };
}

function run(command, args, root, label) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status ?? 1})`);
}

function copyDir(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else cpSync(src, dst);
  }
}

function buildLane(root, lane) {
  if (lane === 'defaults') {
    for (const script of [
      'sync-skill-routing.mjs',
      'sync-automaton-tools.mjs',
      'sync-ui-facts.mjs',
      'sync-product-facts.mjs',
    ]) {
      run(process.execPath, [path.join(root, 'tools', script)], root, script);
    }
    return;
  }
  if (lane === 'core') {
    const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!existsSync(tsc)) throw new Error('TypeScript not found. Run: npm install');
    const output = path.join(root, 'core', 'dist');
    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
    run(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json')], root, 'core TypeScript');
    copyDir(
      path.join(root, 'core', 'config', 'defaults'),
      path.join(output, 'config', 'defaults'),
    );
    return;
  }
  if (lane === 'rulebook') {
    run(process.execPath, [path.join(root, 'tools', 'build-rulebook.mjs')], root, 'rulebook');
    return;
  }
  if (lane === 'ui') {
    if (process.platform === 'win32') {
      run(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', 'npm --prefix ui/workspace run build'],
        root,
        'workspace UI',
      );
    } else {
      run('npm', ['--prefix', 'ui/workspace', 'run', 'build'], root, 'workspace UI');
    }
    return;
  }
  if (lane === 'shell') {
    const result = publishShell({
      root,
      projPath: path.join(root, 'shell', 'CqrPa.Shell', 'CqrPa.Shell.csproj'),
      outDir: path.join(root, 'bin', 'my-agent'),
      label: 'build:smart',
    });
    if (!result.ok) throw new Error(result.reason);
    return;
  }
  if (lane === 'updater') {
    const result = publishUpdater({
      root,
      outDir: path.join(root, 'bin', 'my-agent-updater'),
      label: 'build:smart',
    });
    if (!result.ok) throw new Error(result.reason);
    return;
  }
  throw new Error(`unknown build lane: ${lane}`);
}

function receiptPath(root) {
  return path.join(root, '.build', 'build-receipt.json');
}

function readReceipt(root) {
  try {
    return JSON.parse(readFileSync(receiptPath(root), 'utf8'));
  } catch {
    return { schema: 'my-agent-build-receipt/v1', lanes: {} };
  }
}

function laneHashes(root, lane, definition) {
  return {
    source: hashFiles(root, definition.inputs, definition.exclusions),
    output: hashFiles(root, definition.outputs),
    outputsExist: definition.outputs.every((output) => existsSync(path.join(root, output))),
  };
}

export function inspectBuildLanes(root) {
  const receipt = readReceipt(root);
  const definitions = laneDefinitions(root);
  const result = {};
  for (const lane of RELEASE_BUILD_LANES) {
    const hashes = laneHashes(root, lane, definitions[lane]);
    const recorded = receipt.lanes?.[lane];
    const reason = !hashes.outputsExist
      ? 'output_missing'
      : !recorded
        ? 'receipt_missing'
        : recorded.source !== hashes.source
          ? 'source_changed'
          : recorded.output !== hashes.output
            ? 'output_changed'
            : null;
    result[lane] = { stale: Boolean(reason), reason, ...hashes };
  }
  return result;
}

export function runBuildLanes(root, { lanes = RELEASE_BUILD_LANES, force = false } = {}) {
  const selected = new Set(lanes);
  const before = inspectBuildLanes(root);
  const built = [];
  for (const lane of RELEASE_BUILD_LANES) {
    if (!selected.has(lane)) continue;
    const dependencyStale = lane === 'core' && built.includes('defaults');
    if (!force && !before[lane].stale && !dependencyStale) continue;
    console.log(`build lane: ${lane} (${force ? 'forced' : before[lane].reason ?? 'dependency'})`);
    buildLane(root, lane);
    built.push(lane);
  }

  const receipt = readReceipt(root);
  receipt.schema = 'my-agent-build-receipt/v1';
  receipt.generated_at = new Date().toISOString();
  receipt.lanes ??= {};
  const definitions = laneDefinitions(root);
  for (const lane of built) {
    const hashes = laneHashes(root, lane, definitions[lane]);
    if (!hashes.outputsExist) throw new Error(`${lane} output is missing after build`);
    receipt.lanes[lane] = {
      source: hashes.source,
      output: hashes.output,
      built_at: new Date().toISOString(),
    };
  }
  mkdirSync(path.dirname(receiptPath(root)), { recursive: true });
  writeFileSync(receiptPath(root), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return { built, status: inspectBuildLanes(root) };
}
