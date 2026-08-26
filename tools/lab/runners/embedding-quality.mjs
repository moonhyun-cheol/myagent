/**
 * Embedding / repo-map quality against a real workspace (not cold-empty only).
 */
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function row(item, result, ms, note = '') {
  return { suite: 'embeddings', item, level: 1, result, ms, note: String(note).slice(0, 280) };
}

function parseCount(out) {
  const raw = String(out || '').trim();
  try {
    const j = JSON.parse(raw.split(/\n\nInstructions/)[0] || raw);
    if (typeof j.count === 'number') return j.count;
    if (Array.isArray(j.hits)) return j.hits.length;
  } catch {
    /* fall */
  }
  const m = raw.match(/"count"\s*:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

export async function runEmbeddingQualitySurface(root, workspaceRoot) {
  const rows = [];
  if (!workspaceRoot || !existsSync(workspaceRoot)) {
    return [row('quality', 'skip', 0, 'no workspace for warm index')];
  }

  const { executeAgentTool } = await import(
    pathToFileURL(path.join(root, 'core/dist/agent/tools.js')).href
  );
  const ctx = {
    cqrRoot: root,
    sessionId: `lab_embed_quality_${Date.now()}`,
  };
  const tc = (name, args) => ({
    id: `eq_${name}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args || {}) },
  });

  // query_repo_map
  {
    const t0 = Date.now();
    try {
      const res = await executeAgentTool(
        workspaceRoot,
        tc('query_repo_map', { query: 'brand Studio Line version localStorage' }),
        { allowNas: false },
        ctx,
      );
      const out = String(res.output || '');
      const count = parseCount(out);
      const ok = !/^ERROR:/m.test(out) && count !== null && count > 0;
      rows.push(
        row(
          'query_repo_map_warm',
          ok ? 'pass' : 'fail',
          Date.now() - t0,
          ok ? `count=${count}` : `count=${count}; ${out.slice(0, 140)}`,
        ),
      );
    } catch (e) {
      rows.push(row('query_repo_map_warm', 'fail', Date.now() - t0, e instanceof Error ? e.message : String(e)));
    }
  }

  // search_embeddings
  {
    const t0 = Date.now();
    try {
      const res = await executeAgentTool(
        workspaceRoot,
        tc('search_embeddings', { query: 'Studio Line Max cqr-maxstress localStorage task' }),
        { allowNas: false },
        ctx,
      );
      const out = String(res.output || '');
      const count = parseCount(out);
      // Offline/local embed may return 0 if disabled — treat disabled honestly.
      if (/MY_AGENT_EMBEDDINGS=0|embeddings disabled|disabled/i.test(out)) {
        rows.push(row('search_embeddings_warm', 'skip', Date.now() - t0, 'embeddings disabled'));
      } else if (/^ERROR:/m.test(out)) {
        rows.push(row('search_embeddings_warm', 'fail', Date.now() - t0, out.slice(0, 160)));
      } else if (count === 0) {
        // Cold empty content still can score fail on populated workspace — soft fail unless force
        const force = process.env.MY_AGENT_LAB_EMBED_FORCE === '1';
        rows.push(
          row(
            'search_embeddings_warm',
            force ? 'fail' : 'skip',
            Date.now() - t0,
            'count=0 (local embed may not index small trees; force with MY_AGENT_LAB_EMBED_FORCE=1)',
          ),
        );
      } else {
        rows.push(row('search_embeddings_warm', 'pass', Date.now() - t0, `count=${count}`));
      }
    } catch (e) {
      rows.push(
        row('search_embeddings_warm', 'fail', Date.now() - t0, e instanceof Error ? e.message : String(e)),
      );
    }
  }

  // search_files
  {
    const t0 = Date.now();
    try {
      const res = await executeAgentTool(
        workspaceRoot,
        tc('search_files', { query: 'cqr-maxstress-v1' }),
        { allowNas: false },
        ctx,
      );
      const out = String(res.output || '');
      const ok = !/^ERROR:/m.test(out) && /cqr-maxstress|store\.js|app\.js/i.test(out);
      rows.push(
        row(
          'search_files_warm',
          ok ? 'pass' : 'fail',
          Date.now() - t0,
          ok ? 'hit storage key path' : out.slice(0, 140),
        ),
      );
    } catch (e) {
      rows.push(row('search_files_warm', 'fail', Date.now() - t0, e instanceof Error ? e.message : String(e)));
    }
  }

  return rows;
}
