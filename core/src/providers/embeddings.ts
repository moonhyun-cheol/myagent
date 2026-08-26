/**
 * Optional OpenAI-compatible /embeddings client for ADR-003 A2 cloud path.
 * Falls back to deterministic stub vectors when apiKey starts with stub:.
 */
export interface CreateEmbeddingsResult {
  model: string;
  vectors: number[][];
  engine: 'openai-compatible' | 'stub';
}

function l2Normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

/** Deterministic stand-in for tests / offline (not a real model). */
export function stubEmbeddingVector(text: string, dim = 64): number[] {
  const v = new Array<number>(dim).fill(0);
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const code = lower.charCodeAt(i);
    v[code % dim]! += 1 + (i % 3) * 0.1;
    v[(code * 31 + i) % dim]! += 0.35;
  }
  // Boost shared code tokens so paraphrase stubs still separate files.
  for (const tok of lower.match(/[a-z0-9_]+/g) ?? []) {
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (h * 33 + tok.charCodeAt(i)) >>> 0;
    v[h % dim]! += 2;
  }
  return l2Normalize(v);
}

/**
 * POST {base}/embeddings — OpenAI / compatible providers.
 * Batch input; returns one L2-normalized vector per input (same order).
 */
export async function createEmbeddings(
  baseUrl: string,
  apiKey: string,
  model: string,
  input: string | string[],
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<CreateEmbeddingsResult> {
  const inputs = (Array.isArray(input) ? input : [input]).map((t) => t.slice(0, 8_000));
  if (!inputs.length) return { model, vectors: [], engine: 'openai-compatible' };

  if (apiKey.startsWith('stub:')) {
    return {
      model,
      engine: 'stub',
      vectors: inputs.map((t) => stubEmbeddingVector(t)),
    };
  }

  const url = `${baseUrl.replace(/\/$/, '')}/embeddings`;
  const timeoutMs = opts?.timeoutMs ?? 45_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  opts?.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: inputs.length === 1 ? inputs[0] : inputs }),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`embeddings HTTP ${res.status}: ${raw.slice(0, 400)}`);
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('embeddings: invalid JSON response');
    }
    const doc = data as {
      model?: string;
      data?: { embedding?: number[]; index?: number }[];
    };
    const rows = Array.isArray(doc.data) ? [...doc.data] : [];
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length !== inputs.length) {
      throw new Error(`embeddings: expected ${inputs.length} vectors, got ${rows.length}`);
    }
    const vectors = rows.map((r) => {
      if (!Array.isArray(r.embedding) || !r.embedding.length) {
        throw new Error('embeddings: missing embedding array');
      }
      return l2Normalize(r.embedding.map((x) => Number(x) || 0));
    });
    return {
      model: typeof doc.model === 'string' ? doc.model : model,
      vectors,
      engine: 'openai-compatible',
    };
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener('abort', onAbort);
  }
}
