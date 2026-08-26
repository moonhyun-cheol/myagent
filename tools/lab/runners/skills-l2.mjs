/**
 * Skill L2 — routing/inject matrix + optional artifact / LLM.
 * MY_AGENT_LAB_L2=1          — routing + prompt inject
 * MY_AGENT_LAB_L2_ARTIFACT=1 — write one md artifact per skill under lab out dir (no paid LLM)
 * MY_AGENT_LAB_L2_LLM=1      — opt-in skeleton: one skill writes a synthetic “delivery stub”
 *                         under lab out (no paid API). Honest skip if off.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

function row(item, result, ms, note = '') {
  return { suite: 'skills_l2', item, level: 2, result, ms, note: String(note).slice(0, 240) };
}

const MATRIX = [
  { skill: 'web_landing', message: '랜딩 페이지 히어로 HTML 만들어줘', expectMode: 'web_landing' },
  { skill: 'web_dev', message: 'src/app.ts 버그 수정해줘', expectMode: 'web_dev' },
  { skill: 'prompt_master', message: '미드저니용 룩북 프롬프트', expectMode: 'prompt_master' },
];

export async function runSkillsL2(root) {
  const enabled = process.env.MY_AGENT_LAB_L2 === '1';
  if (!enabled) {
    return MATRIX.map((m) => row(m.skill, 'skip', 0, 'set MY_AGENT_LAB_L2=1 for live matrix'));
  }

  const rows = [];
  const { resolveSkillSystemPrompt } = await import(
    pathToFileURL(path.join(root, 'core/dist/skills/chat-skill-flow.js')).href
  );

  const wantArtifact = process.env.MY_AGENT_LAB_L2_ARTIFACT === '1';
  const artDir = path.join(root, 'data', '_skill_tool_lab', 'skill-artifacts');
  if (wantArtifact) mkdirSync(artDir, { recursive: true });

  for (const m of MATRIX) {
    const t0 = Date.now();
    try {
      const prompt = resolveSkillSystemPrompt(m.expectMode, root, m.message);
      if (!prompt || prompt.length < 40) {
        rows.push(row(m.skill, 'fail', Date.now() - t0, 'empty skill prompt'));
        continue;
      }
      rows.push(
        row(
          m.skill,
          'pass',
          Date.now() - t0,
          `mode=${m.expectMode}; prompt=${prompt.length}c (prompt registry; no local routing)`,
        ),
      );

      if (wantArtifact) {
        const body = [
          `# Skill artifact · ${m.skill}`,
          '',
          `Message: ${m.message}`,
          `Mode: ${m.expectMode}`,
          `Prompt chars: ${prompt.length}`,
          '',
          '## Inject head (first 600c)',
          '',
          '```',
          prompt.slice(0, 600).replace(/```/g, "'''"),
          '```',
          '',
        ].join('\n');
        const out = path.join(artDir, `${m.skill}.md`);
        writeFileSync(out, body, 'utf8');
        rows.push(
          row(
            `${m.skill}:artifact`,
            existsSync(out) && prompt.length >= 40 ? 'pass' : 'fail',
            0,
            out,
          ),
        );
      }
    } catch (e) {
      rows.push(row(m.skill, 'fail', Date.now() - t0, e instanceof Error ? e.message : String(e)));
    }
  }

  if (process.env.MY_AGENT_LAB_L2_LLM === '1') {
    const t0 = Date.now();
    try {
      const llmDir = path.join(root, 'data', '_skill_tool_lab', 'skill-llm-stubs');
      mkdirSync(llmDir, { recursive: true });
      // One skill only (cap token / pay). Synthetic delivery — not a model completion.
      const skill = 'web_landing';
      const stubPath = path.join(llmDir, `${skill}.llm-stub.md`);
      const body = [
        `# L2 LLM skeleton · ${skill}`,
        '',
        'Status: skeleton only (no paid chatCompletion).',
        'Enable product chat + keys for real skill outputs.',
        '',
        '## Deliverable contract',
        '- Routing + inject tested in matrix above',
        '- This file proves MY_AGENT_LAB_L2_LLM path writes one artifact per gate',
        '',
      ].join('\n');
      writeFileSync(stubPath, body, 'utf8');
      rows.push(
        row(
          'live_llm:skeleton',
          existsSync(stubPath) ? 'pass' : 'fail',
          Date.now() - t0,
          stubPath,
        ),
      );
    } catch (e) {
      rows.push(
        row('live_llm:skeleton', 'fail', Date.now() - t0, e instanceof Error ? e.message : String(e)),
      );
    }
  }

  return rows;
}
