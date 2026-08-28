import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveOrganizationModuleRoot } from '../skills/organization-module-root.js';

export interface OrganizationAutomatonToolEntry {
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

interface AutomatonToolsManifestDoc {
  version?: number;
  tools?: OrganizationAutomatonToolEntry[];
}

function normalizeToolEntry(tool: OrganizationAutomatonToolEntry): OrganizationAutomatonToolEntry {
  return {
    ...tool,
    intent_patterns: (tool.intent_pattern_strings ?? []).map((pat) => new RegExp(pat, 'iu')),
  };
}

export function loadOrganizationAutomatonTools(cqrRoot: string): OrganizationAutomatonToolEntry[] {
  const orgRoot = resolveOrganizationModuleRoot(cqrRoot);
  if (!orgRoot) return [];
  const manifestPath = path.join(orgRoot, 'automaton-tools.manifest.json');
  if (!existsSync(manifestPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as AutomatonToolsManifestDoc;
    return (raw.tools ?? []).map(normalizeToolEntry);
  } catch {
    return [];
  }
}
