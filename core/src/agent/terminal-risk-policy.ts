import os from 'node:os';
import path from 'node:path';

/**
 * Fixed terminal risk tiers (applied before and independent of the decision model).
 *
 * - blocked:  never runs, even with approval (disk format, wiping a drive root, the
 *             workspace root or the user's home folder, force push).
 * - severe:   recursive folder delete / database destruction / hard-to-undo git (push,
 *             reset --hard, clean, discarding checkout/restore, branch -D, ...). Runs only
 *             after approval of this exact command; the decision model may approve it only
 *             when the user explicitly commanded it (see approval-auto-review `fixedSeverity`).
 * - normal:   everything else; the decision model judges it as before.
 *
 * Git is classified by its parsed subcommand (global options such as `-C`, `-c`,
 * `--git-dir` are skipped; `git.exe` and full paths count), not by a substring match.
 * The dedicated git_* tools remain the preferred path for the bound workspace repo.
 */
export type TerminalRiskTier = 'blocked' | 'severe' | 'normal';

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

// ── git: parsed subcommand → fixed tier ─────────────────────────────────────────────

/** Global git options that take the next token as their value (`-C dir`, `-c k=v`). */
const GIT_GLOBAL_OPTS_WITH_VALUE = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix',
  '--exec-path', '--list-cmds', '--attr-source',
]);

interface ShellToken {
  value: string;
  quoted: boolean;
}

function tokenizeShell(s: string): ShellToken[] {
  return [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((t) => ({
    value: (t[1] ?? t[2] ?? t[3] ?? '').replace(/^["'(]+|["')]+$/g, ''),
    quoted: t[1] !== undefined || t[2] !== undefined,
  }));
}

function isGitExecutable(token: string): boolean {
  const base = token.split(/[\\/]/).pop() ?? '';
  return /^git(?:\.exe)?$/i.test(base);
}

export interface GitInvocation {
  /** Lower-cased subcommand after global options ('' when none). */
  subcommand: string;
  args: string[];
  /** `-c alias.x=...` defines the subcommand inline, so it cannot be classified. */
  inlineAlias: boolean;
}

/**
 * Find git invocations in a shell command: one per segment, wrappers (`&`, `cmd /c`,
 * `powershell -Command`) and quoted inner commands included.
 */
export function parseGitInvocations(command: string, depth = 0): GitInvocation[] {
  const out: GitInvocation[] = [];
  for (const segment of splitSegments(command)) {
    const tokens = tokenizeShell(unwrapSegment(segment));
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i];
      // A quoted path to git.exe is the executable; other quoted text may be an inner command.
      if (tok.quoted && /\s/.test(tok.value) && !isGitExecutable(tok.value)) {
        if (depth < 2) out.push(...parseGitInvocations(tok.value, depth + 1));
        continue;
      }
      if (!isGitExecutable(tok.value)) continue;
      let j = i + 1;
      let inlineAlias = false;
      while (j < tokens.length && tokens[j].value.startsWith('-')) {
        const opt = tokens[j].value;
        const name = opt.split('=')[0];
        if (GIT_GLOBAL_OPTS_WITH_VALUE.has(name) && !opt.includes('=')) {
          if (name === '-c' && /^alias\./i.test(tokens[j + 1]?.value ?? '')) inlineAlias = true;
          j += 2;
        } else {
          if (/^--config-env=alias\./i.test(opt)) inlineAlias = true;
          j += 1;
        }
      }
      out.push({
        subcommand: (tokens[j]?.value ?? '').toLowerCase(),
        args: tokens.slice(j + 1).map((t) => t.value),
        inlineAlias,
      });
      // Arguments after the subcommand (commit messages etc.) are not commands.
      break;
    }
  }
  return out;
}

function hasLongFlag(args: string[], ...names: string[]): boolean {
  return args.some((a) => names.includes(a.split('=')[0]));
}

/** `-f`, `-fu`, `-Df` … (case-sensitive: `-D` ≠ `-d`). */
function hasShortFlag(args: string[], letter: string): boolean {
  return args.some((a) => /^-[A-Za-z]+$/.test(a) && a.slice(1).includes(letter));
}

function gitInvocationRisk(inv: GitInvocation): TerminalRisk | null {
  if (inv.inlineAlias) return { tier: 'severe', reason: 'git alias defined inline' };
  const { subcommand: sub, args } = inv;
  switch (sub) {
    case 'push': {
      if (
        hasLongFlag(args, '--force', '--force-with-lease', '--force-if-includes', '--mirror')
        || hasShortFlag(args, 'f')
        || args.some((a) => a.startsWith('+'))
      ) {
        return { tier: 'blocked', reason: 'git force push' };
      }
      if (hasLongFlag(args, '--delete', '--prune') || hasShortFlag(args, 'd') || args.some((a) => a.startsWith(':'))) {
        return { tier: 'severe', reason: 'git push deleting a remote ref' };
      }
      return { tier: 'severe', reason: 'git push' };
    }
    case 'reset':
      return hasLongFlag(args, '--hard', '--merge', '--keep') ? { tier: 'severe', reason: 'git reset --hard' } : null;
    case 'clean':
      return hasLongFlag(args, '--dry-run') || hasShortFlag(args, 'n') ? null : { tier: 'severe', reason: 'git clean' };
    case 'checkout':
      return args.includes('--') || args.includes('.') || hasLongFlag(args, '--force') || hasShortFlag(args, 'f')
        ? { tier: 'severe', reason: 'git checkout discarding working-tree changes' }
        : null;
    case 'restore': {
      const staged = hasLongFlag(args, '--staged') || hasShortFlag(args, 'S');
      const worktree = hasLongFlag(args, '--worktree') || hasShortFlag(args, 'W');
      return staged && !worktree ? null : { tier: 'severe', reason: 'git restore discarding working-tree changes' };
    }
    case 'switch':
      return hasLongFlag(args, '--force', '--discard-changes') || hasShortFlag(args, 'f')
        ? { tier: 'severe', reason: 'git switch discarding changes' }
        : null;
    case 'stash':
      return ['drop', 'clear', 'pop'].includes((args[0] ?? '').toLowerCase())
        ? { tier: 'severe', reason: `git stash ${args[0].toLowerCase()}` }
        : null;
    case 'branch':
      return hasShortFlag(args, 'D') || hasShortFlag(args, 'M') || hasShortFlag(args, 'C') || hasShortFlag(args, 'f')
        || hasLongFlag(args, '--force')
        ? { tier: 'severe', reason: 'git branch force delete/overwrite' }
        : null;
    case 'tag':
      return hasShortFlag(args, 'd') || hasShortFlag(args, 'f') || hasLongFlag(args, '--delete', '--force')
        ? { tier: 'severe', reason: 'git tag delete/overwrite' }
        : null;
    case 'update-ref':
      return hasShortFlag(args, 'd') ? { tier: 'severe', reason: 'git update-ref -d' } : null;
    case 'reflog':
      return ['expire', 'delete'].includes((args[0] ?? '').toLowerCase()) ? { tier: 'severe', reason: 'git reflog expire/delete' } : null;
    case 'gc':
      return args.some((a) => a.startsWith('--prune')) ? { tier: 'severe', reason: 'git gc --prune' } : null;
    case 'filter-branch':
    case 'filter-repo':
      return { tier: 'severe', reason: `git ${sub}` };
    case 'worktree':
      return (args[0] ?? '').toLowerCase() === 'remove' && (hasLongFlag(args, '--force') || hasShortFlag(args, 'f'))
        ? { tier: 'severe', reason: 'git worktree remove --force' }
        : null;
    default:
      return null;
  }
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

  for (const inv of parseGitInvocations(trimmed)) {
    const risk = gitInvocationRisk(inv);
    if (!risk) continue;
    if (risk.tier === 'blocked') return risk;
    severeReason ||= risk.reason;
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
