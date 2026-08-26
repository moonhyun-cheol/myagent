/**
 * Skill quality honesty gate — always-on.
 * Proves: routing + inject length; never claims inject = business deliverable.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function row(item, result, ms, note = '') {
  return { suite: 'skill_quality', item, level: 1, result, ms, note: String(note).slice(0, 280) };
}

const MATRIX = [
  { skill: 'web_landing', message: '랜딩 페이지 히어로 HTML 만들어줘', expectMode: 'web_landing' },
  { skill: 'web_dev', message: 'src/app.ts 버그 수정해줘', expectMode: 'web_dev' },
  { skill: 'prompt_master', message: '미드저니용 룩북 프롬프트', expectMode: 'prompt_master' },
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
    const { matchFastSkillRoutes } = await import(
      pathToFileURL(path.join(root, 'core/dist/router/route-heuristics.js')).href
    );
    const { resolveSkillSystemPrompt } = await import(
      pathToFileURL(path.join(root, 'core/dist/skills/chat-skill-flow.js')).href
    );

    for (const m of MATRIX) {
      const t = Date.now();
      try {
        const fast = matchFastSkillRoutes(m.message);
        const mode = fast?.mode || null;
        if (mode !== m.expectMode) {
          rows.push(
            row(
              `route:${m.skill}`,
              'fail',
              Date.now() - t,
              `expected ${m.expectMode}, got ${mode || 'null'}`,
            ),
          );
          continue;
        }
        const prompt = resolveSkillSystemPrompt(m.expectMode, root, m.message);
        if (!prompt || prompt.length < 40) {
          rows.push(row(`inject:${m.skill}`, 'fail', Date.now() - t, 'empty/short skill prompt'));
          continue;
        }
        rows.push(
          row(
            `route+inject:${m.skill}`,
            'pass',
            Date.now() - t,
            `mode=${mode}; prompt=${prompt.length}c`,
          ),
        );
      } catch (e) {
        rows.push(
          row(
            `route:${m.skill}`,
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
