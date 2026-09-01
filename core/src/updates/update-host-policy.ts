/**
 * Update/module download host policy — host-agnostic.
 * Defaults keep GitHub working; servers set MY_AGENT_UPDATE_TRUSTED_HOSTS
 * (and optional ASSET_URL_TEMPLATE) without code changes.
 */
export const DEFAULT_UPDATE_FEED_HOSTS = ['raw.githubusercontent.com'] as const;

export const DEFAULT_UPDATE_ASSET_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
] as const;

function parseHostList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function hostMatches(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const p = pattern.toLowerCase().replace(/^\*\./, '.');
  if (pattern.startsWith('*.') || pattern.startsWith('.')) {
    const suffix = pattern.startsWith('*.') ? pattern.slice(1) : pattern;
    return host === suffix.slice(1) || host.endsWith(suffix);
  }
  if (p.startsWith('.')) return host === p.slice(1) || host.endsWith(p);
  return host === p || host.endsWith(`.${p}`);
}

/** Extra hosts from env (both feed + asset unless split envs set). */
export function envTrustedUpdateHosts(): string[] {
  return [
    ...parseHostList(process.env.MY_AGENT_UPDATE_TRUSTED_HOSTS),
    ...parseHostList(process.env.MY_AGENT_UPDATE_FEED_HOSTS),
    ...parseHostList(process.env.MY_AGENT_UPDATE_ASSET_HOSTS),
  ];
}

export function isTrustedUpdateFeedHost(
  hostname: string,
  opts?: { configuredFeedHost?: string },
): boolean {
  const host = hostname.toLowerCase();
  if (opts?.configuredFeedHost && host === opts.configuredFeedHost.toLowerCase()) {
    return true;
  }
  for (const h of DEFAULT_UPDATE_FEED_HOSTS) {
    if (host === h) return true;
  }
  for (const h of parseHostList(process.env.MY_AGENT_UPDATE_TRUSTED_HOSTS)) {
    if (hostMatches(host, h)) return true;
  }
  for (const h of parseHostList(process.env.MY_AGENT_UPDATE_FEED_HOSTS)) {
    if (hostMatches(host, h)) return true;
  }
  return false;
}

export function isTrustedUpdateAssetHost(
  hostname: string,
  opts?: { configuredFeedHost?: string },
): boolean {
  const host = hostname.toLowerCase();
  if (opts?.configuredFeedHost && host === opts.configuredFeedHost.toLowerCase()) {
    return true;
  }
  for (const h of DEFAULT_UPDATE_ASSET_HOSTS) {
    if (host === h) return true;
  }
  if (host.endsWith('.githubusercontent.com')) return true;
  for (const h of parseHostList(process.env.MY_AGENT_UPDATE_TRUSTED_HOSTS)) {
    if (hostMatches(host, h)) return true;
  }
  for (const h of parseHostList(process.env.MY_AGENT_UPDATE_ASSET_HOSTS)) {
    if (hostMatches(host, h)) return true;
  }
  return false;
}

function fillAssetUrlTemplate(
  template: string,
  input: { repository: string; releaseTag: string; name: string },
): URL {
  const parts = String(input.repository ?? '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('repository must use owner/name format');
  }
  const [owner, repo] = parts;
  const tag = String(input.releaseTag ?? '');
  const name = String(input.name ?? '');
  const filled = template
    .replaceAll('{owner}', encodeURIComponent(owner))
    .replaceAll('{repo}', encodeURIComponent(repo))
    .replaceAll('{repository}', `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
    .replaceAll('{tag}', encodeURIComponent(tag))
    .replaceAll('{name}', encodeURIComponent(name));
  return new URL(filled);
}

/**
 * Build release asset HTTPS URL.
 * Template env MY_AGENT_UPDATE_ASSET_URL_TEMPLATE may use:
 * {owner} {repo} {repository} {tag} {name}
 * Default: GitHub releases download URL.
 */
export function buildUpdateAssetUrl(input: {
  repository: string;
  releaseTag: string;
  name: string;
}): URL {
  const template = process.env.MY_AGENT_UPDATE_ASSET_URL_TEMPLATE?.trim();
  if (template) return fillAssetUrlTemplate(template, input);
  const parts = String(input.repository ?? '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('repository must use owner/name format');
  }
  const [owner, repo] = parts;
  const tag = String(input.releaseTag ?? '');
  const name = String(input.name ?? '');
  return new URL(
    `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
  );
}

/**
 * Work-kit shelf asset URL — server migration friendly.
 * Priority: MY_AGENT_WORK_KIT_ASSET_URL_TEMPLATE → MY_AGENT_UPDATE_ASSET_URL_TEMPLATE → GitHub default.
 */
export function buildWorkKitAssetUrl(input: {
  repository: string;
  releaseTag: string;
  name: string;
}): URL {
  const kitTemplate = process.env.MY_AGENT_WORK_KIT_ASSET_URL_TEMPLATE?.trim();
  if (kitTemplate) return fillAssetUrlTemplate(kitTemplate, input);
  return buildUpdateAssetUrl(input);
}

export function resolveWorkKitAssetUrlMode(): 'kit_template' | 'update_template' | 'github_default' {
  if (process.env.MY_AGENT_WORK_KIT_ASSET_URL_TEMPLATE?.trim()) return 'kit_template';
  if (process.env.MY_AGENT_UPDATE_ASSET_URL_TEMPLATE?.trim()) return 'update_template';
  return 'github_default';
}
