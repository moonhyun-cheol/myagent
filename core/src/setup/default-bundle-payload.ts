import { loadDeployDefaults, type DeployDefaults } from '../config/deploy-defaults.js';
import type { BundlePayload } from './key-bundle.js';

export interface BuildDefaultBundleOptions {
  orgId: string;
  cqrRoot: string;
  defaultProviderId?: string | null;
  deploy?: DeployDefaults;
  /** @deprecated Company cloud keys are never included in deployment bundles. */
  requireOpenWebUi?: boolean;
}

export function buildDefaultBundlePayload(opts: BuildDefaultBundleOptions): BundlePayload {
  const deploy = opts.deploy ?? loadDeployDefaults(opts.cqrRoot);
  const ollamaUrl = deploy.ollama_base_url?.trim();
  if (!ollamaUrl) {
    throw new Error('BUNDLE_OLLAMA_URL_MISSING: deploy-defaults.json ollama_base_url required');
  }

  const entries: BundlePayload['entries'] = {
    ollama: {
      api_key: 'ollama',
      base_url: ollamaUrl.replace(/\/$/, ''),
      model_id: deploy.ollama_default_model?.trim() || 'qwen2.5:latest',
    },
  };

  const preferredDefault =
    opts.defaultProviderId === 'custom' ? 'ollama' : (opts.defaultProviderId ?? 'ollama');
  const default_provider_id =
    preferredDefault && entries[preferredDefault]
      ? preferredDefault
      : (Object.keys(entries)[0] as keyof typeof entries | undefined) ?? null;

  return {
    v: 1,
    org_id: opts.orgId,
    default_provider_id,
    entries,
  };
}
