#!/usr/bin/env node
/**
 * skills/manifest.json → routing.json 스킬 항목 동기화
 * - manifest에 있는 스킬 id가 routing.json에 없으면 생성
 * - label을 anchors_ko 앞에 병합 (중복 제거)
 * - automaton·비스킬 항목은 그대로 유지
 * npm run sync:skill-routing
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'core', 'config', 'defaults', 'skills', 'manifest.json');
const routingPath = path.join(root, 'core', 'config', 'defaults', 'routing.json');
const automatonManifestPath = path.join(root, 'core', 'config', 'defaults', 'automaton-tools.manifest.json');

function loadAutomatonIds() {
  if (!existsSync(automatonManifestPath)) return new Set();
  const doc = JSON.parse(readFileSync(automatonManifestPath, 'utf8'));
  return new Set((doc.tools ?? []).map((t) => t.id));
}

function dedupe(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const v = String(raw ?? '').trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

const WEAK_ANCHOR_RE = /^(?:cqr|ra|ai|ui|html|css|js)$/i;

function mergeAnchors(label, existing = [], extra = []) {
  const seeds = [];
  if (label) seeds.push(label);
  for (const part of String(label).split(/\s+/)) {
    if (part.length < 3) continue;
    if (WEAK_ANCHOR_RE.test(part)) continue;
    seeds.push(part);
  }
  const cleanedExisting = (existing ?? []).filter((a) => !WEAK_ANCHOR_RE.test(String(a)));
  return dedupe([...seeds, ...extra, ...cleanedExisting]);
}

function main() {
  if (!existsSync(manifestPath)) {
    console.error('skills manifest not found:', manifestPath);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const skills = manifest.skills ?? {};
  const skillIds = new Set(Object.keys(skills));
  const automatonIds = loadAutomatonIds();

  const routing = existsSync(routingPath)
    ? JSON.parse(readFileSync(routingPath, 'utf8'))
    : { version: 1, tools: [] };

  const byId = new Map((routing.tools ?? []).map((t) => [t.id, t]));
  let created = 0;
  let updated = 0;

  for (const [id, def] of Object.entries(skills)) {
    const label = def.label?.trim() || id;
    const mode = def.mode?.trim() || id;
    const existing = byId.get(id);
    const anchors_ko = mergeAnchors(label, existing?.anchors_ko ?? [], def.routing_anchors_ko ?? []);
    const anchors_en = dedupe([
      ...(def.routing_anchors_en ?? []),
      ...(existing?.anchors_en ?? []),
      ...(mode !== id ? [mode] : []),
    ]);

    if (!existing) {
      byId.set(id, { id, anchors_ko, anchors_en });
      created += 1;
      continue;
    }

    const koSame =
      JSON.stringify(existing.anchors_ko ?? []) === JSON.stringify(anchors_ko);
    const enSame =
      JSON.stringify(existing.anchors_en ?? []) === JSON.stringify(anchors_en);
    if (!koSame || !enSame) {
      byId.set(id, { ...existing, id, anchors_ko, anchors_en });
      updated += 1;
    }
  }

  const staticNonSkill = new Set([
    'file_upload',
    'browser_automation',
    'browser_agent',
    'web_crawl',
    'image_gen',
    'deep_research',
  ]);
  const ordered = [];
  const placed = new Set();

  for (const t of routing.tools ?? []) {
    if (skillIds.has(t.id) || staticNonSkill.has(t.id) || automatonIds.has(t.id)) {
      ordered.push(byId.get(t.id) ?? t);
      placed.add(t.id);
    }
  }

  for (const id of skillIds) {
    if (!placed.has(id) && byId.has(id)) {
      ordered.push(byId.get(id));
      placed.add(id);
    }
  }

  routing.tools = ordered;
  routing.version = Math.max(routing.version ?? 1, manifest.version ?? 1);

  writeFileSync(routingPath, `${JSON.stringify(routing, null, 2)}\n`, 'utf8');
  console.log(
    `sync-skill-routing: ${Object.keys(skills).length} skills, ${created} created, ${updated} updated → routing.json`,
  );
}

main();
