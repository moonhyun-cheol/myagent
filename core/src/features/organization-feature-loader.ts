/**
 * Load Automaton entrypoints from enabled Organization Features (+ legacy org module).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { OrganizationAutomatonToolEntry } from '../automaton/organization-automaton-manifest.js';
import type { AdapterConnectionDoc } from '../automaton/adapter-connection.js';
import type { OpenClawWorkflowPayload } from '../automaton/openclaw-workflow-map.js';
import {
  listEnabledOrganizationFeatureRoots,
  readEnabledFeatureJson,
  listOrganizationFeatures,
} from './organization-feature-manager.js';
import type { OrganizationFeatureJson } from './organization-feature-types.js';

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function resolveEntrypoint(featureRoot: string, relative: string | undefined, fallbacks: string[]): string | null {
  const candidates = [
    ...(relative ? [relative] : []),
    ...fallbacks,
  ];
  for (const cand of candidates) {
    if (!cand?.trim()) continue;
    const abs = path.join(featureRoot, ...cand.replaceAll('\\', '/').split('/'));
    if (existsSync(abs)) return abs;
  }
  return null;
}

export function loadFeatureAutomatonTools(cqrRoot: string): OrganizationAutomatonToolEntry[] {
  const out: OrganizationAutomatonToolEntry[] = [];
  for (const status of listOrganizationFeatures(cqrRoot)) {
    if (!status.enabled || !status.root) continue;
    const featureJson = readEnabledFeatureJson(cqrRoot, status.id);
    const manifestPath = resolveEntrypoint(
      status.root,
      featureJson?.entrypoints?.automaton_tools_manifest,
      ['automaton-tools.manifest.json'],
    );
    if (!manifestPath) continue;
    const raw = readJsonFile<{ tools?: OrganizationAutomatonToolEntry[] }>(manifestPath);
    for (const tool of raw?.tools ?? []) {
      if (tool?.id) out.push(tool);
    }
  }
  return out;
}

export function loadFeatureOpenClawWorkflows(cqrRoot: string): Record<string, OpenClawWorkflowPayload> {
  const merged: Record<string, OpenClawWorkflowPayload> = {};
  for (const status of listOrganizationFeatures(cqrRoot)) {
    if (!status.enabled || !status.root) continue;
    const featureJson = readEnabledFeatureJson(cqrRoot, status.id);
    const mapPath = resolveEntrypoint(
      status.root,
      featureJson?.entrypoints?.openclaw_workflow_map,
      ['openclaw-workflow-map.json'],
    );
    if (!mapPath) continue;
    const raw = readJsonFile<{ workflows?: Record<string, OpenClawWorkflowPayload> }>(mapPath);
    Object.assign(merged, raw?.workflows ?? {});
  }
  return merged;
}

/** Prefer an enabled feature adapter connection; caller falls back to org module. */
export function resolveFeatureAdapterConnectionPath(cqrRoot: string): string | null {
  for (const status of listOrganizationFeatures(cqrRoot)) {
    if (!status.enabled || !status.root) continue;
    const featureJson = readEnabledFeatureJson(cqrRoot, status.id);
    const filePath = resolveEntrypoint(
      status.root,
      featureJson?.entrypoints?.adapter_connection,
      ['adapter-connection.json', 'adapter-connection.template.json'],
    );
    if (filePath) return filePath;
  }
  return null;
}

export function loadFeatureAdapterConnection(cqrRoot: string): AdapterConnectionDoc | null {
  const filePath = resolveFeatureAdapterConnectionPath(cqrRoot);
  if (!filePath) return null;
  return readJsonFile<AdapterConnectionDoc>(filePath);
}

export function listEnabledFeatureDocuments(cqrRoot: string): OrganizationFeatureJson[] {
  const out: OrganizationFeatureJson[] = [];
  for (const root of listEnabledOrganizationFeatureRoots(cqrRoot)) {
    const doc = readJsonFile<OrganizationFeatureJson>(path.join(root, 'feature.json'));
    if (doc) out.push(doc);
  }
  return out;
}
