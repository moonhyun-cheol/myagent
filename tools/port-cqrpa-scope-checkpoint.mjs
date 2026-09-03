#!/usr/bin/env node
/**
 * Selective port from CQR_PA 1ce0b67 + dd845c6 (scope settings, progress checkpoint,
 * scheduler JSON store, continuation/syntax gating).
 *
 * Skips identity, product facts, model center shell, install/publish, and files that
 * need manual merge (session-context, dispatch, ModelManagementModal).
 *
 * Usage: MY_AGENT_LEGACY_ROOT=/path/to/CQR_PA node tools/port-cqrpa-scope-checkpoint.mjs [--dry-run]
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const legacyRoot = path.resolve(process.env.MY_AGENT_LEGACY_ROOT || path.join(root, '..', '_port', 'CQR_PA'));

const COPY = [
  // New modules
  'core/src/agent/agent-progress-checkpoint.ts',
  'core/src/scheduler/execution-config.ts',
  'ui/workspace/src/components/ScopeSettingsModal.tsx',
  'ui/workspace/src/components/AutomationFeedModal.tsx',
  // Agent runtime / continuity / failure
  'core/src/agent/agent-run-loop.ts',
  'core/src/agent/agent-run-step-loop.ts',
  'core/src/agent/agent-run-step-state.ts',
  'core/src/agent/agent-run-meta.ts',
  'core/src/agent/agent-run-types.ts',
  'core/src/agent/agent-session-continuity.ts',
  'core/src/agent/agent-failure-plane.ts',
  'core/src/agent/agent-post-mutate-syntax.ts',
  'core/src/agent/agent-autopilot.ts',
  'core/src/agent/agent-context-profile.ts',
  'core/src/agent/tool-approval.ts',
  'core/src/agent/verify-loop.ts',
  'core/src/chat/assistant-reply.ts',
  'core/src/chat/chat-orchestrator.ts',
  'core/src/chat/modes/workspace-agent.ts',
  'core/src/router/types.ts',
  'core/src/sessions/types.ts',
  // Scope settings backend
  'core/src/projects/project-store.ts',
  'core/src/projects/types.ts',
  'core/src/memory/user-memory-store.ts',
  'core/src/config/user-overrides.ts',
  'core/src/execution-policy.ts',
  'core/src/api-server.ts',
  'core/src/debug-session-log.ts',
  // Providers
  'core/src/providers/anthropic-messages.ts',
  'core/src/providers/cloud-chat.ts',
  'core/src/providers/harness-policy.ts',
  'core/src/providers/openai-compatible.ts',
  'core/src/providers/responses-compatible.ts',
  // Scheduler JSON store
  'core/src/scheduler/types.ts',
  'core/src/scheduler/personal-scheduler-store.ts',
  'core/src/scheduler/personal-scheduler-service.ts',
  // UI (ModelManagementModal excluded — keep-policy manual merge)
  'ui/workspace/src/components/ChatPane.tsx',
  'ui/workspace/src/components/GeminiNavSidebar.tsx',
  'ui/workspace/src/components/ProjectsTree.tsx',
  'ui/workspace/src/components/UserMemoryPanel.tsx',
  'ui/workspace/src/api/myAgentClient.ts',
  'ui/workspace/src/store/workspaceStore.ts',
  'ui/workspace/src/types.ts',
  // Verify scripts
  'tools/verify-failure-plane.mjs',
  'tools/verify-harness-policy.mjs',
  'tools/verify-model-directed-runtime.mjs',
  'tools/verify-post-mutate-syntax.mjs',
  'tools/verify-session-continuity.mjs',
  'tools/verify-session-preferred-model.mjs',
  'tools/verify-session-workspace-binding.mjs',
  'tools/verify-personal-scheduler.mjs',
  'tools/verify-company-openrouter.mjs',
];

let copied = 0;
let missing = 0;
for (const file of COPY) {
  const src = path.join(legacyRoot, file);
  const dest = path.join(root, file);
  if (!existsSync(src)) {
    console.error(`missing legacy: ${file}`);
    missing += 1;
    continue;
  }
  if (dryRun) {
    console.log(`would copy: ${file}`);
    copied += 1;
    continue;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest);
  console.log(`copied: ${file}`);
  copied += 1;
}

console.log(
  `port-cqrpa-scope-checkpoint: ${dryRun ? 'would copy' : 'copied'} ${copied}, missing ${missing}`,
);
if (missing) process.exitCode = 1;
