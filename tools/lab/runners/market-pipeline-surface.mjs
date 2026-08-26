/**
 * Market research pipeline capability + optional run.ps1 non-mutating probe.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

function row(item, result, ms, note = '') {
  return { suite: 'market_pipeline', item, level: 1, result, ms, note: String(note).slice(0, 280) };
}

export async function runMarketPipelineSurface(root) {
  const rows = [];
  const t0 = Date.now();
  try {
    const { getMarketPipelineCapability } = await import(
      pathToFileURL(path.join(root, 'core/dist/skills/market-pipeline-capability.js')).href
    );
    const cap = getMarketPipelineCapability(root);
    if (!cap.available) {
      rows.push(
        row(
          'capability',
          'skip',
          Date.now() - t0,
          `not ready (${cap.status}): ${cap.message_ko}`,
        ),
      );
      rows.push(
        row(
          'run_ps1',
          'skip',
          0,
          'inject/playbook only — do not claim Excel pipeline ran',
        ),
      );
      return rows;
    }

    rows.push(row('capability', 'pass', Date.now() - t0, `${cap.status}; script=${cap.script}`));
    rows.push(
      row(
        'pipeline_venv',
        cap.pipeline_venv ? 'pass' : 'skip',
        0,
        cap.pipeline_venv
          ? 'runtime/pipeline-venv present'
          : 'no pipeline-venv — PATH python may still work',
      ),
    );

    if (cap.script && existsSync(cap.script)) {
      rows.push(row('run_ps1_on_disk', 'pass', 0, cap.script));
    } else {
      rows.push(row('run_ps1_on_disk', 'fail', 0, 'script path missing on disk'));
    }

    const live = process.env.MY_AGENT_LAB_MARKET_LIVE === '1';
    if (!live) {
      rows.push(
        row(
          'run_ps1_live',
          'skip',
          0,
          'set MY_AGENT_LAB_MARKET_LIVE=1 for PowerShell file+syntax probe (still no full research job by default)',
        ),
      );
      rows.push(
        row(
          'full_research_job',
          'skip',
          0,
          'never auto: brand_manager research/pipeline is ops manual (MY_AGENT_LAB_MARKET_FULL=1 reserved, not implemented in lab)',
        ),
      );
      return rows;
    }

    const script = String(cap.script).replace(/'/g, "''");
    const r = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Get-Item -LiteralPath '${script}' | Select-Object FullName,Length | ConvertTo-Json -Compress`,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    rows.push(
      row(
        'run_ps1_live',
        r.status === 0 ? 'pass' : 'fail',
        0,
        r.status === 0
          ? `file probe: ${(r.stdout || '').slice(0, 120)}`
          : (r.stderr || r.stdout || 'fail').slice(0, 160),
      ),
    );

    // Syntax-level dry: parse first Param/synopsis without running research.
    const help = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$null, [ref]$e); if ($e -and $e.Count) { $e[0].ToString(); exit 1 } else { 'parse_ok' }`,
      ],
      { encoding: 'utf8', timeout: 45_000 },
    );
    rows.push(
      row(
        'run_ps1_parse',
        help.status === 0 && /parse_ok/.test(help.stdout || '') ? 'pass' : 'fail',
        0,
        (help.stdout || help.stderr || '').slice(0, 160),
      ),
    );

    const full = process.env.MY_AGENT_LAB_MARKET_FULL === '1';
    rows.push(
      row(
        'full_research_job',
        full ? 'skip' : 'skip',
        0,
        full
          ? 'MY_AGENT_LAB_MARKET_FULL=1 set but lab still refuses auto research side-effects'
          : 'full research never auto-fired; run run.ps1 research manually on ops PC',
      ),
    );
  } catch (e) {
    rows.push(
      row('market_surface', 'fail', Date.now() - t0, e instanceof Error ? e.message : String(e)),
    );
  }
  return rows;
}
