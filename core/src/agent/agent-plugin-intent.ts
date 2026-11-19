/**
 * Local plugin template lookup for plugin_scaffold (`prefer_template_id`).
 * Input is the scaffold purpose the model passed, not the user's chat text.
 */

/** Keyword → tools/plugin-templates/{id} */
const TEMPLATE_HINTS: Array<{ id: string; re: RegExp }> = [
  {
    id: 'file_stat',
    re: /file_stat|파일\s*stat|파일\s*크기\s*플러그인/i,
  },
  {
    id: 'json_read',
    re: /json_read|json\s*키|package\.json\s*키/i,
  },
];

export function resolvePluginTemplateId(message: string): string | null {
  const t = String(message || '');
  const explicit = t.match(/template_id\s*[=:]\s*([a-z0-9_]+)/i);
  if (explicit?.[1]) return explicit[1].toLowerCase();
  const fromPhrase = t.match(
    /(?:템플릿|template)\s*[:：]?\s*([a-z0-9_]+)/i,
  );
  if (fromPhrase?.[1] && isKnownTemplateId(fromPhrase[1])) {
    return fromPhrase[1].toLowerCase();
  }
  for (const h of TEMPLATE_HINTS) {
    if (h.re.test(t)) return h.id;
  }
  return null;
}

function isKnownTemplateId(id: string): boolean {
  return TEMPLATE_HINTS.some((h) => h.id === id.toLowerCase());
}
