/**
 * Embedding cold path used by lab L1.
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function row(item, result, ms, note = '') {
  return { suite: 'embeddings', item, level: 1, result, ms, note: String(note).slice(0, 240) };
}

export async function runEmbeddingCold(root, outDir) {
  const cold = path.join(outDir, 'cold-embed');
  if (existsSync(cold)) rmSync(cold, { recursive: true, force: true });
  mkdirSync(cold, { recursive: true });
  writeFileSync(path.join(cold, 'README.md'), '# empty\n', 'utf8');

  const t0 = Date.now();
  try {
    const { executeAgentTool } = await import(
      pathToFileURL(path.join(root, 'core/dist/agent/tools.js')).href
    );
    const res = await executeAgentTool(
      cold,
      {
        id: 'lab_cold',
        type: 'function',
        function: {
          name: 'search_embeddings',
          arguments: JSON.stringify({ query: 'nonexistent_symbol_xyz_cold' }),
        },
      },
      { allowNas: false },
      { cqrRoot: root, sessionId: 'lab_cold_embed' },
    );
    const out = String(res.output || '');
    let count = null;
    try {
      count = JSON.parse(out.split('\n\n')[0] || out).count;
    } catch {
      const m = out.match(/"count"\s*:\s*(\d+)/);
      count = m ? Number(m[1]) : null;
    }
    const hasHint = /0 hits|Empty retrieval/i.test(out);
    const ok = count === 0 && hasHint && !/^ERROR:/m.test(out);
    return [
      row(
        'search_embeddings_cold',
        ok ? 'pass' : 'fail',
        Date.now() - t0,
        ok ? `count=0 soft-hint` : `count=${count}; ${out.slice(0, 160)}`,
      ),
    ];
  } catch (e) {
    return [
      row(
        'search_embeddings_cold',
        'fail',
        Date.now() - t0,
        e instanceof Error ? e.message : String(e),
      ),
    ];
  }
}
