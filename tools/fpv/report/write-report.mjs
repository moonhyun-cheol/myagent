#!/usr/bin/env node
/** Write report-<ts>/ dashboard artifacts from layer + oracle outputs. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { OUT_DIR } from '../lib/paths.mjs';

function read(name) {
  const p = path.join(OUT_DIR, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeFpvReport(oracle) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(OUT_DIR, `report-${ts}`);
  mkdirSync(dir, { recursive: true });

  const nodes = oracle?.nodes || [];
  const color = (tag) => {
    if (tag === 'green') return '#16a34a';
    if (tag === 'red') return '#dc2626';
    if (tag === 'env-red') return '#ca8a04';
    if (tag === 'explicit_skip') return '#94a3b8';
    return '#334155';
  };

  // simple SVG graph
  const cols = 4;
  const w = 220;
  const h = 56;
  const pad = 16;
  const svgNodes = nodes
    .map((n, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = pad + col * (w + pad);
      const y = pad + row * (h + pad);
      return `<g>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${color(n.tag)}" opacity="0.9"/>
  <text x="${x + 10}" y="${y + 24}" fill="#fff" font-size="12" font-family="Segoe UI,sans-serif">${n.id}</text>
  <text x="${x + 10}" y="${y + 42}" fill="#f8fafc" font-size="11" font-family="Segoe UI,sans-serif">${n.tag}</text>
</g>`;
    })
    .join('\n');
  const rows = Math.ceil(nodes.length / cols) || 1;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${pad + cols * (w + pad)}" height="${pad + rows * (h + pad)}" viewBox="0 0 ${pad + cols * (w + pad)} ${pad + rows * (h + pad)}">
  <rect width="100%" height="100%" fill="#0f172a"/>
  ${svgNodes}
</svg>
`;
  writeFileSync(path.join(dir, 'graph.svg'), svg);

  writeFileSync(path.join(dir, 'oracle.json'), `${JSON.stringify(oracle, null, 2)}\n`);
  writeFileSync(
    path.join(dir, 'journeys.json'),
    `${JSON.stringify(
      {
        L4: read('l4-journeys.json'),
        market: read('journey-market-process.json'),
        local_docs: read('journey-J_local_docs.json'),
        mutate: read('journey-J_mutate_verify.json'),
        deploy: read('journey-J_deploy.json'),
      },
      null,
      2,
    )}\n`,
  );

  const gapsMd = [
    '# FPV Gaps',
    '',
    `Generated: ${oracle?.generatedAt || new Date().toISOString()}`,
    '',
    `Dark: ${oracle?.counts?.dark ?? 0} · Red: ${oracle?.counts?.red ?? 0} · Env-red: ${oracle?.counts?.envRed ?? 0}`,
    '',
    ...(oracle?.gaps || []).map(
      (g) => `- **${g.id}** (${g.tag}): ${g.ticket}${g.note ? ` — _${g.note}_` : ''}`,
    ),
    '',
    '## Tickets',
    '',
    ...(oracle?.gaps || []).map((g, i) => `${i + 1}. ${g.ticket}`),
    '',
  ];
  writeFileSync(path.join(dir, 'gaps.md'), gapsMd.join('\n'));

  const honest = oracle?.scoreHonest || read('score-honest.json');
  writeFileSync(path.join(dir, 'score-honest.json'), `${JSON.stringify(honest, null, 2)}\n`);

  // also copy latest pointers
  for (const name of [
    'l0.json',
    'l1-http.json',
    'l2-planes.json',
    'l3-shell-ui.json',
    'l4-journeys.json',
    'oracle.json',
    'score-honest.json',
  ]) {
    const src = path.join(OUT_DIR, name);
    if (existsSync(src)) copyFileSync(src, path.join(dir, name));
  }

  const summary = [
    '# FPV Report',
    '',
    `Dir: \`${dir}\``,
    `OK: **${oracle?.ok}**`,
    `Nodes: green=${oracle?.counts?.green} red=${oracle?.counts?.red} env-red=${oracle?.counts?.envRed} skip=${oracle?.counts?.explicit_skip} dark=${oracle?.counts?.dark}`,
    '',
    `Headline policy: **honest-v1**`,
    honest?.productMean != null ? `Honest productMean: **${honest.productMean}**` : '',
    honest?.mean != null ? `Honest mean: **${honest.mean}**` : '',
    honest?.allPass != null ? `Honest allPass: **${honest.allPass}**` : '',
    '',
    'See `gaps.md` for unproven / red capabilities.',
    '',
  ]
    .filter(Boolean)
    .join('\n');
  writeFileSync(path.join(dir, 'README.md'), summary);
  writeFileSync(path.join(OUT_DIR, 'LATEST_REPORT.txt'), `${dir}\n`);
  return dir;
}

if (process.argv[1]?.endsWith('write-report.mjs')) {
  const oracle = read('oracle.json') || { nodes: [], counts: {}, gaps: [], ok: false };
  const dir = writeFpvReport(oracle);
  console.log(dir);
}
