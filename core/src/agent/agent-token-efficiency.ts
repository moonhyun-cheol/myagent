import { createHash } from 'node:crypto';
import type { EvidenceRecord } from './agent-evidence-types.js';

/** Static instructions: no per-phase tool filtering or changing prefix guidance. */
export const TOKEN_EFFICIENCY_PRINCIPLES = [
  '## Token-efficient tool use (model-owned)',
  '- The full configured tool catalog stays available across task phases. Choose calls yourself; do not request phase-based tool hiding.',
  '- Reuse observed evidence when its source is unchanged and it covers the needed range. Read only missing ranges; reread after changes, for outcome verification, explicit user requests, or freshness uncertainty. fresh=true is not a token-saving option.',
  '- Search/map hits locate candidates, not authoritative source. Read the relevant source window before code claims or edits; avoid whole-file reads when a smaller coherent range is enough.',
  '- Ask commands for concise summaries and relevant failure details when sufficient; preserve exact raw results in evidence. Use evidence_read selectors and todo_update retainEvidence to keep necessary evidence prominent. Never omit required manual sections or user constraints just to reduce tokens.',
  '- If exploration repeats without new evidence, identify the remaining unknown and choose a narrower check, finish the supported explanation, or record a real blocker. Do not force a mutation for an analysis-only request. Novel read-only evidence is valid progress.',
] as const;

const EXPLORATION = new Set([
  'read_file', 'list_directory', 'search_files', 'query_repo_map', 'search_embeddings',
]);
// These tools can change files outside an explicit edit target. Reset conservatively.
const MAY_CHANGE_SOURCE = new Set([
  'write_file', 'edit_file', 'apply_patch', 'delete_file', 'rename_file',
  'run_terminal', 'run_tests', 'run_diagnostics', 'workspace_rollback',
  'git_pull', 'git_switch', 'git_restore', 'git_stash', 'plugin_install', 'plugin_set_enabled',
]);
const normalizePath = (value: string): string => value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)]));
}

type SeenRead = { path: string; sha: string; start: number; end: number };

/** Bounded in-run observation only. Never admits/blocks tools or changes results. */
export class TokenEfficiencyAdvisor {
  private reads: SeenRead[] = [];
  private results = new Set<string>();
  private window: boolean[] = [];
  private calls = 0;
  private lastNoteAt = -12;
  private notes = 0;
  private pending = new Set<'repeated' | 'large'>();

  observe(record: EvidenceRecord, output: string): void {
    this.calls += 1;
    if (MAY_CHANGE_SOURCE.has(record.tool)) {
      this.reads = [];
      this.results.clear();
      this.window = [];
      this.pending.clear();
      return;
    }
    if (!EXPLORATION.has(record.tool)) {
      this.window = [];
      return;
    }
    // Failed, unreturned, or explicitly fresh evidence does not imply redundant work.
    if (!record.ok || !record.complete || record.args.fresh === true) return;
    let repeated = false;
    if (record.tool === 'read_file') {
      // Source sha (not result sha) ignores changing cache hit/miss metadata.
      const meta = output.split('\n', 1)[0];
      const range = meta.match(/^\[read_file meta\].*?\blines=(\d+)-(\d+)\/\d+/);
      const sha = meta.match(/\bsha256=([a-f0-9]{64})\b/)?.[1];
      const sourcePath = record.source?.path ?? record.args.path;
      if (range && sha && typeof sourcePath === 'string') {
        const current: SeenRead = {
          path: normalizePath(sourcePath), sha, start: Number(range[1]), end: Number(range[2]),
        };
        if (current.end < current.start) return;
        repeated = this.reads.some((prior) => prior.path === current.path && prior.sha === sha
          && Math.max(0, Math.min(prior.end, current.end) - Math.max(prior.start, current.start) + 1)
            / (current.end - current.start + 1) >= 0.8);
        this.reads.push(current);
        if (this.reads.length > 128) this.reads.shift();
      }
    } else {
      const args = { ...record.args };
      if (typeof args.path === 'string') args.path = normalizePath(args.path);
      const key = hash(`${record.tool}|${JSON.stringify(canonical(args))}|${record.fingerprint}`);
      repeated = this.results.has(key);
      this.results.add(key);
      if (this.results.size > 128) this.results.delete(this.results.values().next().value!);
    }
    this.window.push(repeated);
    if (this.window.length > 12) this.window.shift();
    if (this.window.filter(Boolean).length >= 2) this.pending.add('repeated');
    if (output.length > 24_000) this.pending.add('large');
  }

  consumeNote(): string | null {
    const reasons = [...this.pending];
    this.pending.clear();
    // At most four short tail notes per run, and at least twelve tool calls apart.
    if (!reasons.length || this.notes >= 4 || this.calls - this.lastNoteAt < 12) return null;
    this.lastNoteAt = this.calls;
    this.notes += 1;
    return [
      'TOKEN_EFFICIENCY_ADVISORY (observation only; no tool/result was blocked or removed):',
      reasons.includes('repeated')
        ? 'Repeated unchanged/overlapping exploration was observed. Check whether it answers a new unknown; reuse available evidence or request missing ranges when sufficient. Rereading for verification/freshness remains allowed; novel read-only work is progress.' : '',
      reasons.includes('large')
        ? 'A large exploration result was observed. Prefer coherent line windows or evidence_read selectors for subsequent calls; do not drop required source or manual content.' : '',
      'You own the next action. No mutation or stopping is required by this advisory.',
    ].filter(Boolean).join('\n');
  }
}
