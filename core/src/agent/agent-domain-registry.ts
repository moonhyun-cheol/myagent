/**
 * Domain connector registry. The neutral core ships no organization connector;
 * signed modules or local configuration provide domain-specific definitions.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type DomainDataStatus = 'known' | 'fixture_ok' | 'unknown';

export interface DomainDataSourceHit {
  id: string;
  status: DomainDataStatus;
  note?: string;
}

export interface DomainConnectorDef {
  id: string;
  match: string[];
  fixtureOkMatch?: string[];
  defaultStatus: DomainDataStatus;
  requiredSecrets: string[];
  inventPathPatterns?: string[];
  noteUnknown?: string;
  noteFixtureOk?: string;
  fieldsHint?: string[];
}

export interface DeliveryProfileDef {
  id: string;
  artifactKinds: string[];
  requiredSecrets: string[];
  preferUnless?: string[];
  preferIf?: string[];
  requireAny?: string[];
  forbidIf?: string[];
}

export interface DomainConnectorsDoc {
  version: number;
  connectors: DomainConnectorDef[];
  deliveryProfiles: DeliveryProfileDef[];
}

let cached: DomainConnectorsDoc | null = null;
let cachedRoot: string | null = null;

function defaultDoc(): DomainConnectorsDoc {
  return {
    version: 1,
    connectors: [],
    deliveryProfiles: [
      {
        id: 'discord_webhook',
        artifactKinds: ['discord_bot', 'scheduled_job'],
        requiredSecrets: ['DISCORD_WEBHOOK_URL'],
        preferUnless: ['Bot Token', 'DISCORD_BOT_TOKEN', 'discord.js', '게이트웨이 봇', '봇 토큰'],
      },
      {
        id: 'discord_bot_token',
        artifactKinds: ['discord_bot'],
        requiredSecrets: ['DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_ID'],
        requireAny: ['Bot Token', 'DISCORD_BOT_TOKEN', 'discord.js', '게이트웨이 봇', '봇 토큰'],
        forbidIf: ['webhook', '웹훅', '웹후크', 'DISCORD_WEBHOOK_URL'],
      },
    ],
  };
}

function normalizeDoc(raw: unknown): DomainConnectorsDoc {
  const base = defaultDoc();
  if (!raw || typeof raw !== 'object') return base;
  const doc = raw as Partial<DomainConnectorsDoc>;
  const connectors = Array.isArray(doc.connectors)
    ? doc.connectors
        .filter((c) => c && typeof c.id === 'string')
        .map((c) => ({
          id: String(c.id).trim(),
          match: Array.isArray(c.match) ? c.match.map(String) : [],
          fixtureOkMatch: Array.isArray(c.fixtureOkMatch)
            ? c.fixtureOkMatch.map(String)
            : [],
          defaultStatus:
            c.defaultStatus === 'known' || c.defaultStatus === 'fixture_ok'
              ? c.defaultStatus
              : ('unknown' as DomainDataStatus),
          requiredSecrets: Array.isArray(c.requiredSecrets)
            ? c.requiredSecrets.map(String)
            : [],
          inventPathPatterns: Array.isArray(c.inventPathPatterns)
            ? c.inventPathPatterns.map(String)
            : [],
          noteUnknown: typeof c.noteUnknown === 'string' ? c.noteUnknown : undefined,
          noteFixtureOk: typeof c.noteFixtureOk === 'string' ? c.noteFixtureOk : undefined,
          fieldsHint: Array.isArray(c.fieldsHint) ? c.fieldsHint.map(String) : [],
        }))
        .filter((c) => c.id && c.match.length)
    : base.connectors;
  const deliveryProfiles = Array.isArray(doc.deliveryProfiles)
    ? doc.deliveryProfiles
        .filter((p) => p && typeof p.id === 'string')
        .map((p) => ({
          id: String(p.id).trim(),
          artifactKinds: Array.isArray(p.artifactKinds) ? p.artifactKinds.map(String) : [],
          requiredSecrets: Array.isArray(p.requiredSecrets)
            ? p.requiredSecrets.map(String)
            : [],
          preferUnless: Array.isArray(p.preferUnless) ? p.preferUnless.map(String) : [],
          preferIf: Array.isArray(p.preferIf) ? p.preferIf.map(String) : [],
          requireAny: Array.isArray(p.requireAny) ? p.requireAny.map(String) : [],
          forbidIf: Array.isArray(p.forbidIf) ? p.forbidIf.map(String) : [],
        }))
        .filter((p) => p.id)
    : base.deliveryProfiles;
  return {
    version: typeof doc.version === 'number' ? doc.version : 1,
    connectors,
    deliveryProfiles: deliveryProfiles.length ? deliveryProfiles : base.deliveryProfiles,
  };
}

export function loadDomainConnectors(cqrRoot?: string): DomainConnectorsDoc {
  const root = cqrRoot?.trim() || process.env.MY_AGENT_ROOT || '';
  if (cached && cachedRoot === root) return cached;
  const candidates = root
    ? [
        path.join(root, 'core', 'config', 'defaults', 'domain-connectors.json'),
        path.join(root, 'core', 'dist', 'config', 'defaults', 'domain-connectors.json'),
      ]
    : [];
  for (const fp of candidates) {
    if (!existsSync(fp)) continue;
    try {
      cached = normalizeDoc(JSON.parse(readFileSync(fp, 'utf8')));
      cachedRoot = root;
      return cached;
    } catch {
      /* fall through */
    }
  }
  cached = defaultDoc();
  cachedRoot = root;
  return cached;
}

/** Test helper — clear memo. */
export function resetDomainConnectorsCache(): void {
  cached = null;
  cachedRoot = null;
}

function textHasAny(text: string, needles: string[] | undefined): boolean {
  if (!needles?.length) return false;
  const t = text;
  return needles.some((n) => n && t.toLowerCase().includes(n.toLowerCase()));
}

/** Match data-source connectors mentioned in the user/PLAN text. */
export function matchDomainConnectors(
  message: string,
  cqrRoot?: string,
): DomainDataSourceHit[] {
  const doc = loadDomainConnectors(cqrRoot);
  const t = String(message || '');
  if (!t.trim()) return [];
  const out: DomainDataSourceHit[] = [];
  for (const c of doc.connectors) {
    if (!textHasAny(t, c.match)) continue;
    const fixtureOk = textHasAny(t, c.fixtureOkMatch);
    const status: DomainDataStatus = fixtureOk ? 'fixture_ok' : c.defaultStatus;
    out.push({
      id: c.id,
      status,
      note: status === 'fixture_ok' ? c.noteFixtureOk : c.noteUnknown,
    });
  }
  return out;
}

/** Secrets required by matched data sources. */
export function secretsForDataSources(
  sources: DomainDataSourceHit[],
  cqrRoot?: string,
): string[] {
  const doc = loadDomainConnectors(cqrRoot);
  const byId = new Map(doc.connectors.map((c) => [c.id, c]));
  const secrets: string[] = [];
  for (const s of sources) {
    // fixture_ok still lists secrets for live upgrade path, but preflight is softer upstream
    const c = byId.get(s.id);
    if (c?.requiredSecrets?.length) secrets.push(...c.requiredSecrets);
  }
  return [...new Set(secrets)];
}

/**
 * Discord (and similar) delivery secrets from registry profiles.
 * Prefer webhook unless explicit bot-token language without webhook.
 */
export function resolveDeliverySecrets(opts: {
  message: string;
  artifactKind: string;
  cqrRoot?: string;
}): { secrets: string[]; profileId: string | null; why: string[] } {
  const doc = loadDomainConnectors(opts.cqrRoot);
  const t = String(opts.message || '');
  const why: string[] = [];
  const kind = opts.artifactKind;
  const candidates = doc.deliveryProfiles.filter((p) => p.artifactKinds.includes(kind));
  if (!candidates.length) return { secrets: [], profileId: null, why: ['no_delivery_profile'] };

  for (const p of candidates) {
    if (p.requireAny?.length && !textHasAny(t, p.requireAny)) continue;
    if (p.forbidIf?.length && textHasAny(t, p.forbidIf)) continue;
    // Prefer webhook profile when no explicit bot requireAny matched yet
    if (p.id.includes('webhook')) {
      if (p.preferUnless?.length && textHasAny(t, p.preferUnless) && !textHasAny(t, p.preferIf)) {
        continue;
      }
      why.push(`delivery=${p.id}`);
      return { secrets: [...p.requiredSecrets], profileId: p.id, why };
    }
  }

  for (const p of candidates) {
    if (p.requireAny?.length && textHasAny(t, p.requireAny)) {
      if (p.forbidIf?.length && textHasAny(t, p.forbidIf)) continue;
      why.push(`delivery=${p.id}`);
      return { secrets: [...p.requiredSecrets], profileId: p.id, why };
    }
  }

  // Default: first webhook-like profile for this kind, else first profile
  const webhook = candidates.find((p) => p.id.includes('webhook'));
  const pick = webhook ?? candidates[0];
  why.push(`delivery_default=${pick.id}`);
  return { secrets: [...pick.requiredSecrets], profileId: pick.id, why };
}

/** Invented concrete API paths for unknown-status connectors. */
export function contentInventsDomainApiFromRegistry(
  text: string,
  sources: DomainDataSourceHit[],
  cqrRoot?: string,
): boolean {
  const unknown = sources.filter((d) => d.status === 'unknown');
  if (!unknown.length) return false;
  const t = String(text || '');
  if (!t.trim()) return false;
  if (/(?:fixture|픽스처|가정|샘플|모의|mock)/i.test(t) && !/실\s*API|실제\s*엔드포인트/i.test(t)) {
    if (!/(?:실연동\s*완료|실API\s*확인|스키마\s*확정)/i.test(t)) return false;
  }
  const doc = loadDomainConnectors(cqrRoot);
  const byId = new Map(doc.connectors.map((c) => [c.id, c]));
  for (const s of unknown) {
    const c = byId.get(s.id);
    for (const pat of c?.inventPathPatterns ?? []) {
      try {
        if (new RegExp(pat, 'i').test(t)) return true;
      } catch {
        if (t.includes(pat)) return true;
      }
    }
  }
  return false;
}
