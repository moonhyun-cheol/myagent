import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AutomatonToolManifestEntry {
  id: string;
  description_ko: string;
  slash_prefixes?: string[];
  anchors_ko?: string[];
  anchors_en?: string[];
  intent_phrases_ko?: string[];
  intent_boost_ko?: string[];
  intent_pattern_strings?: string[];
  intent_patterns?: RegExp[];
  intent_examples?: string[];
  default_command?: string;
  long_running?: boolean;
}

interface AutomatonToolsManifest {
  version: number;
  tools: AutomatonToolManifestEntry[];
}

let cached: AutomatonToolsManifest | null = null;

function manifestCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.join(here, '..', 'config', 'defaults', 'automaton-tools.manifest.json'),
    path.join(here, 'config', 'defaults', 'automaton-tools.manifest.json'),
  ];
}

export function loadAutomatonToolManifest(): AutomatonToolsManifest {
  if (cached) return cached;
  for (const p of manifestCandidates()) {
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as AutomatonToolsManifest;
      cached = {
        ...raw,
        tools: (raw.tools ?? []).map((tool) => ({
          ...tool,
          intent_patterns: (tool.intent_pattern_strings ?? []).map((pat) => new RegExp(pat, 'iu')),
        })),
      };
      return cached;
    }
  }
  cached = { version: 1, tools: [] };
  return cached;
}

export function listAutomatonTools(): AutomatonToolManifestEntry[] {
  return loadAutomatonToolManifest().tools;
}

export function getAutomatonToolEntry(id: string): AutomatonToolManifestEntry | null {
  return listAutomatonTools().find((t) => t.id === id) ?? null;
}

export function getAutomatonToolIds(): Set<string> {
  return new Set(listAutomatonTools().map((t) => t.id));
}

export function isAutomatonToolId(id: string | undefined): id is string {
  return Boolean(id && getAutomatonToolIds().has(id));
}

/** Explicit slash-command patterns; no natural-language intent inference. */
export function getSlashAutomatonPatterns(): { pattern: RegExp; toolId: string }[] {
  const out: { pattern: RegExp; toolId: string }[] = [];
  for (const tool of listAutomatonTools()) {
    for (const prefix of tool.slash_prefixes ?? []) {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out.push({
        pattern: new RegExp(`^${escaped}(?:\\s|$)`, 'i'),
        toolId: tool.id,
      });
    }
  }
  return out;
}

export function buildAutomatonCommandText(toolId: string, userMessage: string): string {
  const entry = getAutomatonToolEntry(toolId);
  const text = userMessage.trim();
  if (!entry) return text;
  const defaultCmd = entry.default_command?.trim() ?? '';
  if (!text) return defaultCmd;
  if (text.startsWith('/')) return text;
  for (const prefix of entry.slash_prefixes ?? []) {
    if (text.toLowerCase().startsWith(prefix.toLowerCase())) return text;
  }
  if (defaultCmd) return `${defaultCmd} ${text}`.trim();
  return text;
}
