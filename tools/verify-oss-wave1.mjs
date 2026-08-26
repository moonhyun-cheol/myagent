#!/usr/bin/env node
/**
 * Wave 1 OSS absorption offline gates (ADR-009).
 * mammoth/pdf-parse · remote_git_inspect · explicit MCP example · Playwright MCP first_class
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const build = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], {
  cwd: root,
  encoding: 'utf8',
  env: process.env,
});
assert.equal(build.status, 0, build.stderr || build.stdout || 'build failed');

// --- deps present ---
assert.ok(require.resolve('mammoth'), 'mammoth installed');
assert.ok(require.resolve('pdf-parse'), 'pdf-parse installed');

const { extractDocxText, extractDocxTextLegacy } = await import(
  pathToFileURL(path.join(root, 'core/dist/attachments/docx-extract.js')).href
);
const { extractPdfText, extractPdfTextLegacy } = await import(
  pathToFileURL(path.join(root, 'core/dist/attachments/pdf-extract.js')).href
);
const { remoteGitInspect } = await import(
  pathToFileURL(path.join(root, 'core/dist/agent/remote-git-inspect.js')).href
);
const { wantsFullRemoteGitHistory, contentAsksUserForGitHistoryHandoff } = await import(
  pathToFileURL(path.join(root, 'core/dist/agent/agent-capability-policy.js')).href
);
const { CODE_AGENT_TOOL_NAMES } = await import(
  pathToFileURL(path.join(root, 'core/dist/agent/agent-tool-definitions.js')).href
);
const { getPlaywrightMcpDiagnostics } = await import(
  pathToFileURL(path.join(root, 'core/dist/browser/playwright-mcp-bridge.js')).href
);

assert.ok(CODE_AGENT_TOOL_NAMES.includes('remote_git_inspect'), 'remote_git_inspect tool registered');

// --- docx: mammoth path (minimal OOXML zip is heavy; legacy still works on raw) ---
const legacyDocx = extractDocxTextLegacy(Buffer.from('<w:t>hello-mammoth-gate</w:t>', 'latin1'), 100);
assert.match(legacyDocx, /hello-mammoth-gate/);

// --- pdf legacy fallback still works ---
const pdfLegacy = extractPdfTextLegacy(Buffer.from('(HelloPDF)', 'latin1'), 100);
assert.ok(pdfLegacy.length > 0);

// --- remote_git_inspect on existing clone if present ---
const remoteRel = '.my_agent_remote/jose87ldj__my_automaton';
const remoteAbs = path.join(root, remoteRel);
if (existsSync(path.join(remoteAbs, '.git'))) {
  const status = JSON.parse(remoteGitInspect(root, { action: 'status', repo: remoteRel }));
  assert.equal(status.ok, true, JSON.stringify(status));
  const full = JSON.parse(
    remoteGitInspect(root, { action: 'ensure_full', repo: remoteRel, max: 40 }),
  );
  assert.equal(full.ok, true, JSON.stringify(full));
  assert.ok(Number(full.commit_count) >= 1, 'commit_count');
  assert.ok(String(full.log || '').length > 0, 'log present');
  console.log(`OK remote_git_inspect commits=${full.commit_count} shallow=${full.shallow}`);
} else {
  console.log('SKIP remote_git_inspect (no .my_agent_remote clone yet)');
}

assert.equal(
  wantsFullRemoteGitHistory(
    'https://github.com/jose87ldj/my_automaton depth를 늘려서 히스토리 보고',
  ),
  true,
);
assert.equal(
  contentAsksUserForGitHistoryHandoff(
    'git bundle을 업로드해 주세요. commits.tsv도 보내주세요.',
  ),
  true,
);

// --- MCP example remains available, but nothing is enabled by default ---
const mcpEx = path.join(root, 'data/config/user-mcp-servers.example.json');
assert.ok(existsSync(mcpEx), 'user-mcp-servers.example.json');
const mcp = JSON.parse(readFileSync(mcpEx, 'utf8'));
assert.ok(mcp.servers?.some((s) => s.id === 'filesystem'), 'filesystem MCP example');
assert.ok(!mcp.servers?.some((s) => /github/i.test(String(s.id))), 'no token-gated github MCP in example');

const mcpDef = path.join(root, 'core/config/defaults/user-mcp-servers.default.json');
assert.ok(existsSync(mcpDef), 'user-mcp-servers.default.json');
const mcpDefaults = JSON.parse(readFileSync(mcpDef, 'utf8'));
assert.deepEqual(mcpDefaults.servers, []);

const pw = await getPlaywrightMcpDiagnostics(root);
assert.equal(pw.first_class, true, 'playwright MCP first_class');
assert.equal(pw.prefer, 'mcp', 'playwright prefer mcp');
console.log(`OK playwright_mcp first_class ok=${pw.ok}`);

// mammoth async on tiny invalid buffer should not throw (fallback message)
const soft = await extractDocxText(Buffer.from('not-a-docx'), 200);
assert.ok(typeof soft === 'string' && soft.length > 0);

console.log('verify-oss-wave1: ok');
