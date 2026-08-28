import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loadOrganizationDeployOverrides } from './organization-deploy-overrides.js';

export interface DeployDefaults {
  ollama_base_url?: string;
  ollama_default_model?: string;
  openrouter_base_url?: string;
  openrouter_default_model?: string;
  /** @deprecated Read-only compatibility for older deployment files. */
  openwebui_base_url?: string;
  /** @deprecated Read-only compatibility for older deployment files. */
  openwebui_default_model?: string;
  activation_server_url?: string;
  activation_token?: string;
  organization_module_root?: string;
  live_automaton_root?: string;
  /** OpenClaw Adapter API base (e.g. http://192.168.x.x:8790). Empty = local spawn only. */
  openclaw_adapter_base_url?: string;
  /** Bearer token for Adapter / Queue. Prefer env OPENCLAW_ADAPTER_TOKEN — do not commit secrets. */
  openclaw_adapter_token?: string;
  /** Ed25519 seed hex for gate_command_context. Prefer env GATE_CONTEXT_SIGNING_PRIVATE_KEY. */
  openclaw_gate_signing_private_key?: string;
  openclaw_actor_id?: string;
  openclaw_fallback_local?: boolean;
  web_search_auto?: boolean;
  /** Organization brand manual URL fallback when no org module is installed. */
  brand_manual_url?: string;
  note?: string;
}

function resolveDeployDefaultsPath(cqrRoot: string): string | null {
  const candidates = [
    path.join(cqrRoot, 'core', 'config', 'defaults', 'deploy-defaults.json'),
    path.join(cqrRoot, 'core', 'dist', 'config', 'defaults', 'deploy-defaults.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

const ACTIVATION_DISABLED_VALUES = new Set(['0', 'off', 'none', 'false', 'disabled']);

export function loadDeployDefaults(cqrRoot: string): DeployDefaults {
  const file = resolveDeployDefaultsPath(cqrRoot);
  let doc: DeployDefaults = {};
  if (file) {
    try {
      doc = JSON.parse(readFileSync(file, 'utf8')) as DeployDefaults;
    } catch {
      doc = {};
    }
  }

  // Windows drops env vars set to an empty string across process spawns, so an explicit
  // sentinel is the only reliable way for callers (verify scripts, offline runs) to turn
  // central activation off.
  const rawActivationUrl = process.env.MY_AGENT_ACTIVATION_SERVER_URL;
  if (rawActivationUrl !== undefined) {
    const v = rawActivationUrl.trim();
    if (v && !ACTIVATION_DISABLED_VALUES.has(v.toLowerCase())) doc.activation_server_url = v;
    else delete doc.activation_server_url;
  }
  if (process.env.MY_AGENT_ACTIVATION_TOKEN?.trim()) {
    doc.activation_token = process.env.MY_AGENT_ACTIVATION_TOKEN.trim();
  }

  if (process.env.OPENCLAW_ADAPTER_BASE_URL?.trim()) {
    doc.openclaw_adapter_base_url = process.env.OPENCLAW_ADAPTER_BASE_URL.trim();
  }
  if (
    process.env.OPENCLAW_ADAPTER_TOKEN?.trim()
    || process.env.MAIN_API_TOKEN?.trim()
    || process.env.MANAGER_API_TOKEN?.trim()
  ) {
    doc.openclaw_adapter_token = (
      process.env.OPENCLAW_ADAPTER_TOKEN?.trim()
      || process.env.MAIN_API_TOKEN?.trim()
      || process.env.MANAGER_API_TOKEN?.trim()
    );
  }
  if (
    process.env.GATE_CONTEXT_SIGNING_PRIVATE_KEY?.trim()
  ) {
    doc.openclaw_gate_signing_private_key = process.env.GATE_CONTEXT_SIGNING_PRIVATE_KEY?.trim();
  }

  const orgOverrides = loadOrganizationDeployOverrides(cqrRoot);
  doc = { ...doc, ...orgOverrides };

  return doc;
}
