/**
 * Local agent plugins: data/agent-plugins/{id}/tool.json + run entry.
 * Survives delta updates (data/ preserved).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  appendFileSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import type { AgentToolDefinition } from './agent-tool-types.js';
import {
  assertPluginToolNameAllowed,
  isValidPluginId,
} from './agent-plugin-reserved.js';
import { buildPurposeAwareScaffold } from './agent-plugin-scaffold.js';

export type AgentPluginRisk = 'read' | 'write' | 'network';
export type AgentPluginRunnerKind = 'node' | 'powershell';

export interface AgentPluginRunnerMeta {
  kind: AgentPluginRunnerKind;
  entry: string;
  timeout_ms?: number;
}

export interface AgentPluginManifest {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  runner: AgentPluginRunnerMeta;
  risk: AgentPluginRisk;
  enabled?: boolean;
  created_by?: 'agent' | 'user';
  created_at?: string;
  updated_at?: string;
}

export interface AgentPluginRecord {
  id: string;
  dir: string;
  manifest: AgentPluginManifest;
  enabled: boolean;
}

interface PluginIndex {
  version: number;
  plugins: Array<{ id: string; enabled: boolean }>;
}

const cacheByRoot = new Map<string, AgentPluginRecord[]>();

export function pluginsRoot(cqrRoot: string): string {
  return path.join(path.resolve(cqrRoot), 'data', 'agent-plugins');
}

export function invalidateAgentPluginCache(cqrRoot?: string): void {
  if (cqrRoot) {
    cacheByRoot.delete(path.resolve(cqrRoot));
  } else {
    cacheByRoot.clear();
  }
}

function ensurePluginsDir(cqrRoot: string): string {
  const root = pluginsRoot(cqrRoot);
  mkdirSync(root, { recursive: true });
  const indexPath = path.join(root, 'index.json');
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, `${JSON.stringify({ version: 1, plugins: [] }, null, 2)}\n`, 'utf8');
  }
  return root;
}

function loadIndex(cqrRoot: string): PluginIndex {
  const root = ensurePluginsDir(cqrRoot);
  const indexPath = path.join(root, 'index.json');
  try {
    const raw = JSON.parse(readFileSync(indexPath, 'utf8')) as PluginIndex;
    if (!raw || typeof raw !== 'object') return { version: 1, plugins: [] };
    return {
      version: Number(raw.version) || 1,
      plugins: Array.isArray(raw.plugins) ? raw.plugins : [],
    };
  } catch {
    return { version: 1, plugins: [] };
  }
}

function saveIndex(cqrRoot: string, index: PluginIndex): void {
  const root = ensurePluginsDir(cqrRoot);
  writeFileSync(
    path.join(root, 'index.json'),
    `${JSON.stringify({ version: 1, plugins: index.plugins }, null, 2)}\n`,
    'utf8',
  );
}

function appendAudit(cqrRoot: string, event: Record<string, unknown>): void {
  try {
    const logsDir = path.join(path.resolve(cqrRoot), 'data', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    appendFileSync(path.join(logsDir, 'agent-plugin.jsonl'), `${line}\n`, 'utf8');
  } catch {
    /* non-fatal */
  }
}

function assertSafeEntry(entry: string): string | null {
  const e = entry.trim().replace(/\\/g, '/');
  if (!e || e.includes('..') || path.isAbsolute(e) || e.startsWith('/')) {
    return 'runner.entry must be a relative path inside the plugin dir (no ..)';
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(e.split('/').join(''))) {
    // allow simple nested? plan says run.mjs | run.ps1 at top preferably
  }
  if (e.includes('/') || e.includes('\\')) {
    return 'runner.entry must be a single filename (e.g. run.mjs)';
  }
  if (!/\.(mjs|js|ps1)$/i.test(e)) {
    return 'runner.entry must end with .mjs, .js, or .ps1';
  }
  return null;
}

export function validatePluginManifest(
  manifest: Partial<AgentPluginManifest>,
): { ok: true; manifest: AgentPluginManifest } | { ok: false; error: string } {
  const name = String(manifest.name ?? '').trim();
  const nameErr = assertPluginToolNameAllowed(name);
  if (nameErr) return { ok: false, error: nameErr };

  const description = String(manifest.description ?? '').trim();
  if (!description || description.length > 2000) {
    return { ok: false, error: 'description required (1–2000 chars)' };
  }

  const risk = manifest.risk;
  if (risk !== 'read' && risk !== 'write' && risk !== 'network') {
    return { ok: false, error: 'risk must be read | write | network' };
  }

  const runner = manifest.runner;
  if (!runner || typeof runner !== 'object') {
    return { ok: false, error: 'runner is required' };
  }
  if (runner.kind !== 'node' && runner.kind !== 'powershell') {
    return { ok: false, error: 'runner.kind must be node | powershell' };
  }
  const entryErr = assertSafeEntry(String(runner.entry ?? ''));
  if (entryErr) return { ok: false, error: entryErr };

  const timeout = runner.timeout_ms != null ? Number(runner.timeout_ms) : 60_000;
  if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 300_000) {
    return { ok: false, error: 'runner.timeout_ms must be 1000–300000' };
  }

  const parameters =
    manifest.parameters && typeof manifest.parameters === 'object'
      ? (manifest.parameters as Record<string, unknown>)
      : { type: 'object', properties: {} };

  return {
    ok: true,
    manifest: {
      name,
      description,
      parameters,
      runner: {
        kind: runner.kind,
        entry: String(runner.entry).trim(),
        timeout_ms: timeout,
      },
      risk,
      enabled: manifest.enabled !== false,
      created_by: manifest.created_by === 'user' ? 'user' : 'agent',
      created_at: manifest.created_at,
      updated_at: manifest.updated_at,
    },
  };
}

function readManifestFromDir(dir: string): AgentPluginManifest | null {
  const p = path.join(dir, 'tool.json');
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<AgentPluginManifest>;
    const v = validatePluginManifest(raw);
    if (!v.ok) return null;
    return v.manifest;
  } catch {
    return null;
  }
}

export function listAgentPlugins(cqrRoot: string, opts?: { useCache?: boolean }): AgentPluginRecord[] {
  const key = path.resolve(cqrRoot);
  if (opts?.useCache !== false && cacheByRoot.has(key)) {
    return cacheByRoot.get(key)!;
  }

  const root = ensurePluginsDir(cqrRoot);
  const index = loadIndex(cqrRoot);
  const enabledMap = new Map(index.plugins.map((p) => [p.id, p.enabled !== false]));
  const records: AgentPluginRecord[] = [];

  let ids = index.plugins.map((p) => p.id);
  // Also discover folders not yet in index (orphan install recovery)
  try {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      if (!isValidPluginId(ent.name)) continue;
      if (!ids.includes(ent.name)) ids.push(ent.name);
    }
  } catch {
    /* empty */
  }

  for (const id of ids) {
    if (!isValidPluginId(id)) continue;
    const dir = path.join(root, id);
    const manifest = readManifestFromDir(dir);
    if (!manifest) continue;
    const enabled =
      enabledMap.has(id) ? enabledMap.get(id)! : manifest.enabled !== false;
    records.push({ id, dir, manifest: { ...manifest, enabled }, enabled });
  }

  cacheByRoot.set(key, records);
  return records;
}

export function getAgentPluginByToolName(
  cqrRoot: string,
  toolName: string,
): AgentPluginRecord | null {
  const n = toolName.trim();
  // Always re-read: multi-install same session + distinct module graphs can leave cache stale.
  return (
    listAgentPlugins(cqrRoot, { useCache: false }).find(
      (p) => p.enabled && p.manifest.name === n,
    ) ?? null
  );
}

export function listEnabledPluginToolDefinitions(cqrRoot: string): AgentToolDefinition[] {
  return listAgentPlugins(cqrRoot, { useCache: false })
    .filter((p) => p.enabled)
    .map((p) => ({
      type: 'function' as const,
      function: {
        name: p.manifest.name,
        description: `[plugin:${p.id}] ${p.manifest.description}`,
        parameters: p.manifest.parameters,
      },
    }));
}

export function installAgentPlugin(
  cqrRoot: string,
  input: {
    id: string;
    confirm?: boolean;
    tool_json?: string | Record<string, unknown>;
    run_source?: string;
    created_by?: 'agent' | 'user';
  },
): string {
  if (input.confirm !== true) {
    return JSON.stringify(
      {
        ok: false,
        error: 'plugin_install requires confirm=true after summarizing the tool to the user',
      },
      null,
      2,
    );
  }

  const id = String(input.id ?? '').trim();
  if (!isValidPluginId(id)) {
    return JSON.stringify(
      {
        ok: false,
        error: 'plugin id must match [a-z0-9_]{1,40}',
      },
      null,
      2,
    );
  }

  let rawManifest: Partial<AgentPluginManifest>;
  try {
    rawManifest =
      typeof input.tool_json === 'string'
        ? (JSON.parse(input.tool_json) as Partial<AgentPluginManifest>)
        : (input.tool_json as Partial<AgentPluginManifest>);
  } catch (e: unknown) {
    return JSON.stringify(
      {
        ok: false,
        error: `invalid tool_json: ${e instanceof Error ? e.message : String(e)}`,
      },
      null,
      2,
    );
  }

  const now = new Date().toISOString();
  const validated = validatePluginManifest({
    ...rawManifest,
    created_by: input.created_by ?? rawManifest.created_by ?? 'agent',
    created_at: rawManifest.created_at ?? now,
    updated_at: now,
    enabled: true,
  });
  if (!validated.ok) {
    appendAudit(cqrRoot, { event: 'install_deny', id, error: validated.error });
    return JSON.stringify({ ok: false, error: validated.error }, null, 2);
  }

  const runSource = String(input.run_source ?? '');
  if (!runSource.trim()) {
    return JSON.stringify({ ok: false, error: 'run_source is required (script body)' }, null, 2);
  }
  if (runSource.length > 200_000) {
    return JSON.stringify({ ok: false, error: 'run_source too large' }, null, 2);
  }

  // Name uniqueness among plugins
  const existing = listAgentPlugins(cqrRoot, { useCache: false });
  if (
    existing.some((p) => p.manifest.name === validated.manifest.name && p.id !== id)
  ) {
    return JSON.stringify(
      {
        ok: false,
        error: `tool name already registered by another plugin: ${validated.manifest.name}`,
      },
      null,
      2,
    );
  }

  const root = ensurePluginsDir(cqrRoot);
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'tool.json'),
    `${JSON.stringify(validated.manifest, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(path.join(dir, validated.manifest.runner.entry), runSource, 'utf8');

  const index = loadIndex(cqrRoot);
  const without = index.plugins.filter((p) => p.id !== id);
  without.push({ id, enabled: true });
  saveIndex(cqrRoot, { version: 1, plugins: without });
  invalidateAgentPluginCache(cqrRoot);

  appendAudit(cqrRoot, {
    event: 'install',
    id,
    name: validated.manifest.name,
    risk: validated.manifest.risk,
  });

  return JSON.stringify(
    {
      ok: true,
      id,
      name: validated.manifest.name,
      dir: path.relative(path.resolve(cqrRoot), dir).replace(/\\/g, '/'),
      risk: validated.manifest.risk,
      note: 'Plugin installed. REQUIRED next tool step: call this tool by name (confirm=true if risk is write/network). Do not only narrate the call.',
      next_tool: validated.manifest.name,
    },
    null,
    2,
  );
}

export function setAgentPluginEnabled(
  cqrRoot: string,
  input: { id: string; enabled: boolean; confirm?: boolean },
): string {
  if (input.confirm !== true) {
    return JSON.stringify(
      { ok: false, error: 'plugin_set_enabled requires confirm=true' },
      null,
      2,
    );
  }
  const id = String(input.id ?? '').trim();
  if (!isValidPluginId(id)) {
    return JSON.stringify({ ok: false, error: 'invalid plugin id' }, null, 2);
  }
  const records = listAgentPlugins(cqrRoot, { useCache: false });
  if (!records.some((p) => p.id === id)) {
    return JSON.stringify({ ok: false, error: `plugin not found: ${id}` }, null, 2);
  }
  const index = loadIndex(cqrRoot);
  const plugins = index.plugins.filter((p) => p.id !== id);
  plugins.push({ id, enabled: input.enabled === true });
  // keep others from records if missing
  for (const r of records) {
    if (!plugins.some((p) => p.id === r.id)) {
      plugins.push({ id: r.id, enabled: r.id === id ? input.enabled : r.enabled });
    }
  }
  saveIndex(cqrRoot, { version: 1, plugins });
  invalidateAgentPluginCache(cqrRoot);
  appendAudit(cqrRoot, { event: 'set_enabled', id, enabled: input.enabled === true });
  return JSON.stringify({ ok: true, id, enabled: input.enabled === true }, null, 2);
}

/** Lab/realuse smoke installs that should not clutter the product Plugins UI. */
export function isLabSmokePluginId(id: string): boolean {
  const s = String(id || '').trim();
  return /^(lab_echo_|realuse_echo_|lab_scaffold_)/i.test(s);
}

/** Permanently remove a plugin dir + index entry (HITL confirm). */
export function uninstallAgentPlugin(
  cqrRoot: string,
  input: { id: string; confirm?: boolean },
): string {
  if (input.confirm !== true) {
    return JSON.stringify(
      { ok: false, error: 'plugin_uninstall requires confirm=true' },
      null,
      2,
    );
  }
  const id = String(input.id ?? '').trim();
  if (!isValidPluginId(id)) {
    return JSON.stringify({ ok: false, error: 'invalid plugin id' }, null, 2);
  }
  const root = ensurePluginsDir(cqrRoot);
  const dir = path.join(root, id);
  if (!existsSync(dir)) {
    const index = loadIndex(cqrRoot);
    saveIndex(cqrRoot, {
      version: 1,
      plugins: index.plugins.filter((p) => p.id !== id),
    });
    invalidateAgentPluginCache(cqrRoot);
    return JSON.stringify({ ok: false, error: `plugin not found: ${id}` }, null, 2);
  }
  rmSync(dir, { recursive: true, force: true });
  const index = loadIndex(cqrRoot);
  saveIndex(cqrRoot, {
    version: 1,
    plugins: index.plugins.filter((p) => p.id !== id),
  });
  invalidateAgentPluginCache(cqrRoot);
  appendAudit(cqrRoot, { event: 'uninstall', id });
  return JSON.stringify({ ok: true, id, removed: true }, null, 2);
}

/** Remove all lab/realuse echo smoke plugins left behind by verify labs. */
export function purgeLabSmokePlugins(
  cqrRoot: string,
  input?: { confirm?: boolean },
): string {
  if (input?.confirm !== true) {
    return JSON.stringify(
      { ok: false, error: 'purge_lab_smoke requires confirm=true' },
      null,
      2,
    );
  }
  const ids = listAgentPlugins(cqrRoot, { useCache: false })
    .map((p) => p.id)
    .filter((id) => isLabSmokePluginId(id));
  const removed: string[] = [];
  const errors: Array<{ id: string; error: string }> = [];
  for (const id of ids) {
    const raw = uninstallAgentPlugin(cqrRoot, { id, confirm: true });
    try {
      const doc = JSON.parse(raw) as { ok?: boolean; error?: string };
      if (doc.ok) removed.push(id);
      else errors.push({ id, error: doc.error || 'fail' });
    } catch {
      errors.push({ id, error: 'bad_json' });
    }
  }
  appendAudit(cqrRoot, { event: 'purge_lab_smoke', removed, errors });
  return JSON.stringify(
    {
      ok: errors.length === 0,
      removed,
      count: removed.length,
      errors: errors.length ? errors : undefined,
    },
    null,
    2,
  );
}

export function formatPluginListJson(cqrRoot: string): string {
  const list = listAgentPlugins(cqrRoot).map((p) => ({
    id: p.id,
    name: p.manifest.name,
    enabled: p.enabled,
    risk: p.manifest.risk,
    description: p.manifest.description,
    runner: p.manifest.runner.kind,
  }));
  return JSON.stringify(
    {
      ok: true,
      count: list.length,
      plugins: list,
      tip: 'Missing capability → plugin_scaffold then plugin_install confirm=true. Builtin git_*/read_file cannot be shadowed.',
    },
    null,
    2,
  );
}

export function scaffoldAgentPlugin(input: {
  id?: string;
  purpose?: string;
  risk?: AgentPluginRisk;
}): string {
  // Purpose-aware recipes + prefer shipped templates when purpose matches.
  return JSON.stringify(buildPurposeAwareScaffold(input), null, 2);
}

export function auditPluginEvent(cqrRoot: string, event: Record<string, unknown>): void {
  appendAudit(cqrRoot, event);
}

/** Bundled blueprints under tools/plugin-templates (shipped with product, not data/). */
export function templatesRoot(cqrRoot: string): string {
  return path.join(path.resolve(cqrRoot), 'tools', 'plugin-templates');
}

export type PluginTemplateCatalog = {
  version: number;
  product_seed: string[];
  lab_only: string[];
  superseded: Record<string, string>;
};

const DEFAULT_TEMPLATE_CATALOG: PluginTemplateCatalog = {
  version: 1,
  product_seed: [],
  lab_only: ['demo_echo', 'env_probe'],
  superseded: {
    json_read: 'builtin:read_file',
    git_history_tree: 'builtin:git_history_tree',
    workspace_ls: 'builtin:list_directory',
    vcs_tree_brief: 'builtin:git_status',
  },
};

export function loadPluginTemplateCatalog(cqrRoot: string): PluginTemplateCatalog {
  const p = path.join(templatesRoot(cqrRoot), 'catalog.json');
  if (!existsSync(p)) return { ...DEFAULT_TEMPLATE_CATALOG };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<PluginTemplateCatalog>;
    return {
      version: Number(raw.version) || 1,
      product_seed: Array.isArray(raw.product_seed)
        ? raw.product_seed.map(String)
        : [...DEFAULT_TEMPLATE_CATALOG.product_seed],
      lab_only: Array.isArray(raw.lab_only)
        ? raw.lab_only.map(String)
        : [...DEFAULT_TEMPLATE_CATALOG.lab_only],
      superseded:
        raw.superseded && typeof raw.superseded === 'object'
          ? Object.fromEntries(
              Object.entries(raw.superseded).map(([k, v]) => [String(k), String(v)]),
            )
          : { ...DEFAULT_TEMPLATE_CATALOG.superseded },
    };
  } catch {
    return { ...DEFAULT_TEMPLATE_CATALOG };
  }
}

export function isProductVisibleTemplate(cqrRoot: string, templateId: string): boolean {
  const cat = loadPluginTemplateCatalog(cqrRoot);
  if (cat.lab_only.includes(templateId)) return false;
  if (cat.superseded[templateId]) return false;
  return true;
}

/**
 * Same-experience: copy product_seed templates into data/agent-plugins when missing.
 * Idempotent; never overwrites an existing install.
 */
export function ensureShippedProductPlugins(cqrRoot: string): {
  installed: string[];
  skipped: string[];
} {
  const cat = loadPluginTemplateCatalog(cqrRoot);
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const templateId of cat.product_seed) {
    if (!isValidPluginId(templateId)) {
      skipped.push(templateId);
      continue;
    }
    const dest = path.join(pluginsRoot(cqrRoot), templateId);
    if (existsSync(path.join(dest, 'tool.json'))) {
      skipped.push(templateId);
      continue;
    }
    const raw = installAgentPluginFromTemplate(cqrRoot, {
      template_id: templateId,
      id: templateId,
      confirm: true,
    });
    try {
      const doc = JSON.parse(raw) as { ok?: boolean };
      if (doc.ok) installed.push(templateId);
      else skipped.push(templateId);
    } catch {
      skipped.push(templateId);
    }
  }
  if (installed.length) {
    appendAudit(cqrRoot, { event: 'ensure_shipped_product_plugins', installed, skipped });
  }
  return { installed, skipped };
}

export function listPluginTemplates(
  cqrRoot: string,
  opts?: { forUi?: boolean },
): Array<{
  id: string;
  name: string;
  description: string;
  risk: string;
  surface?: 'product' | 'lab' | 'superseded';
  superseded_by?: string;
}> {
  const root = templatesRoot(cqrRoot);
  if (!existsSync(root)) return [];
  const cat = loadPluginTemplateCatalog(cqrRoot);
  const forUi = opts?.forUi !== false;
  const out: Array<{
    id: string;
    name: string;
    description: string;
    risk: string;
    surface?: 'product' | 'lab' | 'superseded';
    superseded_by?: string;
  }> = [];
  try {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      if (!isValidPluginId(ent.name)) continue;
      const toolPath = path.join(root, ent.name, 'tool.json');
      if (!existsSync(toolPath)) continue;
      const surface: 'product' | 'lab' | 'superseded' = cat.lab_only.includes(ent.name)
        ? 'lab'
        : cat.superseded[ent.name]
          ? 'superseded'
          : 'product';
      if (forUi && surface !== 'product') continue;
      try {
        const m = JSON.parse(readFileSync(toolPath, 'utf8')) as Partial<AgentPluginManifest>;
        out.push({
          id: ent.name,
          name: String(m.name ?? `plugin_${ent.name}`),
          description: String(m.description ?? '').slice(0, 200),
          risk: String(m.risk ?? 'read'),
          surface,
          superseded_by: cat.superseded[ent.name],
        });
      } catch {
        /* skip bad template */
      }
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Copy a tools/plugin-templates/{id} into data/agent-plugins/{id}.
 * confirm=true required.
 */
export function installAgentPluginFromTemplate(
  cqrRoot: string,
  input: { template_id: string; confirm?: boolean; id?: string },
): string {
  if (input.confirm !== true) {
    return JSON.stringify(
      {
        ok: false,
        error: 'install from template requires confirm=true',
      },
      null,
      2,
    );
  }
  const templateId = String(input.template_id ?? '').trim();
  if (!isValidPluginId(templateId)) {
    return JSON.stringify({ ok: false, error: 'invalid template_id' }, null, 2);
  }
  const id =
    input.id && isValidPluginId(input.id) ? input.id.trim() : templateId;
  const tDir = path.join(templatesRoot(cqrRoot), templateId);
  const toolPath = path.join(tDir, 'tool.json');
  if (!existsSync(toolPath)) {
    return JSON.stringify(
      { ok: false, error: `template not found: ${templateId}` },
      null,
      2,
    );
  }
  let toolJson: Record<string, unknown>;
  try {
    toolJson = JSON.parse(readFileSync(toolPath, 'utf8')) as Record<string, unknown>;
  } catch (e: unknown) {
    return JSON.stringify(
      {
        ok: false,
        error: `bad template tool.json: ${e instanceof Error ? e.message : String(e)}`,
      },
      null,
      2,
    );
  }
  const entry = String(
    (toolJson.runner as { entry?: string } | undefined)?.entry ?? 'run.mjs',
  );
  const runPath = path.join(tDir, entry);
  if (!existsSync(runPath)) {
    return JSON.stringify(
      { ok: false, error: `template entry missing: ${entry}` },
      null,
      2,
    );
  }
  const run_source = readFileSync(runPath, 'utf8');
  // If installing under a different id, re-name tool to plugin_{id} when name was plugin_{template}
  if (id !== templateId && typeof toolJson.name === 'string') {
    const expected = `plugin_${templateId}`;
    if (toolJson.name === expected) {
      toolJson = { ...toolJson, name: `plugin_${id}` };
    }
  }
  return installAgentPlugin(cqrRoot, {
    id,
    confirm: true,
    tool_json: toolJson,
    run_source,
    created_by: 'user',
  });
}

