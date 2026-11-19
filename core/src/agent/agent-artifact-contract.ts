/**
 * Artifact contract — session-locked product modality for coding turns.
 * Stored on locked constraints (agent-locked-constraints.ts) and rendered as a
 * system note. No message-text inference lives here.
 */

export type ArtifactKind =
  | 'web_spa'
  | 'discord_bot'
  | 'scheduled_job'
  | 'data_pipeline'
  | 'cli_tool'
  | 'unknown';

export type RuntimeSurface =
  | 'browser'
  | 'local_node'
  | 'openclaw'
  | 'none'
  | 'unknown';

export type DataSourceStatus = 'known' | 'fixture_ok' | 'unknown';

export interface DataSourceRef {
  id: string;
  status: DataSourceStatus;
  note?: string;
}

export interface ArtifactContract {
  artifactKind: ArtifactKind;
  runtimeSurface: RuntimeSurface;
  dataSources: DataSourceRef[];
  requiredSecrets: string[];
  /** Prior wrong-modality paths to isolate under _legacy / do-not-touch. */
  legacyIsolateGlobs: string[];
  why: string[];
}

export function emptyArtifactContract(
  partial?: Partial<ArtifactContract>,
): ArtifactContract {
  return normalizeArtifactContract({
    artifactKind: 'unknown',
    runtimeSurface: 'unknown',
    dataSources: [],
    requiredSecrets: [],
    legacyIsolateGlobs: [],
    why: [],
    ...partial,
  });
}

export function normalizeArtifactContract(
  raw: Partial<ArtifactContract> | null | undefined,
): ArtifactContract {
  const kind = normalizeKind(raw?.artifactKind);
  const surface = normalizeSurface(raw?.runtimeSurface);
  const dataSources = Array.isArray(raw?.dataSources)
    ? raw!.dataSources
        .map((d) => ({
          id: String(d?.id || '').trim().slice(0, 64),
          status: normalizeDataStatus(d?.status),
          note:
            typeof d?.note === 'string' && d.note.trim()
              ? d.note.trim().slice(0, 160)
              : undefined,
        }))
        .filter((d) => d.id)
        .slice(0, 12)
    : [];
  const requiredSecrets = Array.isArray(raw?.requiredSecrets)
    ? [...new Set(raw!.requiredSecrets.map((s) => String(s).trim()).filter(Boolean))].slice(0, 16)
    : [];
  const legacyIsolateGlobs = Array.isArray(raw?.legacyIsolateGlobs)
    ? [...new Set(raw!.legacyIsolateGlobs.map((s) => String(s).trim()).filter(Boolean))].slice(
        0,
        24,
      )
    : [];
  const why = Array.isArray(raw?.why)
    ? raw!.why.map((s) => String(s).trim()).filter(Boolean).slice(0, 12)
    : [];
  return {
    artifactKind: kind,
    runtimeSurface: surface,
    dataSources,
    requiredSecrets,
    legacyIsolateGlobs,
    why,
  };
}

function normalizeKind(v: unknown): ArtifactKind {
  const s = String(v || '');
  if (
    s === 'web_spa'
    || s === 'discord_bot'
    || s === 'scheduled_job'
    || s === 'data_pipeline'
    || s === 'cli_tool'
    || s === 'unknown'
  ) {
    return s;
  }
  return 'unknown';
}

function normalizeSurface(v: unknown): RuntimeSurface {
  const s = String(v || '');
  if (
    s === 'browser'
    || s === 'local_node'
    || s === 'openclaw'
    || s === 'none'
    || s === 'unknown'
  ) {
    return s;
  }
  return 'unknown';
}

function normalizeDataStatus(v: unknown): DataSourceStatus {
  const s = String(v || '');
  if (s === 'known' || s === 'fixture_ok' || s === 'unknown') return s;
  return 'unknown';
}

/** Prefer locked non-unknown fields; fill gaps from the incoming contract. */
export function mergeArtifactContracts(
  locked: ArtifactContract | null | undefined,
  inferred: ArtifactContract,
): ArtifactContract {
  const a = normalizeArtifactContract(locked);
  const b = normalizeArtifactContract(inferred);
  const artifactKind = a.artifactKind !== 'unknown' ? a.artifactKind : b.artifactKind;
  let runtimeSurface = a.runtimeSurface !== 'unknown' ? a.runtimeSurface : b.runtimeSurface;
  if (b.why.includes('personal_bot_no_openclaw') || b.why.includes('force_local_node')) {
    if (runtimeSurface === 'openclaw' || runtimeSurface === 'unknown') {
      runtimeSurface = 'local_node';
    }
  }
  const byId = new Map<string, DataSourceRef>();
  for (const d of [...a.dataSources, ...b.dataSources]) {
    const prev = byId.get(d.id);
    if (!prev) {
      byId.set(d.id, d);
      continue;
    }
    // Prefer known > fixture_ok > unknown
    const rank = (s: DataSourceStatus) =>
      s === 'known' ? 3 : s === 'fixture_ok' ? 2 : 1;
    byId.set(d.id, rank(d.status) >= rank(prev.status) ? d : prev);
  }
  return emptyArtifactContract({
    artifactKind,
    runtimeSurface,
    dataSources: [...byId.values()],
    requiredSecrets: [...new Set([...a.requiredSecrets, ...b.requiredSecrets])],
    legacyIsolateGlobs: [...new Set([...a.legacyIsolateGlobs, ...b.legacyIsolateGlobs])],
    why: [...new Set([...a.why, ...b.why, 'merged'])].slice(0, 12),
  });
}

/** Default scaffold hint for Understanding Card / locked note. */
export function scaffoldHintForContract(c: ArtifactContract): string {
  switch (c.artifactKind) {
    case 'discord_bot':
      return c.runtimeSurface === 'openclaw'
        ? 'Scaffold: OpenClaw/automaton Discord ops path (adapter) — not a personal discord.js bot unless asked.'
        : c.requiredSecrets.includes('DISCORD_BOT_TOKEN')
          ? 'Scaffold: Node discord.js bot (+ schedule). Prefer package.json, src/, .env.example — NOT index.html SPA.'
          : 'Scaffold: Node scheduled job + Discord Incoming Webhook (DISCORD_WEBHOOK_URL via fetch). No bot app/token unless asked. NOT index.html SPA.';
    case 'scheduled_job':
      return 'Scaffold: Node/PowerShell scheduled job + report writer. Not a web SPA.';
    case 'data_pipeline':
      return 'Scaffold: data pipeline (CSV/XLSX/fixtures). Not a browser UI unless asked.';
    case 'web_spa':
      return 'Scaffold: web SPA (html/js/css or existing UI stack).';
    case 'cli_tool':
      return 'Scaffold: CLI/script entry — not a SPA.';
    default:
      return 'Scaffold: lock artifactKind before inventing a web SPA.';
  }
}

export function formatArtifactContractSystemNote(
  contract: ArtifactContract | null | undefined,
): string {
  if (!contract) return '';
  const c = normalizeArtifactContract(contract);
  if (
    c.artifactKind === 'unknown'
    && c.runtimeSurface === 'unknown'
    && !c.dataSources.length
    && !c.requiredSecrets.length
    && !c.legacyIsolateGlobs.length
  ) {
    return '';
  }
  const lines = [
    '## Artifact contract (session — prefer over scaffold guesses)',
    `artifactKind: ${c.artifactKind}`,
    `runtimeSurface: ${c.runtimeSurface}`,
    scaffoldHintForContract(c),
  ];
  if (c.runtimeSurface === 'local_node') {
    lines.push(
      'FORBIDDEN: suggest or call OpenClaw/adapter (/cqr/adapter). Personal/local bot ≠ OpenClaw.',
    );
  }
  if (c.runtimeSurface === 'openclaw') {
    lines.push('Use OpenClaw/automaton path only; do not invent a parallel personal discord.js unless asked.');
  }
  if (c.dataSources.length) {
    lines.push(
      `dataSources: ${c.dataSources.map((d) => `${d.id}=${d.status}${d.note ? `(${d.note})` : ''}`).join('; ')}`,
    );
    if (c.dataSources.some((d) => d.status === 'unknown')) {
      lines.push(
        'FORBIDDEN: invent real REST paths for unknown sources. Use fixture + labeled 가정, or ask one clarify question.',
      );
    }
  }
  if (c.requiredSecrets.length) {
    lines.push(
      `requiredSecrets (preflight BEFORE claiming live publish/done): ${c.requiredSecrets.join(', ')}`,
    );
    lines.push(
      'If channel/token missing: put checklist in .env.example; do not claim Discord 게시 완료.',
    );
  }
  if (c.legacyIsolateGlobs.length) {
    lines.push(
      `legacyIsolate: move/keep under _web_legacy/ or _legacy/ — do-not-touch: ${c.legacyIsolateGlobs.join(', ')}`,
    );
  }
  if (c.why.length) lines.push(`why: ${c.why.join('+')}`);
  return lines.join('\n');
}
