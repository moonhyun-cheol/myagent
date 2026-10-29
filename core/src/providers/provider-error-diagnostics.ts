/** Body-free error diagnostics. Never persist free-form messages, metadata, URLs or headers. */
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function safeProtocolIdentifier(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value)
    && !/(sk-|Bearer|eyJ)/i.test(value) ? value : undefined;
}

function classify(error: Record<string, unknown>, status?: number) {
  // Inspect bounded text only to select fixed labels. The text itself never leaves this function.
  const text = [error.message, error.code, error.type].filter(value => typeof value === 'string').map(value => (value as string).slice(0, 8192)).join(' ');
  const reason = /(?:max[_ -]?(?:output|completion)?[_ -]?tokens|requested).{0,160}(?:afford|credits|balance)|can only afford|(?:credits|balance).{0,80}(?:max[_ -]?tokens|requested)/i.test(text) ? 'request_cost_exceeds_balance'
    : /(?:spend|spending|budget|credit|usage).{0,40}(?:limit|cap).{0,40}(?:exceed|reach)|(?:exceed|reach).{0,40}(?:spend|spending|budget|credit|usage).{0,40}(?:limit|cap)|(?:spending|budget|credit|usage)[_ -]limit/i.test(text) ? 'spending_limit'
    : /insufficient[_ -](?:credit|fund|balance)|(?:not enough|out of|no remaining).{0,20}(?:credit|fund|balance)|(?:credit|balance).{0,40}(?:exhaust|insufficient|too low)/i.test(text) ? 'insufficient_credits'
    : /payment[_ -]required|billing|payment/i.test(text) ? 'payment_required'
    : /rate.?limit|too many requests/i.test(text) ? 'rate_limit'
    : /context.{0,30}(length|window)|maximum.{0,30}tokens/i.test(text) ? 'context_length'
    : /api.?key|unauthorized|authentication/i.test(text) ? 'authentication'
    : status === 402 || String(error.code) === '402' ? 'payment_required_unspecified' : 'unspecified';
  const category = ['request_cost_exceeds_balance', 'spending_limit', 'insufficient_credits', 'payment_required', 'payment_required_unspecified'].includes(reason)
    ? 'payment_required' : reason === 'unspecified' ? 'provider_error' : reason;
  return { category, reason };
}

export function providerErrorDiagnostics(doc: unknown, response?: Pick<Response, 'status' | 'headers'>) {
  const envelope = record(doc);
  const nested = record(envelope.response);
  const candidate = envelope.error ?? nested.error ?? envelope;
  const error = typeof candidate === 'string' ? { message: candidate } : record(candidate);
  const metadata = record(error.metadata);
  let raw: unknown = metadata.raw;
  if (typeof raw === 'string') {
    if (raw.length > 32_768) raw = undefined;
    else {
      try { raw = JSON.parse(raw); } catch { raw = { message: raw }; }
    }
  }
  const upstreamDoc = record(raw);
  const upstream = record(upstreamDoc.error ?? upstreamDoc);
  const top = classify(error, response?.status);
  const up = classify(upstream);
  // A generic HTTP-402 wrapper must not hide a more specific upstream reason.
  const classification = ['unspecified', 'payment_required_unspecified', 'payment_required'].includes(top.reason) && up.reason !== 'unspecified' ? up : top;
  const providerName = metadata.provider_name ?? envelope.provider;
  return {
    ...classification,
    code: safeProtocolIdentifier(error.code),
    type: safeProtocolIdentifier(error.type),
    upstream_code: safeProtocolIdentifier(upstream.code),
    upstream_type: safeProtocolIdentifier(upstream.type),
    upstream_provider: typeof providerName === 'string' && /^[a-zA-Z0-9_.: -]{1,80}$/.test(providerName) && !/(sk-|Bearer|eyJ)/i.test(providerName) ? providerName : undefined,
    request_id: safeProtocolIdentifier(response?.headers.get('x-request-id') ?? response?.headers.get('request-id')),
  };
}