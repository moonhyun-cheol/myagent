/**
 * Bind the agent cwd to the selected project folder — not the parent bag
 * (e.g. C:\\app) and not a sibling like my_agent / vari6.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export type WorkspaceLockStatus =
  | 'session'
  | 'child'
  | 'path'
  | 'editor'
  | 'reuse'
  | 'need_pick';

export type WorkspaceLock = {
  sessionRoot: string;
  targetRoot: string;
  status: WorkspaceLockStatus;
  children: string[];
  matchedName?: string;
  narrowed: boolean;
};

const PROJECT_MARKERS = [
  'package.json',
  'manifest.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  '.git',
];

const SYN: Array<[RegExp, string]> = [
  [/익스탠션|익스텐션|확장\s*프로그램|\bextension\b/gi, ' extension '],
  [/전체\s*화면|풀\s*페이지|full[\s-]*page/gi, ' full page '],
  [/캡쳐|캡처|스크린\s*샷|\bscreenshot\b/gi, ' screenshot '],
  [/\bchrome\b|크롬/gi, ' chrome '],
];

function pathKey(target: string): string {
  return path.resolve(target).replace(/\//g, '\\').toLowerCase();
}

function underRoot(root: string, target: string): boolean {
  const r = pathKey(root);
  const t = pathKey(target);
  if (t === r) return true;
  const prefix = r.endsWith('\\') ? r : `${r}\\`;
  return t.startsWith(prefix);
}

export function listImmediateChildDirs(root: string): string[] {
  const abs = path.resolve(root);
  if (!existsSync(abs)) return [];
  try {
    return readdirSync(abs)
      .filter((name) => {
        if (!name || name === '.' || name === '..') return false;
        if (name.startsWith('.')) return false;
        try {
          return statSync(path.join(abs, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function looksLikeProjectDir(root: string, name: string): boolean {
  const dir = path.join(root, name);
  return PROJECT_MARKERS.some((m) => existsSync(path.join(dir, m)));
}

/** Unstructured bag of sibling projects (C:\\app + amazon-cq-code + my_agent + …). */
export function isProjectBag(root: string): boolean {
  const kids = listImmediateChildDirs(root);
  const projectish = kids.filter((n) => looksLikeProjectDir(root, n));
  if (projectish.length >= 2) return true;
  return kids.length >= 3 && projectish.length >= 1;
}

function tokenize(raw: string): string[] {
  let t = ` ${raw} `;
  for (const [re, rep] of SYN) t = t.replace(re, rep);
  return t
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/u)
    .filter((w) => w.length >= 2);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Score how well a child folder name matches the user message (0–100). */
export function scoreChildName(childName: string, message: string): number {
  const name = String(childName || '').trim();
  const msg = String(message || '');
  if (!name || !msg.trim()) return 0;
  if (msg.toLowerCase().includes(name.toLowerCase())) return 100;
  if (name.length <= 3) {
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(name)}(?:$|[^a-z0-9])`, 'i');
    return re.test(msg) ? 100 : 0;
  }
  const childTokens = tokenize(name);
  if (!childTokens.length) return 0;
  const msgTokens = new Set(tokenize(msg));
  const hit = childTokens.filter((tok) => msgTokens.has(tok)).length;
  return Math.round((hit / childTokens.length) * 100);
}

export function pickChildName(childNames: string[], message: string): string | null {
  const names = childNames.filter((n) => String(n || '').trim());
  if (!names.length) return null;
  const ranked = names
    .map((name) => ({ name, score: scoreChildName(name, message) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 67) return null;
  const second = ranked[1];
  if (second && second.score >= best.score) return null;
  return best.name;
}

export function nearestChildRoot(sessionRoot: string, absPath: string): string | null {
  if (!sessionRoot?.trim() || !absPath?.trim()) return null;
  const root = path.resolve(sessionRoot);
  const target = path.resolve(absPath);
  if (!underRoot(root, target)) return null;
  const rel = path.relative(root, target);
  if (!rel || rel === '.') return root;
  const first = rel.split(/[\\/]/)[0];
  if (!first) return root;
  const child = path.resolve(root, first);
  return existsSync(child) ? child : null;
}

function existingDirOrParent(raw: string | null | undefined): string | null {
  const p = String(raw || '').trim();
  if (!p || !existsSync(p)) return null;
  try {
    const st = statSync(p);
    if (st.isDirectory()) return path.resolve(p);
    return path.resolve(path.dirname(p));
  } catch {
    return null;
  }
}

export function formatWorkspaceLockNote(lock: WorkspaceLock): string {
  const siblings = lock.children.filter(
    (n) => n.toLowerCase() !== (lock.matchedName || path.basename(lock.targetRoot)).toLowerCase(),
  );
  const lines = [
    '[WORKSPACE_LOCK]',
    `target=${path.resolve(lock.targetRoot)}`,
    `session_root=${path.resolve(lock.sessionRoot)}`,
    `status=${lock.status}`,
  ];
  if (lock.narrowed) {
    lines.push(
      'Work only inside target. Do not read/edit sibling folders.',
      'Do not apply MY Agent product paths (ui/workspace, shell, deploy/output, npm run build at CQR root).',
    );
    if (siblings.length) {
      lines.push(`siblings_off_limits: ${siblings.slice(0, 16).join(', ')}`);
    }
  }
  return lines.join('\n');
}

export function formatNeedPickReply(lock: WorkspaceLock): string {
  const kids = lock.children.length
    ? lock.children.map((n) => `- ${n}`).join('\n')
    : '- (하위 폴더 없음)';
  return [
    '이 작업 폴더 아래에 **여러 프로젝트가 같이** 있습니다. 어느 폴더를 잠글까요?',
    '',
    kids,
    '',
    '예: `full page screenshot 검토해줘`',
    '형제 폴더를 한 제품으로 묶거나 MY Agent 빌드 경로를 쓰지 않습니다.',
  ].join('\n');
}

export function resolveTurnWorkspaceLock(opts: {
  sessionRoot: string;
  pathHint?: string | null;
}): WorkspaceLock {
  const sessionRoot = path.resolve(opts.sessionRoot);
  const children = listImmediateChildDirs(sessionRoot);
  const base = (): WorkspaceLock => ({
    sessionRoot,
    targetRoot: sessionRoot,
    status: 'session',
    children,
    narrowed: false,
  });

  // Only an explicit structured path may narrow the execution root. The user
  // message and active editor file are context, never cwd-selection inputs.
  const pathDir = existingDirOrParent(opts.pathHint);
  if (pathDir && underRoot(sessionRoot, pathDir)) {
    const child = nearestChildRoot(sessionRoot, pathDir);
    if (child && pathKey(child) !== pathKey(sessionRoot)) {
      return {
        sessionRoot,
        targetRoot: child,
        status: 'path',
        children,
        matchedName: path.basename(child),
        narrowed: true,
      };
    }
  }

  return base();
}
