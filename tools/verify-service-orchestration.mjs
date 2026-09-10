/**
 * CQR_PA port #11(a) — service-terminal-orchestration: portable runner/schema skeleton.
 *
 * The CQR_PA WORK_SPEC is machine-specific (NS_FBE/EVAL services, hardcoded ports
 * 18349/18000/18080, D:\.workspace\... paths, a fixed automation task id) and cannot
 * be ported verbatim. This verifies only the portable kernel that IS in-tree:
 *   - a JSON schema describing services (no baked-in paths/ports/names),
 *   - an example config that conforms to the schema,
 *   - the PowerShell orchestrator preserving the spec's behavior contract.
 * When pwsh/powershell is available it additionally runs a real parse check and a
 * `-WhatIf -NoFinalActivate` smoke; otherwise it degrades to static assertions.
 *
 * Run: node tools/verify-service-orchestration.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cmdDir = path.join(root, 'tools', 'commands');
const ps1Path = path.join(cmdDir, 'start-services.ps1');
const schemaPath = path.join(cmdDir, 'start-services.schema.json');
const examplePath = path.join(cmdDir, 'services.example.json');

const ps1 = readFileSync(ps1Path, 'utf8');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const example = JSON.parse(readFileSync(examplePath, 'utf8'));

let pass = 0;
const check = (name, fn) => { fn(); pass += 1; console.log(`ok - ${name}`); };

// 1. Schema is a well-formed object schema requiring a non-empty services array.
check('schema requires services array with name+command items', () => {
  assert.equal(schema.type, 'object');
  assert.ok(Array.isArray(schema.required) && schema.required.includes('services'));
  const items = schema.properties.services.items;
  assert.ok(items.required.includes('name') && items.required.includes('command'));
  assert.equal(schema.properties.services.minItems, 1);
});

// 2. No machine-specific CQR_PA leakage in the portable skeleton.
const forbidden = [/NS_FBE/i, /my_automaton/i, /D:\\\.workspace/i, /18349/, /18000/, /18080/, /96c43a09/i];
check('skeleton carries no CQR_PA machine-specific paths/ports/ids', () => {
  for (const re of forbidden) {
    assert.ok(!re.test(ps1), `ps1 must not contain ${re}`);
    assert.ok(!re.test(JSON.stringify(schema)), `schema must not contain ${re}`);
    assert.ok(!re.test(JSON.stringify(example)), `example must not contain ${re}`);
  }
});

// 3. Example config conforms to the schema's structural contract.
const validateAgainstSchema = (cfg) => {
  assert.ok(Array.isArray(cfg.services) && cfg.services.length >= 1);
  const allowedSvcKeys = new Set(Object.keys(schema.properties.services.items.properties));
  for (const svc of cfg.services) {
    assert.ok(typeof svc.name === 'string' && svc.name.length > 0, 'name required');
    assert.ok(typeof svc.command === 'string' && svc.command.length > 0, 'command required');
    for (const k of Object.keys(svc)) {
      assert.ok(allowedSvcKeys.has(k), `unexpected service key: ${k}`);
    }
  }
};
check('example.json conforms to schema', () => {
  validateAgainstSchema(example);
  assert.equal(example.terminalWindowName, 'MY_AGENT_SERVICES');
});

// 4. Behaviour contract from the WORK_SPEC is present in the orchestrator.
check('orchestrator declares -WhatIf and -NoFinalActivate', () => {
  assert.match(ps1, /\[switch\]\s*\$WhatIf/);
  assert.match(ps1, /\[switch\]\s*\$NoFinalActivate/);
});
check('dedicated window defaults to MY_AGENT_SERVICES', () => {
  assert.match(ps1, /'MY_AGENT_SERVICES'/);
});
check('health-first: already-healthy services are skipped (not relaunched)', () => {
  assert.match(ps1, /Test-ServiceHealthy/);
  assert.match(ps1, /already running/);
});
check('focus preservation: capture + restore foreground window around each tab', () => {
  assert.match(ps1, /Get-ForegroundWindow/);
  assert.match(ps1, /Restore-ForegroundWindow/);
  assert.match(ps1, /GetForegroundWindow/);
  assert.match(ps1, /SetForegroundWindow/);
});
check('single final activate, suppressible via -NoFinalActivate', () => {
  assert.match(ps1, /terminal: shown after completion/);
  assert.match(ps1, /final activate suppressed/);
});
check('pwsh preferred with powershell fallback', () => {
  assert.match(ps1, /pwsh\.exe/);
  assert.match(ps1, /powershell\.exe/);
});
check('wt.exe absence is an explicit orchestration failure', () => {
  assert.match(ps1, /wt\.exe/);
  assert.match(ps1, /Windows Terminal .* required/);
});

// 5. Optional live PowerShell parse + WhatIf smoke (degrades if no shell).
const shell = ['pwsh.exe', 'pwsh', 'powershell.exe', 'powershell'].find((exe) => {
  const probe = spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
  return probe.status === 0;
});

if (!shell) {
  console.log('skip - no PowerShell on PATH; static contract checks only');
} else {
  check('PowerShell parses start-services.ps1 without errors', () => {
    const parse = spawnSync(shell, ['-NoProfile', '-Command',
      `$errs=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${ps1Path.replace(/'/g, "''")}', [ref]$null, [ref]$errs); if ($errs -and $errs.Count -gt 0) { $errs | ForEach-Object { Write-Error $_.Message }; exit 2 } else { exit 0 }`,
    ], { encoding: 'utf8' });
    assert.equal(parse.status, 0, `parse errors:\n${parse.stderr || parse.stdout}`);
  });

  check('-WhatIf -NoFinalActivate dry-run exits 0 and plans tabs', () => {
    const run = spawnSync(shell, ['-NoProfile', '-File', ps1Path,
      '-ConfigPath', examplePath, '-WhatIf', '-NoFinalActivate',
    ], { encoding: 'utf8' });
    assert.equal(run.status, 0, `dry-run failed:\n${run.stderr || run.stdout}`);
    assert.match(run.stdout, /\[plan\] tab/);
    assert.match(run.stdout, /final activate suppressed/);
  });
}

console.log(`\n${pass} checks passed`);
