/**
 * Purpose-aware plugin scaffolds (not just echo stubs).
 * Prefer matching shipped templates when purpose maps to one.
 */
import { resolvePluginTemplateId } from './agent-plugin-intent.js';

export type ScaffoldRisk = 'read' | 'write' | 'network';

export type ScaffoldResult = {
  ok: true;
  dry_run: true;
  id: string;
  name: string;
  risk: ScaffoldRisk;
  prefer_template_id?: string;
  recipe: string;
  tool_json: Record<string, unknown>;
  run_source: string;
  next: string;
  note?: string;
};

function readArgsPreamble(): string {
  return `import { readFileSync } from 'node:fs';
import path from 'node:path';

function readArgs() {
  try {
    const raw = readFileSync(0, 'utf8').trim();
    if (!raw) return {};
    const doc = JSON.parse(raw);
    return doc.arguments && typeof doc.arguments === 'object' ? doc.arguments : doc;
  } catch {
    return {};
  }
}

const args = readArgs();
const workspace = process.env.CQR_WORKSPACE_ROOT || process.cwd();
`;
}

function recipeForPurpose(purpose: string): {
  recipe: string;
  parameters: Record<string, unknown>;
  runBody: string;
  risk?: ScaffoldRisk;
} {
  const p = purpose || '';

  if (/줄\s*수|line\s*count|count\s*lines|라인\s*수/i.test(p)) {
    return {
      recipe: 'workspace_line_count',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path' },
        },
        required: ['path'],
      },
      runBody: `${readArgsPreamble()}
const rel = typeof args.path === 'string' ? args.path : '';
if (!rel || rel.includes('..')) {
  console.log(JSON.stringify({ ok: false, error: 'path required, no ..' }));
  process.exit(0);
}
const full = path.resolve(workspace, rel);
if (!full.startsWith(path.resolve(workspace))) {
  console.log(JSON.stringify({ ok: false, error: 'escapes workspace' }));
  process.exit(0);
}
try {
  const text = readFileSync(full, 'utf8');
  const lines = text.length ? text.split(/\\r?\\n/).length : 0;
  console.log(JSON.stringify({ ok: true, path: rel, lines }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
}
`,
    };
  }

  if (/대문자|to\s*upper|upper\s*case|uppercase/i.test(p)) {
    return {
      recipe: 'text_upper',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to uppercase' },
        },
        required: ['text'],
      },
      runBody: `${readArgsPreamble()}
const text = typeof args.text === 'string' ? args.text : '';
console.log(JSON.stringify({ ok: true, text: text.toUpperCase() }, null, 2));
`,
    };
  }

  if (/(?:합|sum|더하|add\s*number|a\s*\+\s*b)/i.test(p)) {
    return {
      recipe: 'calc_sum',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      },
      runBody: `${readArgsPreamble()}
const a = Number(args.a);
const b = Number(args.b);
if (!Number.isFinite(a) || !Number.isFinite(b)) {
  console.log(JSON.stringify({ ok: false, error: 'a and b must be numbers' }));
  process.exit(0);
}
console.log(JSON.stringify({ ok: true, sum: a + b }, null, 2));
`,
    };
  }

  if (/\.md|markdown|md\s*파일|마크다운\s*목록/i.test(p)) {
    return {
      recipe: 'list_md',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Dir under workspace (default .)' },
        },
      },
      runBody: `${readArgsPreamble()}
import { readdirSync, statSync } from 'node:fs';
const rel = typeof args.path === 'string' && args.path.trim() ? args.path : '.';
const full = path.resolve(workspace, rel);
if (!full.startsWith(path.resolve(workspace))) {
  console.log(JSON.stringify({ ok: false, error: 'escapes workspace' }));
  process.exit(0);
}
try {
  const names = readdirSync(full)
    .filter((n) => /\\.md$/i.test(n))
    .slice(0, 100);
  console.log(JSON.stringify({ ok: true, path: rel, markdown: names }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
}
`,
    };
  }

  if (/json\s*키|keys\s*of\s*json|object\s*keys/i.test(p)) {
    return {
      recipe: 'json_keys',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'JSON file under workspace' },
        },
        required: ['path'],
      },
      runBody: `${readArgsPreamble()}
const rel = typeof args.path === 'string' ? args.path : '';
if (!rel || rel.includes('..')) {
  console.log(JSON.stringify({ ok: false, error: 'path required' }));
  process.exit(0);
}
const full = path.resolve(workspace, rel);
if (!full.startsWith(path.resolve(workspace))) {
  console.log(JSON.stringify({ ok: false, error: 'escapes workspace' }));
  process.exit(0);
}
try {
  const doc = JSON.parse(readFileSync(full, 'utf8'));
  const keys = doc && typeof doc === 'object' && !Array.isArray(doc) ? Object.keys(doc) : [];
  console.log(JSON.stringify({ ok: true, path: rel, keys }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
}
`,
    };
  }

  // Default: still echo but flags rewrite expectation + purpose echo
  return {
    recipe: 'echo_purpose',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Optional payload' },
        path: { type: 'string', description: 'Optional relative path if you extend the plugin' },
      },
    },
    runBody: `${readArgsPreamble()}
const message = typeof args.message === 'string' ? args.message : 'hello-plugin';
console.log(JSON.stringify({
  ok: true,
  plugin: process.env.CQR_PLUGIN_NAME || 'plugin',
  purpose_hint: ${JSON.stringify(p.slice(0, 200))},
  message,
  note: 'generic scaffold — replace run.mjs for real logic if needed',
}, null, 2));
`,
  };
}

function isValidId(id: string): boolean {
  return /^[a-z][a-z0-9_]{1,55}$/.test(id);
}

export function buildPurposeAwareScaffold(input: {
  id?: string;
  purpose?: string;
  risk?: ScaffoldRisk;
}): ScaffoldResult {
  const purpose = String(input.purpose ?? 'Echo args for smoke testing').slice(0, 500);
  const idRaw = String(input.id ?? 'custom_tool')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');
  const id = isValidId(idRaw) ? idRaw : 'custom_tool';
  const name = `plugin_${id}`;

  // Prefer shipping template when purpose matches known blueprint
  const prefer = resolvePluginTemplateId(purpose);
  if (prefer) {
    const risk: ScaffoldRisk =
      input.risk === 'write' || input.risk === 'network' ? input.risk : 'read';
    return {
      ok: true,
      dry_run: true,
      id: prefer,
      name: `plugin_${prefer}`,
      risk,
      prefer_template_id: prefer,
      recipe: 'prefer_shipped_template',
      tool_json: {
        name: `plugin_${prefer}`,
        description: purpose,
        parameters: { type: 'object', properties: {} },
        runner: { kind: 'node', entry: 'run.mjs', timeout_ms: 30_000 },
        risk,
        enabled: true,
      },
      run_source: '',
      next: `Do NOT freeform-install. Call plugin_install with template_id=${prefer} confirm=true, then call plugin_${prefer}.`,
      note: `Purpose matches shipped template ${prefer} — use template_id install (HITL-free confirm=true).`,
    };
  }

  const built = recipeForPurpose(purpose);
  const risk: ScaffoldRisk =
    input.risk === 'write' || input.risk === 'network'
      ? input.risk
      : built.risk || 'read';

  const toolJson = {
    name,
    description: purpose.slice(0, 500),
    parameters: built.parameters,
    runner: { kind: 'node', entry: 'run.mjs', timeout_ms: 30_000 },
    risk,
    enabled: true,
  };

  const runSource = `// CQR local plugin: ${name} (recipe=${built.recipe})
// stdin: {"arguments":{...}}
${built.runBody}`;

  return {
    ok: true,
    dry_run: true,
    id,
    name,
    risk,
    recipe: built.recipe,
    tool_json: toolJson,
    run_source: runSource,
    next:
      built.recipe === 'echo_purpose'
        ? 'Show purpose+risk to user. Freeform install needs UI Accept. Or refine purpose and re-scaffold for a better recipe.'
        : 'Show purpose+risk to user. Freeform install needs UI Accept (HITL). Then plugin_install confirm=true with tool_json+run_source and call the plugin.',
    note:
      built.recipe === 'echo_purpose'
        ? 'Fallback scaffold — narrow purpose (line count / sum / upper / md list / json keys) for a real recipe, or install a matching template.'
        : `Purpose-aware recipe: ${built.recipe}`,
  };
}
