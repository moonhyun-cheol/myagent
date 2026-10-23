import os from 'node:os';
import path from 'node:path';

/**
 * Fixed terminal risk tiers (applied before and independent of the decision model).
 *
 * - blocked:  never runs, even with approval (disk format, wiping a drive root, the
 *             workspace root or the user's home folder).
 * - git_tool: git state changes go through the dedicated git_* tools (not a risk call).
 * - severe:   recursive folder delete / database destruction. Runs only after approval of
 *             this exact command; the decision model may approve it only when the user
 *             explicitly commanded it (see approval-auto-review `fixedSeverity`).
 * - normal:   everything else; the decision model judges it as before.
 */
export type TerminalRiskTier = 'blocked' | 'git_tool' | 'severe' | 'normal';

export interface TerminalRisk {
  tier: TerminalRiskTier;
  reason: string;
}

/** Rebuildable output: wiping these trees is routine (normal), not severe. */
const REBUILDABLE_DIRS = new Set([
  'dist', 'build', 'out', 'node_modules', '.tmp', 'tmp', 'temp', '.cache', 'cache', 'coverage',
  '.next', '.nuxt', '.turbo', '.vite', '.parcel-cache', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', '.playwright',
]);

const DISK_FORMAT_RE = /(?:^|[;&|]\s*)format(?:\.com)?(?:\s+[A-Za-z]:|\s+\/|$)/i;

const GIT_TOOL_RE = /\bgit\s+(?:push|pull|fetch|reset|clean|commit|checkout|switch|stash|restore|add|rebase|merge|cherry-pick|revert|rm|mv|tag\s+-d)\b/i;
/** `git branch` is fine for listing; create/delete/rename goes through git_branch. */
const GIT_BRANCH_RE = /\bgit\s+branch\b([^;&|]*)/i;
const GIT_BRANCH_LIST_FLAGS = /^(?:-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--verbose|--no-color|--color|--merged|--no-merged|--contains|--sort=\S+|--format=\S+)$/i;

const DB_DESTROY_RES: RegExp[] = [
  /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+(?:TABLE\s+)?[\w."`[\]]+/i,
  // DELETE without WHERE wipes every row.
  /\bDELETE\s+FROM\s+[\w."`[\]]+\s*(?:;|$|["'`)])/i,
  // UPDATE without WHERE overwrites every row (e.g. SET content='').
  /\bUPDATE\s+[\w."`[\]]+\s+SET\b(?:(?!\bWHERE\b)[^;])*(?:;|$)/i,
  /\bdropDatabase\s*\(/i,
  /\bFLUSHALL\b|\bFLUSHDB\b/i,
  /\bprisma\s+(?:migrate\s+reset|db\s+push\s+[^;&|]*--force-reset)\b/i,
];
const DB_FILE_RE = /\.(?:db|sqlite|sqlite3|mdf|ldf)(?:["'\s,;)]|$)/i;

/**
 * Public inspect clones under `.my_agent_remote/` may deepen history / read git metadata via shell.
 * Bound-workspace write/sync still uses dedicated git_* tools (bare `git fetch` stays blocked).
 */
export function isAllowedCqrRemoteInspectGitShell(command: string): boolean {
  const t = String(command || '').trim();
  if (!t || !/\.my_agent_remote[/\\]/i.test(t)) return false;
  // Prefer `git -C .my_agent_remote/<owner>__<repo> …`
  const viaDashC =
    /^git\s+-C\s+(?:["'][^"']*\.my_agent_remote[^"']*["']|\.my_agent_remote[/\\][^\s"';|&]+)\s+/i.test(t);
  if (!viaDashC) return false;
  // Read / deepen only — no push/reset/commit/clean.
  return (
    /\bfetch\s+--unshallow\b/i.test(t)
    || /\bfetch\s+(?:--all\b|(?:--tags\b)|(?:--prune\b))/i.test(t)
    || /\b(?:rev-parse|rev-list|log|shortlog|status|remote|tag|diff|show|blame|branch)\b/i.test(t)
  );
}

function splitSegments(command: string): string[] {
  return command.split(/\s*(?:;|&&|\|\||\||\r?\n)\s*/).map((s) => s.trim()).filter(Boolean);
}

/** Strip a `cmd /c`, `&` or `powershell -Command "` wrapper so the delete verb leads. */
function unwrapSegment(segment: string): string {
  let s = segment.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = s
      .replace(/^&\s*/, '')
      .replace(/^cmd(?:\.exe)?\s+\/[ck]\s+/i, '')
      .replace(/^(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*?(?:-c(?:ommand)?\s+)?["']?/i, '')
      .replace(/^\(\s*/, '')
      .trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

const POWERSHELL_RECURSE_RE = /\s-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?=\s|$|:)/i;
/** bash-style short flags (-r, -rf, -fr, -Rf); `-Force` is excluded by the length cap. */
const SHORT_RECURSE_RE = /\s-(?=[a-zA-Z]{0,2}[rR])[a-zA-Z]{1,3}(?=\s|$)|\s--recursive\b/;

interface DeleteSegment {
  targets: string[];
}

function parseRecursiveDelete(segment: string): DeleteSegment | null {
  const s = unwrapSegment(segment);
  const m = /^(Remove-Item|ri|rm|rmdir|rd|del|erase|rimraf|npx\s+rimraf|npx\s+del-cli)\b(.*)$/i.exec(s);
  if (m) {
    const verb = m[1].toLowerCase();
    const rest = m[2] ?? '';
    const cmdStyle = (verb === 'rmdir' || verb === 'rd' || verb === 'del' || verb === 'erase') && /\s\/s\b/i.test(rest);
    const psStyle = POWERSHELL_RECURSE_RE.test(rest) || SHORT_RECURSE_RE.test(rest);
    const alwaysRecursive = /rimraf|del-cli/.test(verb);
    if (!cmdStyle && !psStyle && !alwaysRecursive) return null;
    return { targets: deleteTargets(rest) };
  }
  // Programmatic recursive deletes: judge by the quoted paths when present.
  if (
    /\bshutil\.rmtree\s*\(/i.test(s)
    || /\bfs(?:\.promises)?\.(?:rm|rmSync|rmdir|rmdirSync)\s*\([^)]*recursive\s*:\s*true/i.test(s)
    || /\b(?:\[(?:System\.)?IO\.Directory\]::|Directory\.)Delete\s*\([^)]*\$?true\s*\)/i.test(s)
  ) {
    const quoted = [...s.matchAll(/(["'])([^"']+)\1/g)].map((q) => q[2]).filter((q) => /[\\/.\w]/.test(q) && !/\s/.test(q));
    return { targets: quoted };
  }
  return null;
}

const PS_ENUM_VALUE = /^(?:SilentlyContinue|Stop|Continue|Ignore|Inquire|Suspend|\$true|\$false)$/i;
const PS_PARAM_WITH_VALUE = /^-(?:ErrorAction|ea|Include|Exclude|Filter|WarningAction|wa|Credential|Stream)$/i;

function deleteTargets(rest: string): string[] {
  const tokens = [...rest.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((t) => ({
    value: t[1] ?? t[2] ?? t[3] ?? '',
    quoted: t[1] !== undefined || t[2] !== undefined,
  }));
  const targets: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const { value, quoted } = tokens[i];
    if (!quoted && PS_PARAM_WITH_VALUE.test(value)) { i += 1; continue; }
    if (!quoted && /^-/.test(value)) continue;
    if (!quoted && /^\/[a-zA-Z]$/.test(value)) continue;
    if (!quoted && (PS_ENUM_VALUE.test(value) || /^[>2&]/.test(value))) continue;
    for (const part of value.split(',')) {
      const p = part.trim();
      if (p) targets.push(p);
    }
  }
  return targets;
}

function normalizeTarget(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, '').replace(/[\\/]+\*?$/, '').replace(/\\/g, '/');
}

function isRootLikeTarget(raw: string, workspaceRoot: string): boolean {
  const t = raw.trim().replace(/^["']|["']$/g, '');
  if (/^(?:\.|\.[\\/]|\*|\.[\\/]\*|[\\/]|[\\/]\*|~|~[\\/]|~[\\/]\*|\*\.\*)$/.test(t)) return true;
  if (/^(?:\$HOME|\$env:USERPROFILE|\$env:HOMEDRIVE|\$env:SystemDrive|%USERPROFILE%|%HOMEDRIVE%|%SystemDrive%|\$env:HOMEPATH|%HOMEPATH%)(?:[\\/]\*?)?$/i.test(t)) return true;
  if (/^[A-Za-z]:(?:[\\/]\*?)?$/.test(t)) return true;
  const norm = (p: string) => path.win32.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
  if (/^[A-Za-z]:[\\/]/.test(t)) {
    const target = norm(t.replace(/[\\/]\*$/, ''));
    if (workspaceRoot && target === norm(workspaceRoot)) return true;
    try {
      if (target === norm(os.homedir())) return true;
    } catch {
      // homedir unavailable: only the literal root forms above apply.
    }
  }
  return false;
}

function isRebuildableTarget(raw: string): boolean {
  const t = normalizeTarget(raw);
  if (!t) return false;
  if (/^(?:\$env:TEMP|\$env:TMP|%TEMP%|%TMP%)(?:\/|$)/i.test(t)) return true;
  return t.split('/').some((part) => REBUILDABLE_DIRS.has(part.toLowerCase()));
}

function gitBranchNeedsTool(command: string): boolean {
  const m = GIT_BRANCH_RE.exec(command);
  if (!m) return false;
  const args = (m[1] ?? '').trim().split(/\s+/).filter(Boolean);
  return args.some((a) => !GIT_BRANCH_LIST_FLAGS.test(a));
}

export function classifyTerminalCommand(command: string, workspaceRoot = ''): TerminalRisk {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) return { tier: 'normal', reason: '' };
  if (DISK_FORMAT_RE.test(trimmed)) return { tier: 'blocked', reason: 'disk format' };

  let severeReason = '';
  for (const segment of splitSegments(trimmed)) {
    const del = parseRecursiveDelete(segment);
    if (!del) continue;
    if (del.targets.some((t) => isRootLikeTarget(t, workspaceRoot))) {
      return { tier: 'blocked', reason: 'recursive delete of a drive root, the workspace root or the home folder' };
    }
    if (!del.targets.length || !del.targets.every(isRebuildableTarget)) {
      severeReason ||= 'recursive folder delete';
    }
  }

  if (!isAllowedCqrRemoteInspectGitShell(trimmed) && (GIT_TOOL_RE.test(trimmed) || gitBranchNeedsTool(trimmed))) {
    return { tier: 'git_tool', reason: 'git state change — use the dedicated git_* tools' };
  }

  if (!severeReason) {
    if (DB_DESTROY_RES.some((re) => re.test(trimmed))) severeReason = 'database destruction (DROP/TRUNCATE/DELETE or UPDATE without WHERE)';
    else if (splitSegments(trimmed).some((seg) => {
      const s = unwrapSegment(seg);
      return /^(?:Remove-Item|ri|rm|del|erase)\b/i.test(s) && DB_FILE_RE.test(s);
    })) severeReason = 'database file delete';
  }
  if (severeReason) return { tier: 'severe', reason: severeReason };
  return { tier: 'normal', reason: '' };
}
