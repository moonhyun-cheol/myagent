/**
 * Path-free greenfield fixture (no live LLM).
 * Asserts soft default file set + cold-create detect for 3 sample prompts.
 * Live agent 3-run is still ops (`lab:agent-only-desktop` with free-form prompt).
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function row(item, result, ms, note = '') {
  return { suite: 'greenfield_pathless', item, level: 1, result, ms, note: String(note).slice(0, 280) };
}

const PROMPTS = [
  '웹 앱 하나 만들어줘',
  '간단한 랜딩 만들어 줘',
  'npm으로 테스트 가능한 작은 사이트 초안 만들어줘',
];

export async function runGreenfieldPathlessSurface(root) {
  const rows = [];
  const t0 = Date.now();
  const outDir = path.join(root, 'data', '_skill_tool_lab', 'greenfield-pathless');
  mkdirSync(outDir, { recursive: true });

  try {
    const {
      buildTaskChecklist,
      looksLikeColdMultiCreate,
      formatGreenfieldDefaultSetNote,
    } = await import(
      pathToFileURL(path.join(root, 'core/dist/agent/agent-task-checklist.js')).href
    );

    let allPass = true;
    for (let i = 0; i < PROMPTS.length; i += 1) {
      const msg = PROMPTS[i];
      const cl = buildTaskChecklist(msg);
      const hasDefault = cl.labels.includes('greenfield-default-set')
        || (cl.labels.includes('cold-create') && cl.requiredPaths.length >= 3)
        || (cl.labels.includes('greenfield') && cl.requiredPaths.length >= 3);
      const note = formatGreenfieldDefaultSetNote(cl);
      const expectsChunk =
        /at most 2 write_file|Stream-safe|≤2 write_file/i.test(note) || note.length === 0;
      // path-free greenfield phrase should seed default set
      const phraseOk = cl.labels.includes('greenfield-default-set') || cl.labels.includes('greenfield')
        || looksLikeColdMultiCreate(msg);
      const ok = hasDefault || phraseOk;
      if (!ok) allPass = false;
      rows.push(
        row(
          `prompt_${i + 1}`,
          ok ? 'pass' : 'fail',
          0,
          `labels=${cl.labels.join(',')}; paths=${cl.requiredPaths.length}; retrieval=${cl.requireRetrieval}; chunk=${expectsChunk}`,
        ),
      );
      void expectsChunk;
    }

    // Cold multi-create classic (path list + write_file markers)
    const cold = [
      '빈 Desktop 워크스페이스에 데모 프로젝트를 한 실행에서 완성.',
      '필수 파일 write_file: public/index.html public/app.js src/lib.js package.json README.md',
      'SEED.md 유지. missing 0 까지 완료.',
    ].join(' ');
    const coldCl = buildTaskChecklist(cold);
    rows.push(
      row(
        'cold_multi_create',
        looksLikeColdMultiCreate(cold) || coldCl.labels.includes('cold-create') ? 'pass' : 'fail',
        0,
        `labels=${coldCl.labels.join(',')}; detect=${looksLikeColdMultiCreate(cold)}`,
      ),
    );

    // Soft acceptance contract for ops live runs
    const contract = {
      product: 'pathless_greenfield_fixture',
      prompts: PROMPTS,
      default_paths: ['index.html', 'app.js', 'styles.css', 'package.json', 'README.md'],
      acceptance: [
        '≥3 deliverable files + README on disk',
        'package.json exists if web test script expected',
        'no retrieval-first tax on cold empty workspace',
        'batch write_file preferred (one tool turn multi-create)',
      ],
      live_driver: 'node tools/lab/agent-only-desktop.mjs with free-form pathless prompt',
      note: 'This surface is unit-level only; does not run paid LLM.',
    };
    const contractPath = path.join(outDir, 'acceptance-contract.json');
    writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
    rows.push(
      row(
        'acceptance_contract',
        existsSync(contractPath) && allPass ? 'pass' : allPass ? 'pass' : 'fail',
        Date.now() - t0,
        contractPath,
      ),
    );
  } catch (e) {
    rows.push(
      row(
        'greenfield_pathless',
        'fail',
        Date.now() - t0,
        e instanceof Error ? e.message : String(e),
      ),
    );
  }

  return rows;
}
