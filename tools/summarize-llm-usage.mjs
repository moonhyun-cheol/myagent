import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Finish events only; unknown token values are counted, never treated as known zero. */
export async function summarizeUsage(files, filters = {}) {
  const groups = new Map();
  const starts = new Set();
  const ends = new Set();
  let invalidLines = 0;
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { invalidLines++; continue; }
      if (!row || row.version !== 1 || typeof row.call_id !== 'string') { invalidLines++; continue; }
      if (filters.session && row.session_id !== filters.session || filters.run && row.run_id !== filters.run) continue;
      if (row.event === 'start') { starts.add(row.call_id); continue; }
      if (row.event !== 'finish' || ends.has(row.call_id)) continue;
      ends.add(row.call_id);
      const key = JSON.stringify([row.session_id ?? null, row.run_id ?? null, row.provider_id ?? null, row.model ?? null, row.wire_api, row.input_semantics]);
      if (!groups.has(key)) groups.set(key, {
        session_id: row.session_id ?? null, run_id: row.run_id ?? null, provider_id: row.provider_id ?? null,
        model: row.model ?? null, wire_api: row.wire_api, input_semantics: row.input_semantics,
        calls: 0, outcomes: {}, usage_statuses: {}, counters: {}, duration_ms: 0, request_bytes: 0,
        cache_ratio_known_input: 0, cache_ratio_known_cached: 0, cache_ratio_calls: 0,
      });
      const group = groups.get(key);
      group.calls++;
      group.outcomes[row.outcome] = (group.outcomes[row.outcome] ?? 0) + 1;
      group.usage_statuses[row.usage_status] = (group.usage_statuses[row.usage_status] ?? 0) + 1;
      group.duration_ms += typeof row.duration_ms === 'number' ? row.duration_ms : 0;
      group.request_bytes += typeof row.request_bytes === 'number' ? row.request_bytes : 0;
      for (const field of ['input_tokens', 'total_input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens', 'reasoning_tokens']) {
        const counter = group.counters[field] ??= { known_sum: 0, known_calls: 0, unknown_calls: 0 };
        if (typeof row[field] === 'number' && Number.isSafeInteger(row[field]) && row[field] >= 0) {
          counter.known_sum += row[field]; counter.known_calls++;
        } else counter.unknown_calls++;
      }
      if (typeof row.total_input_tokens === 'number' && typeof row.cached_tokens === 'number') {
        group.cache_ratio_known_input += row.total_input_tokens;
        group.cache_ratio_known_cached += row.cached_tokens;
        group.cache_ratio_calls++;
      }
    }
  }
  return {
    version: 1, completed_attempt_records: ends.size, starts_without_finish: [...starts].filter(id => !ends.has(id)).length,
    invalid_lines: invalidLines,
    groups: [...groups.values()].map(group => ({ ...group, cache_read_ratio: group.cache_ratio_known_input > 0 ? group.cache_ratio_known_cached / group.cache_ratio_known_input : null })),
    note: 'known_sum is only provider-reported data, not a billing estimate. Starts without finish indicate interrupted/unsettled observation. Reasoning/cache counts are subsets; do not add them to Chat/Responses input/output totals.',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const root = path.resolve(import.meta.dirname, '..');
  const dir = path.resolve(option('--dir') ?? path.join(root, 'data', 'logs', 'llm-usage'));
  const files = readdirSync(dir).filter(name => /^llm-usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().map(name => path.join(dir, name));
  console.log(JSON.stringify(await summarizeUsage(files, { session: option('--session'), run: option('--run') }), null, 2));
}
