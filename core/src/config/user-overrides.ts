import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';
import type { ReasoningLevel } from '../execution-policy.js';

export interface ErrorReportSettings {
  enabled?: boolean;
}

export interface NasWriteConsent {
  enabled?: boolean;
  approved_at?: string;
  approved_by?: string;
}

export interface UserOverrides {
  local_only?: boolean;
  default_model?: string;
  /** Company cloud models shown in the picker. Omitted = product default set. */
  company_model_ids?: string[];
  attachment_max_bytes?: number;
  model_upload_max_bytes?: number;
  dev_workspace_root?: string;
  nas_write_consent?: NasWriteConsent;
  error_report?: ErrorReportSettings;
  /** Playwright browser tools — default headless true when omitted */
  playwright_headless?: boolean;
  /** Allow localhost/private IPs in browser_navigate (local dev). Code agent defaults on when omitted. */
  playwright_allow_localhost?: boolean;
  /**
   * Agent Autopilot: continue investigate→mutate→verify in one run
   * without stopping on 「다음 조치」. Default off (Safe).
   */
  agent_autopilot?: boolean | null;
  /** Default reasoning for newly created chats. Existing sessions keep their snapshot. */
  agent_reasoning?: ReasoningLevel;
  /** Delegate only non-destructive writes contained by the selected local workspace. */
  approval_delegation?: 'off' | 'safe_local' | 'auto_review';
}
const DEFAULT_MAX = 20 * 1024 * 1024;
const DEFAULT_MODEL_MAX = 32 * 1024 * 1024 * 1024;

export function loadUserOverrides(configPath: string): UserOverrides {
  if (!existsSync(configPath)) {
    return {
      attachment_max_bytes: DEFAULT_MAX,
      model_upload_max_bytes: DEFAULT_MODEL_MAX,
    };
  }
  try {
    const doc = JSON.parse(readFileSync(configPath, 'utf8')) as UserOverrides;
    return {
      ...doc,
      attachment_max_bytes: doc.attachment_max_bytes ?? DEFAULT_MAX,
      model_upload_max_bytes: doc.model_upload_max_bytes ?? DEFAULT_MODEL_MAX,
    };
  } catch {
    return {
      attachment_max_bytes: DEFAULT_MAX,
      model_upload_max_bytes: DEFAULT_MODEL_MAX,
    };
  }
}

export function saveUserOverrides(
  configPath: string,
  patch: Partial<UserOverrides>,
  cqrRoot: string,
): UserOverrides {
  const current = loadUserOverrides(configPath);
  const next: UserOverrides = { ...current, ...patch };
  assertWritablePath(configPath, cqrRoot);
  writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

export function userConfigPath(dataDir: string): string {
  return path.join(dataDir, 'config', 'user-overrides.json');
}

export function isProviderAllowedLocalOnly(providerId: string, catalog: { id: string; local_only_ok?: boolean }[]): boolean {
  const def = catalog.find((p) => p.id === providerId);
  return def?.local_only_ok === true || providerId === 'ollama';
}
