#!/usr/bin/env node
/**
 * Golden refactor E2E: checklist + structural outcome + retrieval-first helpers.
 * Does not call an LLM — exercises tool/disk gates the agent must pass.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  buildTaskChecklist,
  evaluateTaskChecklist,
  formatRetrievalFirstSystemNote,
} = await import('../core/dist/agent/agent-task-checklist.js');
const {
  evaluateOutcomeGate,
  contentClaimsStructuralDeliverable,
  contentClaimsPartialOnly,
} = await import('../core/dist/agent/agent-outcome-gate.js');
const { executeAgentTool, normalizeToolCall } = await import('../core/dist/agent/tools.js');

// --- unit: checklist inference ---
{
  const c = buildTaskChecklist('tools.ts에서 도구 정의·레지스트리 분리해줘');
  assert.ok(c.requireNewModules.some((p) => p.includes('agent-tool-definitions')));
  assert.equal(c.requireRetrieval, false);
  assert.ok(formatRetrievalFirstSystemNote().includes('query_repo_map'));
}

// --- unit: checklist eval blocks false complete ---
{
  const dir = mkdtempSync(path.join(tmpdir(), 'cqr-check-'));
  try {
    writeFileSync(path.join(dir, 'tools.ts'), 'export const CODE_AGENT_TOOLS = [];\n', 'utf8');
    const checklist = buildTaskChecklist('tools.ts 도구 정의 분리해');
    const blocked = evaluateTaskChecklist({
      checklist,
      workspaceRoot: dir,
      mutatedPaths: ['tools.ts'],
      toolsUsed: ['edit_file'],
      claimsDone: true,
      claimsPartial: false,
    });
    assert.equal(blocked.ok, false);
    assert.ok(blocked.missingPaths.length || blocked.missingRetrieval);

    const withRetrievalStillMissingFiles = evaluateTaskChecklist({
      checklist,
      workspaceRoot: dir,
      mutatedPaths: ['tools.ts'],
      toolsUsed: ['query_repo_map', 'edit_file'],
      claimsDone: true,
      claimsPartial: false,
    });
    assert.equal(withRetrievalStillMissingFiles.ok, false);
    assert.ok(withRetrievalStillMissingFiles.missingPaths.length);

    const partial = evaluateTaskChecklist({
      checklist,
      workspaceRoot: dir,
      mutatedPaths: ['tools.ts'],
      toolsUsed: ['edit_file'],
      claimsDone: false,
      claimsPartial: true,
    });
    assert.equal(partial.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- E2E fixture: split monolith via tools, then outcome gate ---
{
  const fixture = path.join(root, 'data', '_golden_refactor_fixture');
  if (existsSync(fixture)) rmSync(fixture, { recursive: true, force: true });
  mkdirSync(path.join(fixture, 'core/src/agent'), { recursive: true });

  const monolith = [
    'export const CODE_AGENT_TOOLS = [{ type: "function", function: { name: "read_file" } }];',
    'export function normalizeToolName(n) { return n; }',
    '',
  ].join('\n');
  writeFileSync(path.join(fixture, 'core/src/agent/tools.ts'), monolith, 'utf8');

  // 1) Without new module — structural 완료 claim must fail outcome gate
  {
    const gate = evaluateOutcomeGate({
      text: '`core/src/agent/agent-tool-definitions.ts`로 분리했고 수정을 완료했습니다.',
      mutatedOk: true,
      mutatedPaths: ['core/src/agent/tools.ts'],
      fileContents: {
        'core/src/agent/tools.ts': monolith,
      },
      diagnostics: 'weak',
      workspaceRoot: fixture,
    });
    assert.equal(gate.ok, false);
    assert.ok(
      gate.reason === 'plan_unfulfilled'
        || gate.reason === 'partial_as_done'
        || gate.reason === 'diag_unverified',
      gate.reason,
    );
  }

  // 2) Create definitions via write_file tool
  const writeOut = await executeAgentTool(
    fixture,
    normalizeToolCall({
      id: 'w1',
      type: 'function',
      function: {
        name: 'write_file',
        arguments: JSON.stringify({
          path: 'core/src/agent/agent-tool-definitions.ts',
          content:
            'export const CODE_AGENT_TOOLS = [{ type: "function", function: { name: "read_file" } }];\n',
        }),
      },
    }),
  );
  assert.ok(!writeOut.output.startsWith('ERROR:'), writeOut.output);
  assert.ok(
    existsSync(path.join(fixture, 'core/src/agent/agent-tool-definitions.ts')),
  );

  // 3) Slim tools.ts to re-export
  await executeAgentTool(
    fixture,
    normalizeToolCall({
      id: 'w2',
      type: 'function',
      function: {
        name: 'write_file',
        arguments: JSON.stringify({
          path: 'core/src/agent/tools.ts',
          content:
            "export { CODE_AGENT_TOOLS } from './agent-tool-definitions.js';\n",
        }),
      },
    }),
  );

  const defs = readFileSync(
    path.join(fixture, 'core/src/agent/agent-tool-definitions.ts'),
    'utf8',
  );
  const tools = readFileSync(path.join(fixture, 'core/src/agent/tools.ts'), 'utf8');
  assert.ok(defs.includes('CODE_AGENT_TOOLS'));
  assert.ok(tools.includes('agent-tool-definitions'));

  // 4) Structural claim with file on disk → pass
  {
    assert.ok(contentClaimsStructuralDeliverable('분리했고 완료했습니다. agent-tool-definitions.ts'));
    const gate = evaluateOutcomeGate({
      text: '`core/src/agent/agent-tool-definitions.ts`로 분리했고 수정을 완료했습니다.',
      mutatedOk: true,
      mutatedPaths: [
        'core/src/agent/tools.ts',
        'core/src/agent/agent-tool-definitions.ts',
      ],
      fileContents: {
        'core/src/agent/tools.ts': tools,
        'core/src/agent/agent-tool-definitions.ts': defs,
      },
      diagnostics: true,
      workspaceRoot: fixture,
    });
    assert.equal(gate.ok, true, gate.reason);
  }

  // 5) Partial language always honest
  assert.ok(contentClaimsPartialOnly('부분 반영: import만 정리'));

  // cleanup fixture (keep CI clean)
  rmSync(fixture, { recursive: true, force: true });
}

console.log('verify-golden-refactor: ok');
