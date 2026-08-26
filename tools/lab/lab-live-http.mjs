/**
 * Shared live-lab HTTP helpers — infra flake only (fetch failed / reset).
 * Does not mark empty model replies as pass.
 */

export function isInfraFetchError(err) {
  const s = err instanceof Error ? `${err.message} ${err.cause || ''}` : String(err || '');
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR|socket hang|network|aborted|EPIPE|other side closed|premature close|ECONNABORTED|ERR_STREAM/i.test(
    s,
  );
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/** Poll /health until ok or timeout. */
export async function waitForApi(base, timeoutMs = 8000) {
  const root = String(base || '').replace(/\/$/, '');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const j = await fetch(`${root}/health`, { signal: AbortSignal.timeout(4000) }).then((r) =>
        r.json(),
      );
      if (j?.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(400);
  }
  return false;
}

/**
 * Run an async stream once; on infra fetch error / empty+error, wait+retry (max extra).
 * @param {() => Promise<{content?: string, error?: string}>} once
 */
export async function withInfraRetry(once, opts = {}) {
  const extra = Number(opts.extra ?? 3);
  const base = opts.base || 'http://127.0.0.1:10200';
  let last = null;
  for (let i = 0; i <= extra; i++) {
    try {
      last = await once(i);
    } catch (e) {
      last = {
        content: '',
        error: e instanceof Error ? e.message : String(e),
        _infra: isInfraFetchError(e),
      };
    }
    const empty = !String(last?.content || '').trim();
    const infra = last?.error && (last._infra || isInfraFetchError(last.error));
    if (last && !last.error && !empty) return last;
    if (i >= extra) return last;
    if (!infra && !empty) return last;
    console.log(`  infra retry ${i + 1}/${extra} (${last?.error || 'empty'})`);
    await waitForApi(base, 12_000);
    // Exponential backoff — P86 long secretary turns / SSE idle flakes.
    await sleep(1200 * (i + 1));
  }
  return last;
}
