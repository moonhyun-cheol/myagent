/**
 * Extract executeAgentTool from tools.ts into this module.
 * Run: node tools/split-agent-tool-execute.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolsPath = path.join(root, 'core/src/agent/tools.ts');
const outPath = path.join(root, 'core/src/agent/agent-tool-execute.ts');
const lines = readFileSync(toolsPath, 'utf8').split(/\n/);
const start = lines.findIndex((l) => l.startsWith('export async function executeAgentTool'));
const end = lines.findIndex((l, i) => i > start && l.startsWith('export function toolStatusLabel'));
if (start < 0 || end < 0) {
  console.error('markers not found', { start, end });
  process.exit(1);
}
const body = lines.slice(start, end).join('\n').replace(/\bparseArgs\(/g, 'parseToolArgs(');
const header = `/**
 * Tool execution for the code agent (split from tools.ts).
 */
import {
  editWorkspaceFile,
  listWorkspaceDirectory,
  readWorkspaceFile,
  searchWorkspaceFiles,
  writeWorkspaceFile,
} from './dev-workspace-fs.js';
import { formatToolSelfCorrection } from './tool-self-correction.js';
import {
  formatRunTerminalOutput,
  gitCommit,
  gitDiff,
  gitStatus,
  runTerminalCommand,
} from './run-terminal.js';
import { runWorkspaceTests } from './run-tests.js';
import { runWorkspaceDiagnostics } from './run-diagnostics.js';
import {
  createWorkspaceCheckpoint,
  listWorkspaceCheckpoints,
  rollbackWorkspaceCheckpoint,
} from './agent-checkpoint.js';
import {
  applyFilePatches,
  deleteWorkspaceFile,
  formatApplyPatchOutput,
  renameWorkspaceFile,
  resolveApplyPatchArgs,
} from './apply-patch.js';
import { queryRepoMap } from './repo-map.js';
import { searchEmbeddingIndexAsync } from './agent-embedding-index.js';
import {
  CODE_AGENT_TOOL_NAMES,
  getCodeAgentToolNames,
  normalizeToolCall,
  parseToolArgs,
  type AgentToolCall,
  type AgentToolContext,
} from './tools.js';

`;
writeFileSync(outPath, `${header}${body}\n`, 'utf8');
const kept = [...lines.slice(0, start), ...lines.slice(end)];
// Insert re-export before toolStatusLabel
const reinject = [
  "export { executeAgentTool } from './agent-tool-execute.js';",
  '',
];
const toolStatusIdx = kept.findIndex((l) => l.startsWith('export function toolStatusLabel'));
kept.splice(toolStatusIdx, 0, ...reinject);
writeFileSync(toolsPath, kept.join('\n'), 'utf8');
console.log('split ok', { execLines: end - start, outPath });
