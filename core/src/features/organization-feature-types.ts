/**
 * Organization Feature contract — signed packs under data/organization-features/.
 * Brand-specific slash/workflow content must live in external packs, not Core.
 */

export const FEATURE_JSON_SCHEMA = 'my-agent-organization-feature/v1';
export const FEATURE_PAYLOAD_SCHEMA = 'my-agent-organization-feature-payload/v1';
export const FEATURE_INDEX_SCHEMA_VERSION = 1;
export const FEATURES_DATA_ROOT = 'data/organization-features';

/** feature id: dotted segments, e.g. org.cqr.automaton-routing */
export const FEATURE_ID_RE = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*){0,7}$/;

export interface OrganizationFeatureEntrypoints {
  automaton_tools_manifest?: string;
  openclaw_workflow_map?: string;
  adapter_connection?: string;
}

export interface OrganizationFeatureJson {
  schema: typeof FEATURE_JSON_SCHEMA;
  id: string;
  version: string;
  update_sequence: number;
  label?: string;
  description?: string;
  capabilities?: string[];
  entrypoints?: OrganizationFeatureEntrypoints;
}

export interface OrganizationFeaturePayloadFile {
  path: string;
  size: number;
  sha256: string;
}

export interface OrganizationFeaturePayloadDocument {
  schema: typeof FEATURE_PAYLOAD_SCHEMA;
  feature_id: string;
  version: string;
  update_sequence: number;
  files: OrganizationFeaturePayloadFile[];
}

export interface OrganizationFeatureIndexEntry {
  enabled: boolean;
  installed_at: string;
  updated_at: string;
  version: string;
  update_sequence: number;
  label?: string;
  capabilities: string[];
  /** Work-kit refs that require this feature (group/kit_id). */
  refs: string[];
}

export interface OrganizationFeatureIndex {
  schema_version: typeof FEATURE_INDEX_SCHEMA_VERSION;
  features: Record<string, OrganizationFeatureIndexEntry>;
}

export interface WorkKitFeatureEnableSpec {
  required?: boolean;
}

export interface WorkKitFeaturesBlock {
  enable?: Record<string, WorkKitFeatureEnableSpec>;
}

export interface OrganizationFeatureStatus {
  id: string;
  installed: boolean;
  enabled: boolean;
  version?: string;
  update_sequence?: number;
  label?: string;
  capabilities: string[];
  refs: string[];
  root?: string;
}

export interface FeatureRequiredInfo {
  feature_id: string;
  slash: string;
  message: string;
}

export interface OptionalFeatureSlashIndexEntry {
  prefix: string;
  feature_id: string;
  message_ko?: string;
}

export interface OptionalFeatureSlashIndexDoc {
  version?: number;
  slashes?: OptionalFeatureSlashIndexEntry[];
}

/** External migration declaration — no hard-coded brand ids in Core. */
export interface OrganizationFeatureMigrationDeclaration {
  feature_id: string;
  /** Relative paths under modules/organization (or MY_AGENT_ORGANIZATION_MODULE_ROOT). */
  source_paths: {
    feature_json?: string;
    automaton_tools_manifest?: string;
    openclaw_workflow_map?: string;
    adapter_connection?: string;
  };
  require_applied_work_kit?: { group: string; id: string };
  label?: string;
  version?: string;
  capabilities?: string[];
}

export class OrganizationFeatureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OrganizationFeatureError';
  }
}
