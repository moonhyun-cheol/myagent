import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrganizationAutomatonTools } from './organization-automaton-manifest.js';

export type AutomatonResponseProfile = 'auto' | 'text' | 'quantity' | 'files' | 'status' | 'discord';
export type AutomatonFallbackProfile = Exclude<AutomatonResponseProfile, 'discord'>;

export interface AutomatonAckContract {
  enabled?: boolean;
  /** Stable command id shown in the ACK. Defaults to the manifest tool id. */
  command_id?: string;
  /** Shown only for comma batches. */
  batch_time_hint?: string;
}

export interface AutomatonBatchContract {
  supported: boolean;
  label_ko?: string;
  /** null means unlimited. */
  cap?: number | null;
}

export interface AutomatonResponseContract {
  /** Reusable renderer selected by manifest authors; no command-specific formatter is required. */
  profile: AutomatonResponseProfile;
  /** Discord SoT template identity. The service payload.message remains authoritative. */
  template_id?: string;
  /** Safe legacy renderer used only when an authoritative Discord message is absent. */
  fallback_profile?: AutomatonFallbackProfile;
  /** Dot paths are resolved from the deep business result first (for example qty or form_fields.SKU). */
  fields?: string[];
  /** Optional concise success label; defaults to description_ko. */
  label_ko?: string;
  /** File profile allowlist. Extensions are lowercase and include the leading dot. */
  allowed_extensions?: string[];
  ack?: AutomatonAckContract;
  batch?: AutomatonBatchContract;
}

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
  response?: AutomatonResponseContract;
}

interface AutomatonToolsManifest {
  version: number;
  tools: AutomatonToolManifestEntry[];
}

let cachedKey: string | null = null;
let cached: AutomatonToolsManifest | null = null;

function normalizeToolEntry(tool: AutomatonToolManifestEntry): AutomatonToolManifestEntry {
  return {
    ...tool,
    intent_patterns: (tool.intent_pattern_strings ?? []).map((pat) => new RegExp(pat, 'iu')),
  };
}

function readCoreAutomatonTools(): AutomatonToolManifestEntry[] {
  for (const p of manifestCandidates()) {
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as AutomatonToolsManifest;
      return (raw.tools ?? []).map(normalizeToolEntry);
    }
  }
  return [];
}

function mergeAutomatonTools(
  coreTools: AutomatonToolManifestEntry[],
  orgTools: AutomatonToolManifestEntry[],
): AutomatonToolManifestEntry[] {
  const merged = new Map<string, AutomatonToolManifestEntry>();
  for (const tool of coreTools) merged.set(tool.id, tool);
  for (const tool of orgTools) merged.set(tool.id, tool);
  return [...merged.values()];
}

export function resetAutomatonToolManifestCache(): void {
  cachedKey = null;
  cached = null;
}

export function loadAutomatonToolManifest(cqrRoot?: string): AutomatonToolsManifest {
  const key = cqrRoot?.trim() || '';
  if (cached && cachedKey === key) return cached;
  const coreTools = readCoreAutomatonTools();
  const orgTools = loadOrganizationAutomatonTools(key);
  cachedKey = key;
  cached = {
    version: 3,
    tools: mergeAutomatonTools(coreTools, orgTools),
  };
  return cached;
}

function manifestCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.join(here, '..', 'config', 'defaults', 'automaton-tools.manifest.json'),
    path.join(here, 'config', 'defaults', 'automaton-tools.manifest.json'),
  ];
}

export function listAutomatonTools(cqrRoot?: string): AutomatonToolManifestEntry[] {
  return loadAutomatonToolManifest(cqrRoot).tools;
}

export function getAutomatonToolEntry(id: string, cqrRoot?: string): AutomatonToolManifestEntry | null {
  return listAutomatonTools(cqrRoot).find((t) => t.id === id) ?? null;
}

export function getAutomatonToolIds(cqrRoot?: string): Set<string> {
  return new Set(listAutomatonTools(cqrRoot).map((t) => t.id));
}

export function isAutomatonToolId(id: string | undefined, cqrRoot?: string): id is string {
  return Boolean(id && getAutomatonToolIds(cqrRoot).has(id));
}

/** Explicit slash-command patterns; no natural-language intent inference. */
export function getSlashAutomatonPatterns(cqrRoot?: string): { pattern: RegExp; toolId: string }[] {
  const out: { pattern: RegExp; toolId: string }[] = [];
  for (const tool of listAutomatonTools(cqrRoot)) {
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

export function buildAutomatonCommandText(toolId: string, userMessage: string, cqrRoot?: string): string {
  const entry = getAutomatonToolEntry(toolId, cqrRoot);
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
