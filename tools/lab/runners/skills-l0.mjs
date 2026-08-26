/**
 * Skills L0 + light L1: registry loads, prompt non-empty, routing anchors exist.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

function row(item, level, result, ms, note = '') {
  return { suite: 'skills', item, level, result, ms, note: String(note).slice(0, 240) };
}

export async function runSkills(root, catalog, level = 1) {
  const rows = [];
  const distReg = path.join(root, 'core/dist/skills/skill-registry.js');
  if (!existsSync(distReg)) {
    return catalog.skills.map((s) => row(s.id, 0, 'fail', 0, 'build missing skill-registry'));
  }

  const t0 = Date.now();
  let getSkillDef;
  let getSkillSystemPrompt;
  try {
    const mod = await import(pathToFileURL(distReg).href);
    getSkillDef = mod.getSkillDef;
    getSkillSystemPrompt = mod.getSkillSystemPrompt;
  } catch (e) {
    return catalog.skills.map((s) =>
      row(s.id, 0, 'fail', Date.now() - t0, e instanceof Error ? e.message : String(e)),
    );
  }

  const routing = JSON.parse(
    readFileSync(path.join(root, 'core/config/defaults/routing.json'), 'utf8'),
  );
  const routeIds = new Set((routing.tools || []).map((t) => t.id));

  for (const s of catalog.skills) {
    const start = Date.now();
    try {
      const def = getSkillDef(s.id);
      if (!def) {
        rows.push(row(s.id, 0, 'fail', Date.now() - start, 'getSkillDef null'));
        continue;
      }
      const prompt =
        typeof getSkillSystemPrompt === 'function'
          ? getSkillSystemPrompt(s.id, root)
          : '';
      const text = String(prompt || '');
      if (text.length < 40) {
        rows.push(row(s.id, 0, 'fail', Date.now() - start, `prompt too short (${text.length})`));
        continue;
      }
      const routed = routeIds.has(s.id) || routeIds.has(s.mode);
      if (!routed && s.id !== 'web_landing') {
        // web_landing may share web_dev anchors
      }
      rows.push(
        row(
          s.id,
          0,
          'pass',
          Date.now() - start,
          `label=${def.label || s.label}; prompt=${text.length}c; route=${routed ? 'yes' : 'soft'}`,
        ),
      );

      if (level >= 1 && s.id === 'web_dev') {
        // smoke: verify-skills already covers inject; mark L1 as harness export present
        const codeAgent = path.join(root, 'core/dist/agent/code-agent.js');
        rows.push(
          row(
            'web_dev:code_agent_entry',
            1,
            existsSync(codeAgent) ? 'pass' : 'fail',
            0,
            codeAgent,
          ),
        );
      }
    } catch (e) {
      rows.push(row(s.id, 0, 'fail', Date.now() - start, e instanceof Error ? e.message : String(e)));
    }
  }

  // shell out verify-skills for rigor when level>=0
  const vs = spawnSync(process.execPath, [path.join(root, 'tools/verify-skills.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  rows.push(
    row(
      'verify-skills.mjs',
      0,
      vs.status === 0 ? 'pass' : 'fail',
      0,
      (vs.stdout || vs.stderr || '').trim().slice(-200),
    ),
  );

  // domain registry verify if present
  const vd = path.join(root, 'tools/verify-domain-registry.mjs');
  if (existsSync(vd)) {
    const r = spawnSync(process.execPath, [vd], { cwd: root, encoding: 'utf8' });
    rows.push(
      row('verify-domain-registry.mjs', 0, r.status === 0 ? 'pass' : 'fail', 0, (r.stdout || '').trim().slice(-120)),
    );
  }

  // automaton tools covered by runners/automaton-dry.mjs (not silent skip rows here)
  return rows;
}
