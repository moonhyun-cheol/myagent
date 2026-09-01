#!/usr/bin/env node
/**
 * Work kits (locker shelves) + local overlay profiles + feed catalog.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  applyAgentProfile,
  applyWorkKit,
  deleteAgentProfile,
  getAppliedProfileState,
  hasProfileLastState,
  listAgentProfiles,
  listWorkKitProfileCatalog,
  restoreAgentProfileLastState,
  saveAgentProfile,
  AgentProfileError,
} from '../core/dist/config/agent-profile-store.js';
import {
  installAgentPlugin,
  setAgentPluginEnabled,
} from '../core/dist/agent/agent-plugin-store.js';
import {
  installWorkKitShelf,
  refreshWorkKitCatalog,
} from '../core/dist/updates/work-kit-catalog-feed.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(path.join(tmpdir(), 'myagent-profile-'));
const locker = mkdtempSync(path.join(tmpdir(), 'myagent-locker-'));

function installDemo(id, name) {
  const raw = installAgentPlugin(root, {
    id,
    confirm: true,
    tool_json: {
      name,
      description: `profile test ${id}`,
      risk: 'read',
      parameters: { type: 'object', properties: {} },
      runner: { kind: 'node', entry: 'run.mjs' },
    },
    run_source: 'export default async () => ({ ok: true });\n',
  });
  const doc = JSON.parse(raw);
  assert.equal(doc.ok, true, `install ${id}: ${raw}`);
}

try {
  // --- overlay presets (legacy) ---
  assert.deepEqual(listAgentProfiles(root), []);
  installDemo('demo_a', 'plugin_demo_a');
  installDemo('demo_b', 'plugin_demo_b');
  setAgentPluginEnabled(root, { id: 'demo_a', enabled: true, confirm: true });
  setAgentPluginEnabled(root, { id: 'demo_b', enabled: false, confirm: true });

  const saved = saveAgentProfile(root, {
    id: 'overlay-dev',
    label: '오버레이',
    plugins: { enable: { demo_a: false, demo_b: true } },
    ui: { pinned_skill_ids: [], default_skill_mode: 'web_dev' },
  });
  assert.equal(saved.id, 'overlay-dev');

  const appliedOverlay = applyAgentProfile(root, {
    id: 'overlay-dev',
    confirm: true,
    knownSkillModes: ['web_dev', 'chat'],
  });
  assert.equal(appliedOverlay.ok, true);
  assert.equal(getAppliedProfileState(root)?.origin, 'overlay');
  restoreAgentProfileLastState(root, { confirm: true });
  assert.equal(deleteAgentProfile(root, 'overlay-dev'), true);

  // --- feed catalog + per-shelf install ---
  const feedPath = path.join(locker, 'mock-work-kits.json');
  writeFileSync(
    feedPath,
    JSON.stringify({
      channel: 'test',
      sequence: 1,
      groups: [
        {
          id: 'cqr',
          label: 'CQR',
          order: 10,
          shelves: [
            {
              id: 'product-dev',
              label: 'CQR 제품개발',
              pull: ['agent-plugins'],
              plugins: { enable: { kit_plug: true } },
              ui: { pinned_skill_ids: ['org:brand_concept'] },
              hints: { needs_organization_module: true },
              asset: { sequence: 1, name: 'cqr-product-dev.tar.gz' },
            },
            {
              id: 'ops',
              label: 'CQR 명령어 모음',
              pull: [],
              plugins: { enable: {} },
              ui: { pinned_skill_ids: [] },
              asset: { sequence: 1, name: 'cqr-ops.tar.gz' },
            },
          ],
        },
      ],
    }, null, 2),
  );

  const feed = await refreshWorkKitCatalog(root, { lockerRoot: locker, feedPath });
  assert.equal(feed.sequence, 1);

  let cat = listWorkKitProfileCatalog(root, { lockerRoot: locker });
  const cqrBefore = cat.groups.find((g) => g.id === 'cqr');
  assert.ok(cqrBefore, 'cqr group from feed');
  const devBefore = cqrBefore.shelves.find((s) => s.id === 'product-dev');
  const opsBefore = cqrBefore.shelves.find((s) => s.id === 'ops');
  assert.equal(devBefore?.install_status, 'available');
  assert.equal(opsBefore?.install_status, 'available');
  assert.equal(
    existsSync(path.join(locker, 'profiles', 'cqr', 'product-dev', 'shelf.json')),
    false,
    'not installed yet',
  );

  // Install payload for product-dev in locker (simulate tarball content via meta + manual tree)
  const shelfDir = path.join(locker, 'profiles', 'cqr', 'product-dev');
  mkdirSync(shelfDir, { recursive: true });
  writeFileSync(
    path.join(shelfDir, 'shelf.json'),
    JSON.stringify({
      schema_version: 1,
      id: 'product-dev',
      group: 'cqr',
      label: 'CQR 제품개발',
      pull: ['agent-plugins'],
      plugins: { enable: { kit_plug: true } },
      ui: { pinned_skill_ids: ['org:brand_concept'] },
      hints: { needs_organization_module: true },
    }, null, 2),
  );
  const plugSrc = path.join(shelfDir, 'agent-plugins', 'kit_plug');
  mkdirSync(plugSrc, { recursive: true });
  writeFileSync(
    path.join(plugSrc, 'tool.json'),
    JSON.stringify({
      name: 'plugin_kit_plug',
      description: 'kit pull plugin',
      risk: 'read',
      parameters: { type: 'object', properties: {} },
      runner: { kind: 'node', entry: 'run.mjs' },
    }, null, 2),
  );
  writeFileSync(path.join(plugSrc, 'run.mjs'), 'export default async () => ({ ok: true });\n');
  writeFileSync(
    path.join(shelfDir, '.install-meta.json'),
    JSON.stringify({ asset_sequence: 1, installed_at: new Date().toISOString() }, null, 2),
  );
  mkdirSync(path.join(locker, 'profiles', 'cqr'), { recursive: true });
  writeFileSync(
    path.join(locker, 'profiles', 'cqr', 'group.json'),
    JSON.stringify({ id: 'cqr', label: 'CQR', order: 10 }, null, 2),
  );

  cat = listWorkKitProfileCatalog(root, { lockerRoot: locker });
  const cqr = cat.groups.find((g) => g.id === 'cqr');
  assert.ok(cqr, 'cqr group');
  const dev = cqr.shelves.find((s) => s.id === 'product-dev');
  const ops = cqr.shelves.find((s) => s.id === 'ops');
  assert.equal(dev?.install_status, 'installed');
  assert.equal(ops?.install_status, 'available');
  assert.equal(
    existsSync(path.join(locker, 'profiles', 'cqr', 'ops', 'shelf.json')),
    false,
    'ops not installed',
  );

  // meta-only install for ops via API helper
  await installWorkKitShelf(root, 'cqr', 'ops', {
    lockerRoot: locker,
    feedPath,
    forceMetaOnly: true,
  });
  assert.equal(
    existsSync(path.join(locker, 'profiles', 'cqr', 'ops', 'shelf.json')),
    true,
  );

  const kit = applyWorkKit(root, {
    group: 'cqr',
    id: 'product-dev',
    confirm: true,
    lockerRoot: locker,
  });
  assert.equal(kit.ok, true);
  assert.ok((kit.pulled_plugins ?? []).includes('kit_plug'), JSON.stringify(kit));
  const appliedKit = getAppliedProfileState(root);
  assert.equal(appliedKit?.group, 'cqr');
  assert.equal(appliedKit?.kit_id, 'product-dev');
  assert.ok(
    (appliedKit?.ui.pinned_skill_ids ?? []).includes('org:brand_concept'),
    'apply persists pinned_skill_ids',
  );
  assert.ok(kit.warnings.some((w) => w.includes('조직 모듈')));
  assert.equal(hasProfileLastState(root), true);

  const { loadWorkKitContextNote } = await import('../core/dist/config/work-kit-context.js');
  const note = loadWorkKitContextNote(root);
  assert.ok(note && note.includes('Work context'), 'context note after apply');
  assert.ok(note.includes('org:brand_concept') || note.includes('brand_concept'), 'pins in note');

  restoreAgentProfileLastState(root, { confirm: true });

  try {
    applyWorkKit(root, { group: 'cqr', id: 'missing', confirm: true, lockerRoot: locker });
    assert.fail('expected not found');
  } catch (e) {
    assert.ok(e instanceof AgentProfileError);
    assert.equal(e.code, 'PROFILE_NOT_FOUND');
  }

  // No bundled cqr in neutral core
  assert.equal(
    existsSync(path.join(repoRoot, 'core/config/defaults/profile-shelves/cqr/product-dev/shelf.json')),
    false,
    'bundled cqr removed',
  );
  assert.equal(
    existsSync(path.join(repoRoot, 'core/config/defaults/profile-shelves/_template/example-kit/shelf.json.example')),
    true,
    '_template skeleton present',
  );

  console.log('verify-agent-profiles: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(locker, { recursive: true, force: true });
}
