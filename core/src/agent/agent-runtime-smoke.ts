/**
 * Deterministic runtime/UI wiring smoke — beyond disk markers alone.
 * Probes HTML id ↔ JS getElementById / querySelector('#…') consistency
 * for mutated web assets (catches empty #deviceProfileButtons-style bugs).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type RuntimeSmokeResult = {
  applicable: boolean;
  ok: boolean;
  missing: string[];
  notes: string[];
};

const WEB_EXT_RE = /\.(?:html?|js|mjs|cjs|css)$/i;
const JS_EXT_RE = /\.(?:js|mjs|cjs)$/i;
const HTML_EXT_RE = /\.html?$/i;

function readText(abs: string): string {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

function resolveAbs(workspaceRoot: string, rel: string): string {
  if (path.isAbsolute(rel) || rel.startsWith('\\\\')) return rel;
  return path.join(workspaceRoot, rel);
}

/** DOM ids referenced from JS. */
export function extractJsDomIdRefs(js: string): string[] {
  const ids = new Set<string>();
  const re =
    /(?:getElementById|querySelector)\s*\(\s*['"]#?([A-Za-z][\w-]*)['"]\s*\)|querySelectorAll\s*\(\s*['"]#([A-Za-z][\w-]*)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(js))) {
    const id = m[1] || m[2];
    if (id) ids.add(id);
  }
  return [...ids];
}

/** id="…" declarations in HTML. */
export function extractHtmlIds(html: string): Set<string> {
  const ids = new Set<string>();
  const re = /\bid\s*=\s*["']([A-Za-z][\w-]*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) ids.add(m[1]);
  }
  return ids;
}

/** Ids assigned in JS (createElement + id= / .id =) — not required in static HTML. */
export function extractJsDefinedIds(js: string): Set<string> {
  const ids = new Set<string>();
  for (const m of js.matchAll(/\bid\s*=\s*["']([A-Za-z][\w-]*)["']/gi)) {
    if (m[1]) ids.add(m[1]);
  }
  for (const m of js.matchAll(/\.id\s*=\s*["']([A-Za-z][\w-]*)["']/g)) {
    if (m[1]) ids.add(m[1]);
  }
  return ids;
}

/** Boot helpers that must be invoked (legacy CQR + common SPA entrypoints). */
export function extractDeclaredBootHelpers(js: string): string[] {
  const names = new Set<string>();
  for (const name of [
    'renderDeviceProfiles',
    'renderCompatibilityChecks',
    'renderAll',
    'init',
  ]) {
    if (functionDeclared(js, name)) names.add(name);
  }
  for (const m of js.matchAll(/function\s+(init[A-Z][A-Za-z0-9]*)\s*\(/g)) {
    if (m[1]) names.add(m[1]);
  }
  return [...names].slice(0, 8);
}

/** Top-level init calls that must exist if claimed UI is dynamic. */
export function extractInitCallNames(js: string): string[] {
  const names: string[] = [];
  for (const m of js.matchAll(
    /\b(render[A-Z][A-Za-z0-9]*|init[A-Z][A-Za-z0-9]*)\s*\(\s*\)/g,
  )) {
    if (m[1]) names.push(m[1]);
  }
  return [...new Set(names)];
}

export function functionDeclared(js: string, name: string): boolean {
  const re = new RegExp(
    `(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:function|\\())`,
  );
  return re.test(js);
}

function siblingHtmlPaths(workspaceRoot: string, jsRel: string): string[] {
  const dir = path.dirname(jsRel.replace(/\\/g, '/'));
  const candidates = ['index.html', 'Index.html', 'main.html'].map((f) =>
    dir === '.' ? f : `${dir}/${f}`,
  );
  return candidates.filter((rel) => existsSync(resolveAbs(workspaceRoot, rel)));
}

/**
 * When mutated paths include web assets, verify JS DOM refs exist in HTML
 * and dynamic render/init helpers are both declared and invoked.
 */
export function probeWebRuntimeSmoke(
  workspaceRoot: string,
  mutatedPaths: string[],
): RuntimeSmokeResult {
  const webPaths = mutatedPaths
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => WEB_EXT_RE.test(p));
  if (!webPaths.length) {
    return { applicable: false, ok: true, missing: [], notes: [] };
  }

  const jsRels = webPaths.filter((p) => JS_EXT_RE.test(p));
  let htmlRels = webPaths.filter((p) => HTML_EXT_RE.test(p));
  if (!htmlRels.length) {
    for (const js of jsRels) {
      htmlRels.push(...siblingHtmlPaths(workspaceRoot, js));
    }
    htmlRels = [...new Set(htmlRels)];
  }

  if (!jsRels.length || !htmlRels.length) {
    return {
      applicable: true,
      ok: true,
      missing: [],
      notes: ['web smoke: js/html pair incomplete — skipped id wiring check'],
    };
  }

  const htmlIds = new Set<string>();
  for (const rel of htmlRels) {
    const html = readText(resolveAbs(workspaceRoot, rel));
    for (const id of extractHtmlIds(html)) htmlIds.add(id);
  }

  const missing: string[] = [];
  const notes: string[] = [];

  for (const rel of jsRels) {
    const js = readText(resolveAbs(workspaceRoot, rel));
    if (!js) {
      missing.push(`missing_file:${rel}`);
      continue;
    }
    const jsDefinedIds = extractJsDefinedIds(js);
    for (const id of extractJsDomIdRefs(js)) {
      if (!htmlIds.has(id) && !jsDefinedIds.has(id)) {
        missing.push(`dom_id:#${id} (from ${rel})`);
      }
    }
    for (const name of extractInitCallNames(js)) {
      if (!functionDeclared(js, name)) {
        missing.push(`init_call_undeclared:${name} (${rel})`);
      }
    }
    // Dynamic UI helpers that fill empty HTML shells must be invoked at boot
    // (generic render*/init* — not CQR-product-only).
    for (const boot of extractDeclaredBootHelpers(js)) {
      const isFnKeyword = new RegExp(`function\\s+${boot}\\s*\\(`).test(js);
      const callCount = [...js.matchAll(new RegExp(`\\b${boot}\\s*\\(`, 'g'))].length;
      const minCalls = isFnKeyword ? 2 : 1;
      if (callCount < minCalls) {
        missing.push(`boot_not_invoked:${boot} (${rel})`);
      }
    }
  }

  if (missing.length) {
    notes.push('HTML/JS wiring smoke failed — empty UI shells or missing boot calls');
  } else {
    notes.push('HTML/JS wiring smoke ok');
  }

  return {
    applicable: true,
    ok: missing.length === 0,
    missing: missing.slice(0, 12),
    notes,
  };
}

export function formatRuntimeSmokeNudge(result: RuntimeSmokeResult): string {
  return [
    'FALSE: completion blocked — HTML/JS runtime wiring smoke failed.',
    'Fix missing DOM ids or boot calls, then rewrite.',
    ...result.missing.map((m) => `- ${m}`),
    'Call read_file on the HTML+JS pair, then edit_file/apply_patch.',
  ].join('\n');
}

export function formatRuntimeSmokeRewrite(result: RuntimeSmokeResult): string {
  return [
    '미검증 — HTML/JS 런타임 배선 smoke 실패로 완료 처리하지 않습니다.',
    ...result.missing.slice(0, 6).map((m) => `- ${m}`),
    '빈 컨테이너(#id)에 버튼을 그리는 render* 가 호출되는지, getElementById 대상 id가 HTML에 있는지 확인하세요.',
  ].join('\n');
}

/**
 * Machine note for MAR Critic / supervisor — forces PARTIAL when DOM ids missing.
 * Empty string when smoke N/A or ok.
 */
export function formatWebWiringCriticNote(
  workspaceRoot: string,
  mutatedPaths: string[],
): string {
  const smoke = probeWebRuntimeSmoke(workspaceRoot, mutatedPaths);
  if (!smoke.applicable || smoke.ok) return '';
  return [
    '## Machine wiring smoke (FAIL — do not VERDICT: PASS)',
    'getElementById / querySelector("#id") targets missing from sibling HTML (or boot helper never called).',
    ...smoke.missing.slice(0, 8).map((m) => `- ${m}`),
    'Required: VERDICT: PARTIAL (or FAIL). next = add missing id(s) to HTML or stop calling them in JS.',
  ].join('\n');
}

const WIRING_SMOKE_RE = /\bERROR:\s*WIRING_SMOKE\b/;

/** Append in-run wiring gate after a successful web mutate (syntax OK). */
export function appendPostMutateWiringSmoke(
  workspaceRoot: string,
  paths: string[],
  output: string,
): string {
  const body = String(output || '');
  if (/\bERROR:\s*SYNTAX_BROKEN\b/.test(body)) return body;
  const smoke = probeWebRuntimeSmoke(workspaceRoot, paths);
  if (!smoke.applicable || smoke.ok) return body;
  return [
    body.trimEnd(),
    '',
    'ERROR: WIRING_SMOKE',
    'Post-mutate HTML/JS wiring gate failed. Do NOT claim 완료.',
    ...smoke.missing.slice(0, 8).map((m) => `- ${m}`),
    'Fix NOW: edit index.html (or sibling HTML) to add missing id=…, or remove stale getElementById calls.',
  ].join('\n');
}

export function outputHasWiringSmoke(output: string): boolean {
  return WIRING_SMOKE_RE.test(String(output || ''));
}
