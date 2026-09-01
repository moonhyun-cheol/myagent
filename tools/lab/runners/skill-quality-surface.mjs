/**
 * Skill quality honesty gate — always-on.
 * Proves explicit skill prompt loading; never classifies user prose locally.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function row(item, result, ms, note = '') {
  return { suite: 'skill_quality', item, level: 1, result, ms, note: String(note).slice(0, 280) };
}

const MATRIX = [
  { skill: 'web_dev', message: 'src/app.ts 버그 수정해줘', expectMode: 'web_dev' },
  { skill: 'image_gen', message: '제품 이미지를 만들어줘', expectMode: 'image_gen' },
  { skill: 'deep_research', message: '시장 자료를 조사해줘', expectMode: 'deep_research' },
];

const BUNDLE_FILES = [
  'core/config/defaults/skills/web-dev.md',
  'core/config/defaults/skills/web-landing-page.md',
  'core/config/defaults/skills/prompt-master-core.md',
  'core/config/defaults/skills/manifest.json',
];

export async function runSkillQualitySurface(root) {
  const rows = [];
  const t0 = Date.now();

  for (const rel of BUNDLE_FILES) {
    const abs = path.join(root, rel);
    rows.push(
      row(
        `bundle:${path.basename(rel)}`,
        existsSync(abs) ? 'pass' : 'fail',
        0,
        existsSync(abs) ? rel : `missing ${rel}`,
      ),
    );
  }

  rows.push(
    row(
      'honesty_inject_ne_deliverable',
      'pass',
      0,
      'inject/routing pass is not business skill quality; L2_LLM skeleton is not product output',
    ),
  );

  try {
    const { resolveSkillSystemPrompt } = await import(
      pathToFileURL(path.join(root, 'core/dist/skills/chat-skill-flow.js')).href
    );

    for (const m of MATRIX) {
      const t = Date.now();
      try {
        const prompt = resolveSkillSystemPrompt(m.expectMode, root, m.message);
        if (!prompt || prompt.length < 40) {
          rows.push(row(`inject:${m.skill}`, 'fail', Date.now() - t, 'empty/short skill prompt'));
          continue;
        }
        rows.push(
          row(
            `explicit-inject:${m.skill}`,
            'pass',
            Date.now() - t,
            `mode=${m.expectMode}; prompt=${prompt.length}c`,
          ),
        );
      } catch (e) {
        rows.push(
          row(
            `inject:${m.skill}`,
            'fail',
            Date.now() - t,
            e instanceof Error ? e.message : String(e),
          ),
        );
      }
    }

    // L2 LLM remains opt-in; report honesty row
    rows.push(
      row(
        'l2_llm_opt_in',
        process.env.MY_AGENT_LAB_L2_LLM === '1' ? 'pass' : 'skip',
        0,
        process.env.MY_AGENT_LAB_L2_LLM === '1'
          ? 'skeleton path enabled (still not paid chatCompletion)'
          : 'set MY_AGENT_LAB_L2_LLM=1 for synthetic skill skeleton only',
      ),
    );
  } catch (e) {
    rows.push(
      row('skill_quality_surface', 'fail', Date.now() - t0, e instanceof Error ? e.message : String(e)),
    );
  }

  return rows;
}
