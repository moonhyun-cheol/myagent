#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
assert.equal(build.status, 0, build.error?.message || `build exited ${build.status}`);

const removedFiles = [
  'core/src/sidecars/aider-sidecar.ts',
  'core/src/sidecars/goose-sidecar.ts',
  'core/src/sidecars/heavy-coder-sidecar.ts',
  'core/src/sidecars/continue-context-sidecar.ts',
  'core/src/sidecars/stagehand-sidecar.ts',
  'core/src/sidecars/optin-agent-profiles.ts',
  'core/src/browser/browser-use-runner.ts',
  'core/src/chat/modes/browser-use.ts',
  'core/src/agent/index/repo-map-wasm.ts',
  'core/src/agent/repo-map-wasm.ts',
  'tools/bootstrap-aider.ps1',
  'tools/bootstrap-goose.ps1',
  'tools/bootstrap-browser-use.ps1',
  'tools/browser-use-run.py',
  'tools/requirements-browser-use.txt',
  'tools/eval/promptfoo/promptfooconfig.yaml',
];
for (const rel of removedFiles) assert.equal(existsSync(path.join(root, rel)), false, rel);

const { CODE_AGENT_TOOL_NAMES } = await import(
  `${pathToFileURL(path.join(root, 'core/dist/agent/agent-tool-definitions.js')).href}?v=${Date.now()}`
);
for (const removed of ['heavy_coder_edit', 'continue_context_pack', 'stagehand_probe']) {
  assert.equal(CODE_AGENT_TOOL_NAMES.includes(removed), false, removed);
}
for (const kept of ['apply_patch', 'run_diagnostics', 'repomix_pack', 'ast_grep_search', 'markitdown_convert']) {
  assert.ok(CODE_AGENT_TOOL_NAMES.includes(kept), kept);
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(pkg.optionalDependencies?.['web-tree-sitter'], undefined);
assert.equal(pkg.scripts?.['eval:promptfoo'], undefined);

const defaults = JSON.parse(readFileSync(path.join(root, 'core/config/defaults/user-mcp-servers.default.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(path.join(root, 'core/config/defaults/mcp-catalog.json'), 'utf8'));
assert.deepEqual(defaults.servers, []);
assert.deepEqual(catalog.servers, []);

const bootstrap = readFileSync(path.join(root, 'tools/bootstrap-oss-sidecars.ps1'), 'utf8');
assert.doesNotMatch(bootstrap, /browser-use|SkipBrowserUse/i);
assert.match(bootstrap, /markitdown/i);
assert.match(bootstrap, /repomix/i);
assert.match(bootstrap, /ast-grep/i);

const video = readFileSync(path.join(root, 'core/src/attachments/video-keyframes.ts'), 'utf8');
assert.match(video, /ffmpeg/i);
const docx = readFileSync(path.join(root, 'core/src/attachments/docx-extract.ts'), 'utf8');
assert.match(docx, /mammoth/i);

const { isMarkitdownAttachment } = await import(
  `${pathToFileURL(path.join(root, 'core/dist/attachments/text-extract.js')).href}?v=${Date.now()}`
);
for (const name of ['budget.xlsx', 'legacy.xls', 'macro.xlsm', 'brief.pptx', 'mail.msg']) {
  assert.equal(isMarkitdownAttachment(name), true, name);
}
assert.equal(isMarkitdownAttachment('notes.txt'), false);
const markitdownRequirements = readFileSync(path.join(root, 'tools/requirements-oss-sidecars.txt'), 'utf8');
assert.match(markitdownRequirements, /markitdown\[pptx,xlsx,xls,outlook\]/);
assert.match(bootstrap, /\$bundleVersion\s*=\s*4/);

const settingsModal = [
  'ui/workspace/src/components/SettingsModal.tsx',
  'ui/workspace/src/components/SettingsAgentPage.tsx',
].map((file) => readFileSync(path.join(root, file), 'utf8')).join('\n');
assert.match(settingsModal, /data-testid="settings-autopilot-mode"/);
assert.match(settingsModal, /setAgentAutopilot\(mode\)/);
for (const option of ['auto', 'on', 'off']) assert.match(settingsModal, new RegExp(`value="${option}"`));
const autopilotRoute = readFileSync(path.join(root, 'core/src/routes/dispatch.ts'), 'utf8');
assert.match(autopilotRoute, /\/config\/agent-autopilot/);
assert.match(autopilotRoute, /body\.agent_autopilot === false \? false : null/);
const { resolveAutopilotEnabled } = await import(
  `${pathToFileURL(path.join(root, 'core/dist/agent/agent-autopilot.js')).href}?v=${Date.now()}`
);
assert.equal(resolveAutopilotEnabled({}, true, '설명해줘', { codeSession: true }), true);
assert.equal(resolveAutopilotEnabled({}, false, '코드 수정해줘', { codeSession: true }), false);
assert.equal(resolveAutopilotEnabled({}, null, '코드 수정해줘', { codeSession: true }), true);

console.log('built-in agent runtime: PASS');
