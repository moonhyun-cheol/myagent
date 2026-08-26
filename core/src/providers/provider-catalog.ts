import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderCatalogFile, ProviderDefinition } from './types.js';

function defaultsPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', '..', 'config', 'defaults', 'providers.json'),
    path.join(here, '..', 'config', 'defaults', 'providers.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error('PROVIDERS_CATALOG_MISSING');
}

export function loadProviderCatalog(): ProviderDefinition[] {
  const raw = readFileSync(defaultsPath(), 'utf8');
  const doc = JSON.parse(raw) as ProviderCatalogFile;
  return doc.providers ?? [];
}

export function getProviderDef(catalog: ProviderDefinition[], id: string): ProviderDefinition | undefined {
  return catalog.find((p) => p.id === id);
}
