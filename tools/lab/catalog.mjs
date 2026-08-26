/**
 * Skill/tool catalog — built from source of truth (definitions + manifests).
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function loadCatalog() {
  const distTools = path.join(root, 'core/dist/agent/agent-tool-definitions.js');
  if (!existsSync(distTools)) {
    throw new Error('build first: node tools/build.mjs');
  }
  const {
    CODE_AGENT_TOOLS,
    BROWSER_AGENT_TOOLS,
    CODE_AGENT_TOOL_NAMES,
  } = await import(pathToFileURL(distTools).href);

  const skillManifest = JSON.parse(
    readFileSync(path.join(root, 'core/config/defaults/skills/manifest.json'), 'utf8'),
  );
  const skills = Object.entries(skillManifest.skills || {}).map(([id, def]) => ({
    id,
    label: def.label,
    mode: def.mode,
    feature: def.feature,
    pipeline: Boolean(def.pipeline_script),
  }));

  let automaton = [];
  const autoPath = path.join(root, 'core/config/defaults/automaton-tools.manifest.json');
  if (existsSync(autoPath)) {
    const doc = JSON.parse(readFileSync(autoPath, 'utf8'));
    automaton = (doc.tools || []).map((t) => ({
      id: t.id,
      description: t.description_ko || t.id,
    }));
  }

  let domains = [];
  const domPath = path.join(root, 'core/config/defaults/domain-connectors.json');
  if (existsSync(domPath)) {
    const doc = JSON.parse(readFileSync(domPath, 'utf8'));
    const list = Array.isArray(doc.connectors) ? doc.connectors : Object.keys(doc.connectors || {});
    if (Array.isArray(doc.connectors) && doc.connectors[0]?.id) {
      domains = doc.connectors.map((c) => c.id);
    } else if (doc.connectors && typeof doc.connectors === 'object') {
      domains = Object.keys(doc.connectors);
    } else {
      domains = list;
    }
  }

  const codeTools = CODE_AGENT_TOOLS.map((t) => t.function.name);
  const browserTools = BROWSER_AGENT_TOOLS.map((t) => t.function.name);

  return {
    root,
    generated_at: new Date().toISOString(),
    code_tools: codeTools,
    browser_tools: browserTools,
    code_tool_names_export: CODE_AGENT_TOOL_NAMES,
    skills,
    automaton,
    domains,
    counts: {
      code_tools: codeTools.length,
      browser_tools: browserTools.length,
      skills: skills.length,
      automaton: automaton.length,
      domains: domains.length,
    },
  };
}
