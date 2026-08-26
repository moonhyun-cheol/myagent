#!/usr/bin/env node
// Narrow down OWUI gateway failures: credentials/model vs request params vs payload size.
// Usage: node tools/probe-owui-gateway.mjs [providerId]
import path from 'node:path';
import { ProviderStore } from '../core/dist/providers/provider-store.js';

const cqrRoot = path.resolve(import.meta.dirname, '..');
const store = new ProviderStore(
  path.join(cqrRoot, 'data', 'vault', 'provider-keys.json'),
  cqrRoot,
);
const providerId = process.argv[2] || store.getDefaultId();
const resolved = providerId ? store.resolveProvider(providerId) : null;
if (!resolved) {
  console.error(`provider not configured: ${providerId}`);
  process.exit(1);
}

const url = `${resolved.baseUrl.replace(/\/$/, '')}/chat/completions`;
console.log(`gateway: ${new URL(url).host}${new URL(url).pathname} | model: ${resolved.modelId}`);

async function probe(name, body) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.secret.api_key}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    });
    const text = await res.text();
    const sec = Math.round((Date.now() - t0) / 1000);
    console.log(`${name} -> ${res.status} (${sec}s) ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
    return res.status;
  } catch (e) {
    console.log(`${name} -> THROW ${e.name} ${String(e.message).slice(0, 120)}`);
    return 0;
  }
}

const model = resolved.modelId;
const hello = [{ role: 'user', content: 'Reply with the single word OK.' }];
const jsonAsk = [{ role: 'user', content: 'Return only this JSON object: {"a": 1}' }];

await probe('1 minimal            ', { model, messages: hello });
await probe('2 response_format json', {
  model,
  messages: jsonAsk,
  response_format: { type: 'json_object' },
});
await probe('3 response_format schema', {
  model,
  messages: jsonAsk,
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'Probe',
      schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
    },
  },
});
await probe('4 tools (function call)', {
  model,
  messages: hello,
  tools: [
    {
      type: 'function',
      function: {
        name: 'probe',
        parameters: { type: 'object', properties: { a: { type: 'string' } } },
      },
    },
  ],
});
await probe('5 stream_options     ', {
  model,
  messages: hello,
  stream: false,
  stream_options: { include_usage: true },
});

for (const kb of [8, 32, 96, 200]) {
  const filler = 'ski pants waterproof venting review snippet. '.repeat(Math.round((kb * 1024) / 45));
  await probe(`6 payload ~${String(kb).padStart(3)}KB `, {
    model,
    messages: [
      { role: 'system', content: 'Summarize in one short sentence.' },
      { role: 'user', content: filler },
    ],
  });
}
