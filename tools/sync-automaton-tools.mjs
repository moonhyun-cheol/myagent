#!/usr/bin/env node
/**
 * automaton-tools.manifest.json → routing.json automaton 항목 동기화
 * npm run sync:automaton-tools
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'core', 'config', 'defaults', 'automaton-tools.manifest.json');
const routingPath = path.join(root, 'core', 'config', 'defaults', 'routing.json');

const NON_AUTOMATON_IDS = new Set([
  'file_upload',
  'web_dev',
  'web_landing',
  'prompt_master',
  'browser_automation',
  'browser_agent',
  'web_crawl',
  'image_gen',
  'deep_research',
]);

function main() {
  if (!existsSync(manifestPath)) {
    console.error('manifest not found:', manifestPath);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const routing = existsSync(routingPath)
    ? JSON.parse(readFileSync(routingPath, 'utf8'))
    : { version: 1, tools: [] };

  const kept = (routing.tools ?? []).filter((t) => NON_AUTOMATON_IDS.has(t.id));
  const automatonEntries = (manifest.tools ?? []).map((t) => ({
    id: t.id,
    anchors_ko: [...new Set(t.anchors_ko ?? [])],
    anchors_en: [...new Set(t.anchors_en ?? [])],
  }));

  routing.version = Math.max(routing.version ?? 1, manifest.version ?? 1);
  routing.tools = [...kept, ...automatonEntries];

  writeFileSync(routingPath, `${JSON.stringify(routing, null, 2)}\n`, 'utf8');
  console.log(`sync-automaton-tools: ${automatonEntries.length} automaton tools → routing.json`);
}

main();
