/**
 * Artifact contract — first-class product modality for coding turns.
 * Locks artifactKind / runtimeSurface / dataSources / requiredSecrets so
 * web SPA defaults, OpenClaw bleed, and invented domain APIs fail closed.
 */
import {
  contentInventsDomainApiFromRegistry,
  matchDomainConnectors,
  resolveDeliverySecrets,
  secretsForDataSources,
} from './agent-domain-registry.js';

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

const WEB_SPA_RE =
  /(?:웹\s*(?:앱|애플리케이션|SPA)|SPA|React|Next\.?js|index\.html|styles\.css|프론트\s*엔드|대시보드\s*UI|브라우저\s*(?:앱|화면))/i;

const DISCORD_BOT_RE =
  /(?:Discord|디스코드).{0,40}(?:봇|bot|매크로|macro|길드|guild|채널|channel|webhook|웹훅|웹후크)|(?:개인\s*(?:용\s*)?(?:봇|Discord)|discord\.js|DISCORD_BOT_TOKEN|DISCORD_CHANNEL_ID|DISCORD_WEBHOOK_URL)/i;

const SCHEDULE_RE =
  /(?:일간|매일|스케줄|cron|task\s*scheduler|Windows\s*Task|예약\s*실행|node-cron)/i;

const PIPELINE_RE =
  /(?:CSV|XLSX|엑셀|파이프라인|배치\s*리포트|보고서[/\\]|data\s*pipeline)/i;

const CLI_RE =
  /(?:CLI|커맨드라인|command[\s-]?line|\.ps1|\.bat\b|powershell\s*스크립트)/i;

const OPENCLAW_RE =
  /(?:OpenClaw|openclaw(?:-adapter)?|(?<![A-Za-z0-9_/])automaton(?![A-Za-z0-9_])|어댑터\s*API|\/adapter\/request)/i;

const PERSONAL_BOT_BAN_OPENCLAW_RE =
  /(?:개인\s*(?:용)?|OpenClaw\s*(?:금지|연결\s*금지|미사용|쓰지\s*마|말고)|OpenClaw\s*없|어댑터\s*금지)/i;

/** Web product files that should move to _legacy when modality flips away from web_spa. */
export const DEFAULT_WEB_LEGACY_GLOBS = [
  'index.html',
  'app.js',
  'styles.css',
  'main.js',
  'script.js',
] as const;

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

/**
 * Infer artifact contract from a user (or PLAN) message.
 * Prefer explicit Discord/schedule over bare "만들어" → web.
 */
export function inferArtifactContract(message: string): ArtifactContract {
  const t = String(message || '').trim();
  const why: string[] = [];
  if (!t) return emptyArtifactContract({ why: ['empty'] });

  const banOpenClaw = PERSONAL_BOT_BAN_OPENCLAW_RE.test(t);
  const wantsOpenClaw = OPENCLAW_RE.test(t) && !banOpenClaw;
  const discord = DISCORD_BOT_RE.test(t) || /DISCORD_(?:BOT_TOKEN|CHANNEL_ID|GUILD_ID)/i.test(t);
  const schedule = SCHEDULE_RE.test(t);
  const pipeline = PIPELINE_RE.test(t);
  const web = WEB_SPA_RE.test(t);
  const cli = CLI_RE.test(t);
  const notWeb =
    /(?:웹\s*(?:앱|아님|아니다|금지)|웹이\s*아니|SPA\s*금지|브라우저\s*앱\s*말고)/i.test(t);

  let artifactKind: ArtifactKind = 'unknown';
  let runtimeSurface: RuntimeSurface = 'unknown';

  if (discord && (schedule || /매크로|bot|봇|길드|channel/i.test(t) || banOpenClaw)) {
    // 매크로/봇 = Discord bot surface; bare schedule+pipeline alone → scheduled_job
    artifactKind =
      schedule && !/(?:봇|bot|매크로|macro|discord\.js|webhook)/i.test(t)
        ? 'scheduled_job'
        : 'discord_bot';
    runtimeSurface = wantsOpenClaw ? 'openclaw' : 'local_node';
    why.push(discord ? 'discord_keywords' : 'schedule');
    if (banOpenClaw) why.push('personal_bot_no_openclaw');
  } else if (wantsOpenClaw && !banOpenClaw) {
    artifactKind = discord ? 'discord_bot' : 'scheduled_job';
    runtimeSurface = 'openclaw';
    why.push('openclaw_keywords');
  } else if (schedule && (pipeline || discord)) {
    artifactKind = 'scheduled_job';
    runtimeSurface = 'local_node';
    why.push('schedule_pipeline');
  } else if (pipeline && !web) {
    artifactKind = 'data_pipeline';
    runtimeSurface = 'local_node';
    why.push('pipeline');
  } else if (cli && !web && !discord) {
    artifactKind = 'cli_tool';
    runtimeSurface = 'local_node';
    why.push('cli');
  } else if (web && !notWeb && !discord) {
    artifactKind = 'web_spa';
    runtimeSurface = 'browser';
    why.push('web_spa_keywords');
  } else if (notWeb && discord) {
    artifactKind = 'discord_bot';
    runtimeSurface = 'local_node';
    why.push('explicit_not_web_discord');
  }

  if (banOpenClaw && runtimeSurface === 'openclaw') {
    runtimeSurface = 'local_node';
    why.push('force_local_node');
  }

  const dataSources: DataSourceRef[] = matchDomainConnectors(t).map((h) => ({
    id: h.id,
    status: h.status,
    note: h.note,
  }));
  if (dataSources.length) why.push(...dataSources.map((d) => `src_${d.id}`));

  const requiredSecrets: string[] = [];
  if (artifactKind === 'discord_bot' || (discord && runtimeSurface === 'local_node')) {
    const delivery = resolveDeliverySecrets({ message: t, artifactKind: 'discord_bot' });
    requiredSecrets.push(...delivery.secrets);
    why.push(...delivery.why);
    if (/guild|길드|GUILD_ID/i.test(t) && !requiredSecrets.includes('DISCORD_GUILD_ID')) {
      requiredSecrets.push('DISCORD_GUILD_ID');
    }
  }
  requiredSecrets.push(...secretsForDataSources(dataSources));

  const legacyIsolateGlobs: string[] = [];
  if (
    (artifactKind === 'discord_bot'
      || artifactKind === 'scheduled_job'
      || artifactKind === 'data_pipeline'
      || notWeb)
    && (notWeb || /_web_legacy|_legacy/i.test(t))
  ) {
    legacyIsolateGlobs.push(...DEFAULT_WEB_LEGACY_GLOBS, '_web_legacy/**');
    why.push('legacy_web_isolate');
  }

  return emptyArtifactContract({
    artifactKind,
    runtimeSurface,
    dataSources,
    requiredSecrets: [...new Set(requiredSecrets)],
    legacyIsolateGlobs: [...new Set(legacyIsolateGlobs)],
    why,
  });
}

/** Prefer locked non-unknown fields; fill gaps from inferred. */
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

/** Personal Discord / local Node bot — never route to OpenClaw/automaton. */
export function blocksOpenClawAutomatonRoute(message: string): boolean {
  const c = inferArtifactContract(message);
  if (c.runtimeSurface === 'local_node' && (c.artifactKind === 'discord_bot' || PERSONAL_BOT_BAN_OPENCLAW_RE.test(message))) {
    return true;
  }
  if (PERSONAL_BOT_BAN_OPENCLAW_RE.test(message) && DISCORD_BOT_RE.test(message)) return true;
  return false;
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

const WEB_PRODUCT_FILE_RE =
  /(?:^|[/\\])(?:index\.html|app\.js|styles\.css|main\.js|script\.js)$/i;
const BOT_PRODUCT_FILE_RE =
  /(?:^|[/\\])(?:src[/\\](?:discord|looka|report|index)|package\.json|\.env\.example|install-daily-task\.ps1)$/i;

/** Mutated only web SPA files while contract demands bot/job/pipeline. */
export function mutatedPathsViolateArtifactKind(
  contract: ArtifactContract | null | undefined,
  mutatedPaths: string[],
): boolean {
  const c = normalizeArtifactContract(contract);
  if (
    c.artifactKind !== 'discord_bot'
    && c.artifactKind !== 'scheduled_job'
    && c.artifactKind !== 'data_pipeline'
  ) {
    return false;
  }
  const paths = (mutatedPaths || []).map((p) => p.replace(/\\/g, '/'));
  if (!paths.length) return false;
  const webHits = paths.filter((p) => WEB_PRODUCT_FILE_RE.test(p) && !/_web_legacy|_legacy/i.test(p));
  const botHits = paths.filter((p) => BOT_PRODUCT_FILE_RE.test(p));
  return webHits.length > 0 && botHits.length === 0;
}

export function contentSuggestsOpenClawForLocalBot(text: string): boolean {
  const t = String(text || '');
  if (!t.trim()) return false;
  return (
    /(?:OpenClaw|openclaw|\/cqr\/adapter|openclaw-adapter|automaton\s*(?:원격|어댑터))/i.test(t)
    && /(?:Discord|디스코드|봇|게시|길드)/i.test(t)
  );
}

/** Invented concrete organization API presented as fact (not fixture/가정). */
export function contentInventsUnknownDomainApi(
  text: string,
  contract: ArtifactContract | null | undefined,
): boolean {
  const c = normalizeArtifactContract(contract);
  return contentInventsDomainApiFromRegistry(text, c.dataSources);
}

export function contentClaimsLiveChannelPublish(text: string): boolean {
  const t = String(text || '');
  return /(?:Discord|디스코드).{0,40}(?:게시|전송|보냈|올라갔|완료)|(?:채널에\s*(?:올렸|게시|전송)|live\s*post)/i.test(
    t,
  );
}

export function contentMentionsSecretPreflight(
  text: string,
  secrets: string[],
): boolean {
  const t = String(text || '');
  if (!secrets.length) return true;
  if (/\.env\.example|필수\s*env|env\s*체크리스트|채널\s*ID\s*(?:없|미|필요)/i.test(t)) {
    return true;
  }
  let hits = 0;
  for (const s of secrets) {
    if (t.includes(s)) hits += 1;
  }
  return hits >= Math.min(2, secrets.length);
}

export function formatWrongModalityNudge(contract: ArtifactContract): string {
  return [
    'ARTIFACT_CONTRACT: wrong modality mutate.',
    `Locked artifactKind=${contract.artifactKind} runtimeSurface=${contract.runtimeSurface}.`,
    scaffoldHintForContract(contract),
    'Do not keep building a web SPA. Isolate prior web files under _web_legacy/ (do-not-touch) and mutate bot/job paths.',
    'Reply briefly then TOOL_CALL write_file/edit_file on the correct scaffold.',
  ].join('\n');
}

export function formatOpenClawBleedNudge(): string {
  return [
    'ARTIFACT_CONTRACT: runtimeSurface=local_node — OpenClaw/adapter is forbidden for this session.',
    'Implement local Node + Discord Incoming Webhook (DISCORD_WEBHOOK_URL) unless user explicitly asked for Bot Token. Do not suggest OpenClaw.',
    'Continue with TOOL_CALL on local webhook poster files.',
  ].join('\n');
}

export function formatInventedDomainApiNudge(): string {
  return [
    'ARTIFACT_CONTRACT: unknown data source — do not invent REST paths as fact.',
    'Label fixture/가정 schema, or ask one clarification for the real connector documentation.',
    'Rewrite: fixture client + .env.example; no 「실스키마 확정」 claim.',
  ].join('\n');
}

export function formatMissingSecretsNudge(secrets: string[]): string {
  return [
    'ARTIFACT_CONTRACT: requiredSecrets preflight missing before live-publish/done claim.',
    `Checklist: ${secrets.join(', ')}`,
    'Ensure .env.example lists them; if DISCORD_WEBHOOK_URL unknown, stop at dry-run and ask for webhook URL — do not claim 게시 완료.',
  ].join('\n');
}

/** On direction reversal away from web, seed legacy isolate globs. */
export function legacyIsolateForDirectionReversal(
  previous: ArtifactContract | null | undefined,
  nextMessage: string,
): string[] {
  const next = inferArtifactContract(nextMessage);
  const prev = normalizeArtifactContract(previous);
  const leavingWeb =
    prev.artifactKind === 'web_spa'
    || prev.artifactKind === 'unknown'
    || /웹|SPA|index\.html/i.test(String(nextMessage));
  if (
    leavingWeb
    && (next.artifactKind === 'discord_bot'
      || next.artifactKind === 'scheduled_job'
      || next.artifactKind === 'data_pipeline'
      || /웹\s*(?:앱|아님|아니다)|OpenClaw\s*금지/i.test(nextMessage))
  ) {
    return [...DEFAULT_WEB_LEGACY_GLOBS, '_web_legacy/**'];
  }
  return next.legacyIsolateGlobs;
}
