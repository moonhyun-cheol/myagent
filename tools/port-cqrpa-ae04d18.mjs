#!/usr/bin/env node
/**
 * Selective port from CQR_PA ae04d18 (session import + agent UX bundle).
 * Skips identity, product facts, model center shell, install/publish, dispatch (manual merge).
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legacyRoot = path.resolve(process.env.MY_AGENT_LEGACY_ROOT || path.join(root, '..', '_port', 'CQR_PA'));

const COPY = [
  'core/src/agent/agent-context-profile.ts',
  'core/src/agent/agent-llm-step.ts',
  'core/src/agent/agent-run-step-loop.ts',
  'core/src/agent/agent-tool-parallel.ts',
  'core/src/chat/chat-orchestrator.ts',
  'core/src/debug-session-log.ts',
  'core/src/providers/openai-compatible.ts',
  'core/src/providers/prompt-context-cache.ts',
  'core/src/providers/responses-compatible.ts',
  'core/src/sessions/session-store.ts',
  'core/src/sessions/types.ts',
  'tools/verify-harness-policy.mjs',
  'tools/verify-prompt-cache.mjs',
  'tools/verify-session-preferred-model.mjs',
  'tools/verify-session-workspace-binding.mjs',
  'ui/workspace/src/App.tsx',
  'ui/workspace/src/api/myAgentClient.ts',
  'ui/workspace/src/components/GeminiNavSidebar.tsx',
  'ui/workspace/src/components/ProjectsTree.tsx',
  'ui/workspace/src/lib/sessionImport.ts',
  'ui/workspace/src/store/workspaceStore.ts',
  'ui/workspace/src/types.ts',
];

const DELETE = [
  'tools/verify-chat-open-scroll.mjs',
];

let copied = 0;
for (const file of COPY) {
  const src = path.join(legacyRoot, file);
  const dest = path.join(root, file);
  if (!existsSync(src)) {
    console.error(`missing legacy: ${file}`);
    process.exitCode = 1;
    continue;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest);
  console.log(`copied: ${file}`);
  copied += 1;
}

let deleted = 0;
for (const file of DELETE) {
  const dest = path.join(root, file);
  if (!existsSync(dest)) continue;
  rmSync(dest, { force: true });
  console.log(`deleted: ${file}`);
  deleted += 1;
}

console.log(`port-cqrpa-ae04d18: copied ${copied}, deleted ${deleted}`);
