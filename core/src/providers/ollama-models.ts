/**
 * Ollama /api/tags names vs configured model ids.
 * `:latest` is a real tag, not a wildcard for `:7b` / `:14b`.
 */

const OLLAMA_TAGS_CACHE_MS = 30_000;

let tagsCache: { key: string; at: number; names: string[] } | null = null;

export function ollamaNativeBaseUrl(openaiBaseUrl: string): string {
  return openaiBaseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

function splitOllamaRef(modelId: string): { base: string; tag: string | null } {
  const want = modelId.trim();
  const colon = want.lastIndexOf(':');
  if (colon <= 0) return { base: want, tag: null };
  return { base: want.slice(0, colon), tag: want.slice(colon + 1) };
}

function sameFamily(installed: string, base: string): boolean {
  return installed === base || installed.startsWith(`${base}:`);
}

/**
 * Map a configured Ollama id onto a name that `/api/tags` actually has.
 * Returns null when no safe installed substitute exists.
 */
export function resolveInstalledOllamaModel(
  configured: string,
  installed: string[],
): string | null {
  const want = configured.trim();
  if (!want || installed.length === 0) return null;
  if (installed.includes(want)) return want;

  const { base, tag } = splitOllamaRef(want);
  if (!base) return null;

  if (!tag || tag === 'latest') {
    if (installed.includes(base)) return base;
    if (installed.includes(`${base}:latest`)) return `${base}:latest`;
    const family = installed.filter((name) => sameFamily(name, base));
    if (family.length === 1) return family[0];
    return null;
  }

  return null;
}

export function ollamaModelInstalled(models: string[], modelId: string): boolean {
  return resolveInstalledOllamaModel(modelId, models) != null;
}

export function peekCachedOllamaModelNames(openaiBaseUrl?: string): string[] {
  if (!tagsCache) return [];
  if (openaiBaseUrl && tagsCache.key !== ollamaNativeBaseUrl(openaiBaseUrl)) return [];
  return tagsCache.names;
}

export function invalidateOllamaModelCache(): void {
  tagsCache = null;
}

export async function listOllamaModelNames(openaiBaseUrl: string): Promise<string[]> {
  const key = ollamaNativeBaseUrl(openaiBaseUrl);
  if (!key) return [];
  if (tagsCache && tagsCache.key === key && Date.now() - tagsCache.at < OLLAMA_TAGS_CACHE_MS) {
    return tagsCache.names;
  }
  try {
    const res = await fetch(`${key}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name?: string }[] };
    const names = (data.models ?? [])
      .map((model) => model.name)
      .filter((name): name is string => Boolean(name));
    tagsCache = { key, at: Date.now(), names };
    return names;
  } catch {
    return [];
  }
}
