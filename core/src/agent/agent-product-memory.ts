/**
 * Product memory (E): AGENTS.md + build-generated product-facts.json.
 * MY Agent self-edit only — never inject into external dev workspaces.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type ProductRouteFact = {
  method: string;
  path: string;
  match: 'exact' | 'prefix';
};

export type ProductFacts = {
  version: number;
  generated_at?: string;
  note?: string;
  layout?: {
    primary_ui?: string | null;
    shell?: string | null;
    core_src?: string | null;
    api_dispatch?: string | null;
    rulebook?: string | null;
    agents_md?: string | null;
    ui_facts?: string | null;
  };
  memory_files?: string[];
  api?: {
    source?: string;
    roots?: string[];
    route_count?: number;
    routes?: ProductRouteFact[];
  };
};

/** Windows-safe key for comparing roots (case + separators). */
function pathKey(target: string): string {
  return path.resolve(target).replace(/\//g, '\\').toLowerCase();
}

/**
 * True when the agent workspace is the MY Agent tree (or a folder inside it).
 * External projects (e.g. C:\\app\\vari6) must not receive CQR product memory.
 */
export function isSelfWorkspace(workspaceRoot: string, cqrRoot: string): boolean {
  if (!workspaceRoot?.trim() || !cqrRoot?.trim()) return false;
  const ws = pathKey(workspaceRoot);
  const cqr = pathKey(cqrRoot);
  if (ws === cqr) return true;
  const prefix = cqr.endsWith('\\') ? cqr : `${cqr}\\`;
  return ws.startsWith(prefix);
}

export function loadProductFacts(cqrRoot: string): ProductFacts | null {
  const candidates = [
    path.join(cqrRoot, 'core', 'config', 'defaults', 'product-facts.json'),
    path.join(cqrRoot, 'core', 'dist', 'config', 'defaults', 'product-facts.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as ProductFacts;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function loadAgentsMd(root: string, maxChars = 3500): string {
  const p = path.join(root, 'AGENTS.md');
  if (!existsSync(p)) return '';
  try {
    const raw = readFileSync(p, 'utf8').trim();
    if (!raw) return '';
    return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…` : raw;
  } catch {
    return '';
  }
}

/** Compact system-prompt block from product facts + AGENTS.md. */
export function formatProductMemoryForPrompt(
  facts: ProductFacts | null,
  agentsMd: string,
): string {
  const lines: string[] = ['', '## Product memory (build + AGENTS.md — prefer over guesswork)'];
  if (facts?.generated_at) lines.push(`product_facts_at: ${facts.generated_at}`);

  const L = facts?.layout ?? {};
  if (L.primary_ui || L.shell || L.api_dispatch) {
    lines.push(
      [
        'layout:',
        L.primary_ui ? `  primary_ui=${L.primary_ui}` : '',
        L.shell ? `  shell=${L.shell}` : '',
        L.api_dispatch ? `  api=${L.api_dispatch}` : '',
        L.rulebook ? `  rulebook=${L.rulebook}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  const roots = facts?.api?.roots?.slice(0, 24) ?? [];
  if (roots.length) {
    lines.push(`api_roots: ${roots.join(' ')}`);
  }
  const routes = facts?.api?.routes ?? [];
  if (routes.length) {
    const sample = routes
      .slice(0, 28)
      .map((r) => `${r.method} ${r.path}${r.match === 'prefix' ? '*' : ''}`)
      .join(', ');
    lines.push(
      `api_routes (${facts?.api?.route_count ?? routes.length}): ${sample}${
        (facts?.api?.route_count ?? routes.length) > 28 ? ', …' : ''
      }`,
    );
  }

  lines.push(
    'RULE: Do not invent API paths or UI layout. Prefer product-facts.json / ui-facts.json / read_file.',
  );

  if (agentsMd.trim()) {
    lines.push('', '### AGENTS.md', agentsMd.trim());
  }

  return lines.filter((l, i) => !(i === 0 && l === '')).join('\n');
}

/** External workspace: no CQR layout paths; optional target-project AGENTS.md only. */
export function formatExternalWorkspaceMemory(agentsMd: string): string {
  const lines: string[] = [
    '',
    '## Target workspace memory (external project)',
    'Dev workspace is NOT the MY Agent product tree.',
    'Do NOT cite MY Agent paths (ui/workspace, shell/CqrPa.Shell, ChatPane.tsx, MainWindow.xaml,',
    'core/config/defaults/ui-facts.json, product-facts.json).',
    'Discover files via Repository map / search / read_file (workspace = chat context; absolute/UNC paths OK when the user points outside).',
  ];
  if (agentsMd.trim()) {
    lines.push('', '### Workspace AGENTS.md', agentsMd.trim());
  }
  return lines.join('\n');
}

export type ScopedProductMemory = {
  selfWorkspace: boolean;
  /** Prompt block (CQR product memory or external note). */
  promptBlock: string;
  productFacts: ProductFacts | null;
  agentsMd: string;
};

/** Load memory scoped to whether the agent is editing MY Agent itself. */
export function resolveScopedProductMemory(
  cqrRoot: string,
  workspaceRoot: string,
): ScopedProductMemory {
  const selfWorkspace = isSelfWorkspace(workspaceRoot, cqrRoot);
  if (selfWorkspace) {
    const productFacts = loadProductFacts(cqrRoot);
    const agentsMd = loadAgentsMd(cqrRoot);
    return {
      selfWorkspace: true,
      productFacts,
      agentsMd,
      promptBlock: formatProductMemoryForPrompt(productFacts, agentsMd),
    };
  }
  const agentsMd = loadAgentsMd(workspaceRoot);
  return {
    selfWorkspace: false,
    productFacts: null,
    agentsMd,
    promptBlock: formatExternalWorkspaceMemory(agentsMd),
  };
}

/** Strip `<!-- MY_AGENT_SELF_BEGIN -->…<!-- MY_AGENT_SELF_END -->` from skill prompts for external WS. */
export function stripCqrSelfSkillSections(prompt: string): string {
  if (!prompt.includes('MY_AGENT_SELF_BEGIN')) return prompt;
  return prompt
    .replace(
      /<!--\s*MY_AGENT_SELF_BEGIN\s*-->[\s\S]*?<!--\s*MY_AGENT_SELF_END\s*-->/g,
      '',
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function productFactsHasRoute(
  facts: ProductFacts | null,
  method: string,
  routePath: string,
): boolean {
  if (!facts?.api?.routes?.length) return false;
  const m = method.toUpperCase();
  return facts.api.routes.some(
    (r) => r.method === m && (r.path === routePath || routePath.startsWith(r.path)),
  );
}
