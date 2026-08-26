/**
 * OpenClaw adapter: schema dry + non-destructive live /health when configured.
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

function row(item, result, ms, note = '') {
  return { suite: 'openclaw', item, level: 1, result, ms, note: String(note).slice(0, 280) };
}

export async function runOpenClawSurface(root) {
  const rows = [];
  const t0 = Date.now();
  const runbook = path.join(root, 'tools/lab/OPENCLAW_RUNBOOK.md');
  rows.push(
    row(
      'runbook',
      existsSync(runbook) ? 'pass' : 'fail',
      0,
      existsSync(runbook) ? 'OPENCLAW_RUNBOOK.md' : 'missing tools/lab/OPENCLAW_RUNBOOK.md',
    ),
  );
  try {
    const { resolveOpenClawAdapterConfig, probeOpenClawAdapterHealth } = await import(
      pathToFileURL(path.join(root, 'core/dist/automaton/openclaw-adapter-client.js')).href
    );
    const cfg = resolveOpenClawAdapterConfig({ cqrRoot: root });
    if (!cfg) {
      rows.push(
        row(
          'adapter_config',
          'skip',
          Date.now() - t0,
          'no baseUrl+token (vault openclaw-adapter.json or OPENCLAW_ADAPTER_* env) — dry-only path',
        ),
      );
      rows.push(row('adapter_health', 'skip', 0, 'skipped: not configured'));
    } else {
      rows.push(
        row(
          'adapter_config',
          'pass',
          Date.now() - t0,
          `url=${cfg.baseUrl.slice(0, 60)} actor=${cfg.actorId || '-'}`,
        ),
      );
      const h0 = Date.now();
      const health = await probeOpenClawAdapterHealth(cfg.baseUrl);
      const wantLive = process.env.MY_AGENT_LAB_OPENCLAW_LIVE === '1' || process.env.MY_AGENT_LAB_OPENCLAW === '1';
      if (health.ok) {
        rows.push(
          row(
            'adapter_health',
            'pass',
            Date.now() - h0,
            `HTTP ${health.status} live network (/health only; no slash side effect)`,
          ),
        );
      } else if (wantLive) {
        rows.push(
          row(
            'adapter_health',
            'fail',
            Date.now() - h0,
            health.error || `status=${health.status} body=${(health.body || '').slice(0, 120)}`,
          ),
        );
      } else {
        rows.push(
          row(
            'adapter_health',
            'skip',
            Date.now() - h0,
            `configured but health fail (${health.error || health.status}) — set MY_AGENT_LAB_OPENCLAW_LIVE=1 to hard-fail`,
          ),
        );
      }
      // Destructive slash/job still never auto-fired here.
      rows.push(
        row(
          'slash_side_effect',
          'skip',
          0,
          'safety: no auto Discord job; see OPENCLAW_RUNBOOK.md — manual slash only',
        ),
      );
    }
  } catch (e) {
    rows.push(row('openclaw_surface', 'fail', Date.now() - t0, e instanceof Error ? e.message : String(e)));
  }
  return rows;
}
