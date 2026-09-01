#!/usr/bin/env node
/**
 * Work profiles (data/profile) — local presets, not organization module.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyAgentProfile,
  deleteAgentProfile,
  getAppliedProfileState,
  hasProfileLastState,
  listAgentProfiles,
  restoreAgentProfileLastState,
  saveAgentProfile,
  AgentProfileError,
} from '../core/dist/config/agent-profile-store.js';
import {
  installAgentPlugin,
  setAgentPluginEnabled,
} from '../core/dist/agent/agent-plugin-store.js';

const root = mkdtempSync(path.join(tmpdir(), 'myagent-profile-'));

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
  assert.deepEqual(listAgentProfiles(root), []);

  installDemo('demo_a', 'plugin_demo_a');
  installDemo('demo_b', 'plugin_demo_b');
  setAgentPluginEnabled(root, { id: 'demo_a', enabled: true, confirm: true });
  setAgentPluginEnabled(root, { id: 'demo_b', enabled: false, confirm: true });

  const saved = saveAgentProfile(root, {
    id: 'product-dev',
    label: '제품개발',
    plugins: { enable: { demo_a: false, demo_b: true } },
    ui: { pinned_skill_ids: [], default_skill_mode: 'web_dev' },
  });
  assert.equal(saved.id, 'product-dev');
  assert.equal(listAgentProfiles(root).length, 1);

  try {
    applyAgentProfile(root, { id: 'product-dev' });
    assert.fail('expected PROFILE_CONFIRM_REQUIRED');
  } catch (e) {
    assert.ok(e instanceof AgentProfileError);
    assert.equal(e.code, 'PROFILE_CONFIRM_REQUIRED');
  }

  const applied = applyAgentProfile(root, {
    id: 'product-dev',
    confirm: true,
    knownSkillModes: ['web_dev', 'chat'],
  });
  assert.equal(applied.ok, true);
  assert.ok(applied.toggled.length >= 1, `expected plugin toggles: ${JSON.stringify(applied)}`);
  assert.equal(getAppliedProfileState(root)?.profile_id, 'product-dev');
  assert.equal(hasProfileLastState(root), true);

  const restored = restoreAgentProfileLastState(root, { confirm: true });
  assert.equal(restored.ok, true);

  assert.equal(deleteAgentProfile(root, 'product-dev'), true);
  assert.deepEqual(listAgentProfiles(root), []);
  console.log('verify-agent-profiles: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
