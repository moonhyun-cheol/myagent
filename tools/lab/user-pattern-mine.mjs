#!/usr/bin/env node
/**
 * Mine Cursor transcripts + CQR sessions → pattern report.
 * Catalog (curated ≥50) is separate: user-pattern-catalog.mjs
 *
 *   node tools/lab/user-pattern-mine.mjs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATTERNS, CHAINS, PATTERN_META } from './user-pattern-catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'data', '_skill_tool_lab');
mkdirSync(outDir, { recursive: true });

function push(items, text, source) {
  const t = String(text || '').trim();
  if (t.length < 8 || t.length > 2000) return;
  if (/^TOOL_CALL\b/i.test(t)) return;
  if (/<timestamp>/i.test(t) && /<user_query>/i.test(t)) {
    const m = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
    if (m) {
      items.push({ text: m[1].trim().slice(0, 800), source });
      return;
    }
  }
  items.push({ text: t.slice(0, 800), source });
}

function harvestSessions() {
  const dir = path.join(root, 'data', 'sessions');
  const items = [];
  if (!existsSync(dir)) return items;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      for (const m of j.messages || []) {
        if (m.role === 'user' && m.content) push(items, m.content, `session/${f}`);
      }
    } catch {
      /* ignore */
    }
  }
  return items;
}

function harvestCursorFile() {
  const p = path.join(outDir, 'cursor-query-harvest.json');
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return (j.items || []).map((it) => ({ text: it.text, source: it.source || 'cursor' }));
  } catch {
    return [];
  }
}

function familyOf(text) {
  const s = text.toLowerCase();
  if (/github\.com|git\s*clone|이\s*깃|공개\s*저장소|repo/.test(s)) return 'remote_repo';
  if (/\\\\|nas\\|unc|양식|엑셀/.test(s)) return 'live_fs';
  if (/시장조사|시즌|경쟁|트렌드/.test(s)) return 'market';
  if (/브랜드|컨셉|concept/.test(s)) return 'brand';
  if (/이미지|배너|로고|image/.test(s)) return 'image';
  if (/chatpane|ui\/workspace|입력창/.test(s)) return 'ui_mutate';
  if (/만들|구현|고쳐|수정해|패치|버그/.test(s)) return 'code_mutate';
  if (/이어서|ㅇㅇ|승인|진행|타당성|다음\s*조치/.test(s)) return 'secretary';
  if (/루프|백테스트|검증|확인해|스모크/.test(s)) return 'verify';
  if (/스킬|플러그인|배포|publish|delta|팩/.test(s)) return 'ops';
  if (/openclaw|automaton|디스코드/.test(s)) return 'automaton';
  if (/미국샘플|재고|astock/.test(s)) return 'domain';
  if (/계획\s*먼저|계획해/.test(s)) return 'plan';
  if (/브라우저|크롤|스크린샷/.test(s)) return 'browser';
  if (/설명|개요|구조|뭐야/.test(s)) return 'explain';
  return 'other';
}

function main() {
  const raw = [...harvestCursorFile(), ...harvestSessions()];
  const seen = new Set();
  const uniq = [];
  for (const it of raw) {
    const k = it.text.replace(/\s+/g, ' ').slice(0, 140);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push({ ...it, family: familyOf(it.text) });
  }

  const byFamily = {};
  for (const u of uniq) {
    byFamily[u.family] = byFamily[u.family] || [];
    byFamily[u.family].push(u);
  }

  const catalogFamilies = {};
  for (const p of PATTERNS) {
    catalogFamilies[p.family] = (catalogFamilies[p.family] || 0) + 1;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    meta: PATTERN_META,
    harvestedUnique: uniq.length,
    catalogCount: PATTERNS.length,
    chainCount: CHAINS.length,
    harvestByFamily: Object.fromEntries(
      Object.entries(byFamily).map(([k, v]) => [k, v.length]),
    ),
    catalogByFamily: catalogFamilies,
    samplePerFamily: Object.fromEntries(
      Object.entries(byFamily).map(([k, v]) => [
        k,
        v.slice(0, 5).map((x) => x.text.slice(0, 160)),
      ]),
    ),
    catalogIds: PATTERNS.map((p) => p.id),
  };

  const jsonPath = path.join(outDir, 'user-pattern-mine.json');
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const md = [
    '# User question pattern mine',
    '',
    `Generated: ${payload.generatedAt}`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Harvest unique | ${payload.harvestedUnique} |`,
    `| Curated catalog | **${payload.catalogCount}** |`,
    `| Multi-turn chains | ${payload.chainCount} |`,
    '',
    '## Catalog by family',
    '',
    ...Object.entries(catalogFamilies)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `- \`${k}\`: ${n}`),
    '',
    '## Harvest family mix',
    '',
    ...Object.entries(payload.harvestByFamily)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `- \`${k}\`: ${n}`),
    '',
    '## Chains',
    '',
    ...CHAINS.map((c) => `- **${c.id}**: ${c.title} (${c.steps.length} steps)`),
    '',
    'Run offline/live: `npm run lab:pattern-chain`',
    '',
  ];
  const mdPath = path.join(outDir, 'user-pattern-mine-report.md');
  writeFileSync(mdPath, `${md.join('\n')}\n`, 'utf8');
  console.log(md.join('\n'));
  console.log(`\n→ ${jsonPath}`);
  if (PATTERNS.length < 50) {
    console.error(`FAIL: catalog has ${PATTERNS.length} < 50`);
    process.exit(1);
  }
}

main();
