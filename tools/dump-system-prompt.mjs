#!/usr/bin/env node
/**
 * Dump the final workspace-agent system prompt per combination, and check it against
 * the stored snapshots.
 *
 *   node tools/dump-system-prompt.mjs --write   (re)generate tools/prompt-snapshots/*.txt
 *   node tools/dump-system-prompt.mjs --check   fail when the assembled text differs
 *
 * The system messages are assembled in the same order as the runtime
 * (buildAgentMessages → Autopilot → TODO lifecycle → workspace lock → Plan/Debug note)
 * and merged with compilePromptContext, the function used right before a provider call.
 *
 * Deliberately replaced by placeholders (they change per machine, build or session):
 *   - workspace root path            → <WORKSPACE_ROOT>
 *   - tool name list                 → <TOOL_NAMES>
 *   - product memory (AGENTS.md etc) → [[PRODUCT_MEMORY …]]
 *   - Debug ingest note (token)      → [[DEBUG_INGEST_NOTE …]]
 * Not covered: selected skill prompt, brand manual, locked P0 constraints, background
 * browser note, user-role context messages, and the tool definitions.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'tools', 'prompt-snapshots');
const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--check') ? 'check' : '';
if (!mode) {
  console.error('usage: node tools/dump-system-prompt.mjs --write | --check');
  process.exit(2);
}

const load = (rel) => import(pathToFileURL(path.join(repoRoot, 'core', 'dist', rel)).href);
const helpers = await load('agent/agent-run-helpers.js');
const autopilotMod = await load('agent/agent-autopilot.js');
const todoMod = await load('agent/agent-todo-ledger.js');
const lockMod = await load('agent/agent-workspace-lock.js');
const factsMod = await load('agent/agent-runtime-facts.js');
const memoryMod = await load('agent/agent-product-memory.js');
const protocolMod = await load('agent/agent-tool-protocol.js');
const cacheMod = await load('providers/prompt-context-cache.js');

const TOOL_NAMES = ['<TOOL_NAMES>'];
const PRODUCT_MEMORY = {
  self: '[[PRODUCT_MEMORY: product-facts.json summary + AGENTS.md — injected at runtime]]',
  external: '[[PRODUCT_MEMORY: external project note + that project\'s AGENTS.md — injected at runtime]]',
  nofolder: '',
};
const DEBUG_INGEST = '[[DEBUG_INGEST_NOTE: per-session probe endpoint and token — injected at runtime]]';

/** scope × behavior × autopilot request × tool protocol. */
const COMBOS = [
  ...['self', 'external'].flatMap((scope) => [
    { scope, behavior: 'agent', autopilot: false, client: false },
    { scope, behavior: 'agent', autopilot: true, client: false },
    { scope, behavior: 'plan', autopilot: true, client: false },
    { scope, behavior: 'debug', autopilot: true, client: false },
  ]),
  { scope: 'nofolder', behavior: 'agent', autopilot: false, client: false },
  { scope: 'nofolder', behavior: 'agent', autopilot: true, client: false },
  { scope: 'self', behavior: 'agent', autopilot: true, client: true },
];

const lf = (text) => String(text).replace(/\r\n/g, '\n');

function assemble(combo, workspaceRoot) {
  const noFolder = combo.scope === 'nofolder';
  const self = combo.scope === 'self';
  let messages = helpers.buildAgentMessages(
    {
      workspaceRoot,
      userMessage: 'x',
      history: [],
      ...(noFolder ? { fileAccess: 'none' } : {}),
    },
    {},
    TOOL_NAMES,
    combo.client,
    PRODUCT_MEMORY[combo.scope],
    self,
  );
  let at = 1;
  const insert = (content) => {
    if (!content || !String(content).trim()) return;
    messages.splice(at, 0, { role: 'system', content });
    at += 1;
  };
  // Same gate as workspace-agent.ts: the behavior may forbid Autopilot.
  const autopilot = combo.autopilot && factsMod.behaviorAllowsAutopilot(combo.behavior, repoRoot);
  if (autopilot) insert(autopilotMod.formatAutopilotSystemNote());
  insert(todoMod.formatTodoLifecycleSystemNote());
  if (!noFolder) {
    insert(lockMod.formatWorkspaceLockNote(lockMod.resolveTurnWorkspaceLock({ sessionRoot: workspaceRoot })));
  }
  if (combo.behavior === 'plan') {
    const raw = factsMod.loadPlanModeSystemNote(repoRoot);
    insert(self ? raw : memoryMod.stripCqrSelfSkillSections(raw));
  }
  if (combo.behavior === 'debug') {
    insert(factsMod.loadDebugModeSystemNote(repoRoot));
    insert(DEBUG_INGEST);
  }
  if (combo.client) messages = protocolMod.appendClientToolProtocol(messages, TOOL_NAMES);

  const compiled = cacheMod.compilePromptContext(messages, []);
  const systems = compiled.messages.filter((m) => m.role === 'system');
  assert.equal(systems.length, 1, 'compilePromptContext must merge system messages into one');
  const native = path.resolve(workspaceRoot);
  const posix = native.split(path.sep).join('/');
  const text = lf(systems[0].content).split(native).join('<WORKSPACE_ROOT>').split(posix).join('<WORKSPACE_ROOT>');
  return { text, autopilot };
}

function render(combo, workspaceRoot) {
  const { text, autopilot } = assemble(combo, workspaceRoot);
  const name = [
    combo.scope,
    combo.behavior,
    autopilot ? 'autopilot-on' : 'autopilot-off',
    ...(combo.client ? ['text-toolcall'] : []),
  ].join('.');
  const header = [
    `# Generated by tools/dump-system-prompt.mjs — do not edit by hand.`,
    `# scope=${combo.scope} behavior=${combo.behavior} autopilot=${autopilot ? 'on' : 'off'} tool_protocol=${combo.client ? 'text' : 'native'}`,
    `# chars=${text.length}`,
    '# ---',
    '',
  ].join('\n');
  return { file: `${name}.txt`, body: `${header}${text}\n` };
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'my-agent-prompt-dump-'));
let rendered;
try {
  rendered = COMBOS.map((combo) => render(combo, scratch));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
assert.equal(new Set(rendered.map((r) => r.file)).size, rendered.length, 'snapshot file names must be unique');

if (mode === 'write') {
  mkdirSync(outDir, { recursive: true });
  const keep = new Set(rendered.map((r) => r.file));
  for (const stale of readdirSync(outDir).filter((f) => f.endsWith('.txt') && !keep.has(f))) {
    rmSync(path.join(outDir, stale));
    console.log(`removed stale ${stale}`);
  }
  for (const r of rendered) {
    writeFileSync(path.join(outDir, r.file), r.body, 'utf8');
    console.log(`wrote tools/prompt-snapshots/${r.file} (${r.body.length} chars)`);
  }
  console.log(`dump-system-prompt: wrote ${rendered.length} files`);
} else {
  const problems = [];
  for (const r of rendered) {
    const fp = path.join(outDir, r.file);
    if (!existsSync(fp)) {
      problems.push(`${r.file}: snapshot file missing`);
      continue;
    }
    const want = lf(readFileSync(fp, 'utf8')).split('\n');
    const got = lf(r.body).split('\n');
    const n = Math.max(want.length, got.length);
    for (let i = 0; i < n; i += 1) {
      if (want[i] === got[i]) continue;
      problems.push(
        `${r.file}: line ${i + 1} differs\n    snapshot: ${String(want[i] ?? '(end of file)').slice(0, 200)}\n    current : ${String(got[i] ?? '(end of file)').slice(0, 200)}`,
      );
      break;
    }
  }
  const expected = new Set(rendered.map((r) => r.file));
  const extra = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith('.txt') && !expected.has(f)) : [];
  for (const f of extra) problems.push(`${f}: stale snapshot (no matching combination)`);
  if (problems.length) {
    console.error('verify-system-prompt-snapshot: system prompt text changed');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('If the change is intended, run `npm run dump:system-prompt` and review the diff before committing.');
    process.exit(1);
  }
  console.log(`verify-system-prompt-snapshot: ok (${rendered.length} combinations)`);
}
