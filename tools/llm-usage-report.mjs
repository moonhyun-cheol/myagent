#!/usr/bin/env node
/**
 * Aggregate data/logs/llm-usage/*.jsonl (finish events) for every model.
 *
 *   node tools/llm-usage-report.mjs [--dir <path>] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
 *                                   [--by model|provider|session|run|day|wire] (comma-joined ok)
 *                                   [--model <substring>] [--json]
 *
 * input = provider-reported input incl. cache (total_input_tokens when present).
 * fresh = input - cached (billed at full price, includes cache writes).
 * cache = "none" when no call of the group ever read or wrote cache.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const dir = path.resolve(opt('dir', path.join(process.cwd(), 'data', 'logs', 'llm-usage')));
const since = opt('since', '');
const until = opt('until', '');
const by = opt('by', 'model').split(',').map((s) => s.trim()).filter(Boolean);
const modelFilter = opt('model', '').toLowerCase();
const asJson = args.includes('--json');

if (!existsSync(dir)) {
  console.error(`llm-usage dir not found: ${dir}`);
  process.exit(1);
}

const keyOf = (row) => by.map((k) => {
  if (k === 'model') return row.response_model || row.model || '(unknown)';
  if (k === 'provider') return row.provider_id || '(unknown)';
  if (k === 'session') return row.session_id || '(none)';
  if (k === 'run') return row.run_id || '(none)';
  if (k === 'day') return String(row.started_at || '').slice(0, 10);
  if (k === 'wire') return row.wire_api || '(unknown)';
  return '?';
}).join(' | ');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const groups = new Map();
let parsed = 0;
let badLines = 0;

for (const file of readdirSync(dir).filter((f) => /^llm-usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
  const day = file.slice(10, 20);
  if (since && day < since) continue;
  if (until && day > until) continue;
  for (const line of readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { badLines++; continue; }
    if (row.event !== 'finish') continue;
    const model = String(row.response_model || row.model || '').toLowerCase();
    if (modelFilter && !model.includes(modelFilter)) continue;
    parsed++;
    const key = keyOf(row);
    const g = groups.get(key) ?? {
      key, calls: 0, reported: 0, failed: 0, input: 0, cached: 0, cache_write: 0,
      output: 0, reasoning: 0, duration_ms: 0, max_input: 0, sessions: new Set(),
    };
    g.calls++;
    if (row.outcome !== 'completed') g.failed++;
    if (row.usage_status === 'reported') g.reported++;
    const input = row.total_input_tokens ?? row.input_tokens;
    g.input += num(input);
    g.max_input = Math.max(g.max_input, num(input));
    g.cached += num(row.cached_tokens);
    g.cache_write += num(row.cache_write_tokens);
    g.output += num(row.output_tokens);
    g.reasoning += num(row.reasoning_tokens);
    g.duration_ms += num(row.duration_ms);
    if (row.session_id) g.sessions.add(row.session_id);
    groups.set(key, g);
  }
}

const rows = [...groups.values()].map((g) => ({
  key: g.key,
  calls: g.calls,
  failed: g.failed,
  unreported: g.calls - g.reported,
  sessions: g.sessions.size,
  input: g.input,
  cached: g.cached,
  cache_write: g.cache_write,
  fresh: Math.max(0, g.input - g.cached),
  hit_pct: g.input ? Math.round((g.cached / g.input) * 1000) / 10 : 0,
  cache: g.cached || g.cache_write ? 'active' : 'none',
  avg_input: g.calls ? Math.round(g.input / g.calls) : 0,
  max_input: g.max_input,
  output: g.output,
  reasoning: g.reasoning,
  avg_sec: g.calls ? Math.round(g.duration_ms / g.calls / 100) / 10 : 0,
})).sort((a, b) => b.input - a.input);

if (asJson) {
  console.log(JSON.stringify({ dir, by, since: since || null, until: until || null, finish_rows: parsed, bad_lines: badLines, groups: rows }, null, 2));
} else {
  const cols = ['key', 'calls', 'failed', 'unreported', 'sessions', 'input', 'cached', 'cache_write', 'fresh', 'hit_pct', 'cache', 'avg_input', 'max_input', 'output', 'reasoning', 'avg_sec'];
  const fmt = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v));
  const table = [cols, ...rows.map((r) => cols.map((c) => fmt(r[c])))];
  const width = cols.map((_, i) => Math.max(...table.map((r) => String(r[i]).length)));
  for (const r of table) console.log(r.map((c, i) => (i === 0 ? String(c).padEnd(width[i]) : String(c).padStart(width[i]))).join('  '));
  const total = rows.reduce((t, r) => ({ input: t.input + r.input, cached: t.cached + r.cached, calls: t.calls + r.calls }), { input: 0, cached: 0, calls: 0 });
  console.log(`\n${total.calls} calls, input ${fmt(total.input)}, cached ${fmt(total.cached)} (${total.input ? ((total.cached / total.input) * 100).toFixed(1) : 0}%), bad lines ${badLines}`);
}
