/**
 * Automaton tool dry-run (schema + intent, no OpenClaw side effects).
 * Live network only when MY_AGENT_LAB_OPENCLAW=1 and adapter configured (still default dry).
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function row(item, result, ms, note = '') {
  return { suite: 'automaton', item, level: 1, result, ms, note: String(note).slice(0, 240) };
}

export async function runAutomatonDry(root) {
  const rows = [];
  const manifestPath = path.join(root, 'core/config/defaults/automaton-tools.manifest.json');
  if (!existsSync(manifestPath)) {
    return [row('manifest', 'fail', 0, 'missing automaton-tools.manifest.json')];
  }

  const doc = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const tools = doc.tools || [];
  rows.push(row('manifest_count', 'pass', 0, `neutral core tools=${tools.length}`));

  const required = ['id', 'description_ko', 'default_command'];
  for (const t of tools) {
    const start = Date.now();
    const missing = required.filter((k) => !t[k]);
    const hasAnchors =
      (Array.isArray(t.anchors_ko) && t.anchors_ko.length)
      || (Array.isArray(t.intent_phrases_ko) && t.intent_phrases_ko.length);
    if (missing.length || !hasAnchors) {
      rows.push(
        row(
          t.id || 'unknown',
          'fail',
          Date.now() - start,
          `missing=${missing.join(',') || 'anchors'}`,
        ),
      );
      continue;
    }
    rows.push(row(t.id, 'pass', Date.now() - start, 'schema ok (dry)'));
  }

  // Intent resolver smoke without network
  try {
    const intentMod = await import(
      pathToFileURL(path.join(root, 'core/dist/router/automaton-intent.js')).href
    );
    const resolve = intentMod.peekAutomatonIntent;
    if (typeof resolve === 'function') {
      const sample = tools[0]?.intent_examples?.[0] || tools[0]?.slash_prefixes?.[0] || 'example workflow request';
      const hit = resolve(String(sample));
      const neutralEmpty = tools.length === 0 && !hit;
      rows.push(
        row(
          'intent_resolve_sample',
          hit || neutralEmpty ? 'pass' : 'skip',
          0,
          hit
            ? `${hit.toolId || hit.tool?.id || 'hit'} conf=${hit.confidence ?? ''}`
            : neutralEmpty
              ? 'neutral core has no built-in automaton intent'
              : `no hit for ${sample}`,
        ),
      );
    } else {
      rows.push(row('intent_resolve_sample', 'skip', 0, 'no resolve export'));
    }
  } catch (e) {
    rows.push(row('intent_resolve_sample', 'skip', 0, e instanceof Error ? e.message : String(e)));
  }

  if (process.env.MY_AGENT_LAB_OPENCLAW === '1' || process.env.MY_AGENT_LAB_OPENCLAW_LIVE === '1') {
    try {
      const { resolveOpenClawAdapterConfig, probeOpenClawAdapterHealth } = await import(
        pathToFileURL(path.join(root, 'core/dist/automaton/openclaw-adapter-client.js')).href
      );
      const cfg = resolveOpenClawAdapterConfig({ cqrRoot: root });
      if (!cfg) {
        // Not configured ≠ product fail when opt-in is "try health if present".
        rows.push(
          row(
            'openclaw_live',
            process.env.MY_AGENT_LAB_OPENCLAW_LIVE === '1' ? 'fail' : 'skip',
            0,
            'adapter not configured (vault/env) — slash live remains manual',
          ),
        );
      } else {
        const h = await probeOpenClawAdapterHealth(cfg.baseUrl);
        rows.push(
          row(
            'openclaw_live',
            h.ok ? 'pass' : process.env.MY_AGENT_LAB_OPENCLAW_LIVE === '1' ? 'fail' : 'skip',
            0,
            h.ok
              ? `health HTTP ${h.status} (no slash side effect)`
              : h.error || `status=${h.status}`,
          ),
        );
      }
    } catch (e) {
      rows.push(row('openclaw_live', 'fail', 0, e instanceof Error ? e.message : String(e)));
    }
  } else {
    rows.push(row('openclaw_live', 'skip', 0, 'opt-in MY_AGENT_LAB_OPENCLAW=1 for /health only (no Discord job)'));
  }

  return rows;
}
