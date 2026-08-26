#!/usr/bin/env node
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(
  pathToFileURL(path.join(root, 'core/dist/agent/run-terminal.js')).href + `?t=${Date.now()}`
);
assert.equal(typeof mod.sanitizeShellCommandForPolicy, 'function');

const bad =
  'Remove-Item -Recurse -Force .my_agent_remote/jose87ldj__my_automaton; git clone --depth 1 https://github.com/jose87ldj/my_automaton .my_agent_remote/jose87ldj__my_automaton';
const s = mod.sanitizeShellCommandForPolicy(bad);
assert.ok(s.stripped.length >= 1, 'should strip Remove-Item');
assert.match(s.command, /git\s+clone/i);
assert.doesNotMatch(s.command, /Remove-Item/i);

const clean = 'git clone --depth 1 https://github.com/x/y .my_agent_remote/x__y';
assert.equal(mod.sanitizeShellCommandForPolicy(clean).command, clean);

assert.equal(mod.extractRemoteCloneDest(clean), '.my_agent_remote/x__y');
assert.equal(
  mod.extractRemoteCloneDest(
    'git clone --depth 1 https://github.com/jose87ldj/my_automaton .my_agent_remote/jose87ldj__my_automaton',
  ),
  '.my_agent_remote/jose87ldj__my_automaton',
);
assert.equal(
  mod.extractRemoteCloneDest(
    'git clone --depth 1 https://github.com/x/y ".my_agent_remote/x__y"',
  ),
  '.my_agent_remote/x__y',
);
assert.equal(
  mod.extractRemoteCloneDest(
    'git clone --depth 1 https://github.com/x/y .my_agent_remote\\x__y',
  ),
  '.my_agent_remote/x__y',
);

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
const tmp = path.join(root, 'data', '_skill_tool_lab', '_clone_dest_probe');
const dest = path.join(tmp, '.my_agent_remote', 'probe__repo');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
writeFileSync(path.join(dest, 'README.md'), '# probe\n', 'utf8');
const shortcut = mod.tryShortcutExistingRemoteClone(
  tmp,
  'git clone --depth 1 https://github.com/probe/repo .my_agent_remote/probe__repo',
);
assert.ok(shortcut?.ok, 'existing dest soft-ok');
assert.match(String(shortcut?.stdout || ''), /DEST_EXISTS/);
assert.match(String(shortcut?.stdout || ''), /read_file/);
rmSync(path.join(dest, 'README.md'), { force: true });
const emptyDir = mod.tryShortcutExistingRemoteClone(
  tmp,
  'git clone --depth 1 https://github.com/probe/repo .my_agent_remote/probe__repo',
);
assert.equal(emptyDir, null, 'empty dest must not soft-ok');
rmSync(tmp, { recursive: true, force: true });

console.log('verify-run-terminal-sanitize: ok');
