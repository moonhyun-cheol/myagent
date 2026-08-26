import { createPrivateKey, randomUUID, sign as cryptoSign } from 'node:crypto';

/** Python `json.dumps(..., sort_keys=True, separators=(",", ":"), ensure_ascii=False)` */
export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Ed25519 seed (32-byte hex) → PKCS#8 DER for Node crypto */
function ed25519PrivateKeyFromSeedHex(privateKeyHex: string) {
  const seed = Buffer.from(privateKeyHex.trim(), 'hex');
  if (seed.length !== 32) {
    throw new Error(`GATE_CONTEXT_PRIVATE_KEY_INVALID: expected 32-byte hex, got ${seed.length} bytes`);
  }
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ]);
  return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
}

export interface GateCommandContextPayload {
  route: 'adapter';
  platform: string;
  transaction_id: string;
  request_id: string;
  actor_id: string;
  actor_tier: string;
  guild_id: string;
  channel_id: string;
  task_profile_id: string;
  tool_id: string;
  approval_token_ref: string;
  incident_reference: string;
  requested_scope: Record<string, unknown>;
  token_scope: Record<string, unknown>;
  operation_fingerprint: string;
  issued_at: string;
  expires_at: string;
  nonce: string;
}

export interface SignedGateCommandContext {
  version: 'gate-command-context/v1';
  payload: GateCommandContextPayload;
  signature: string;
}

export function buildGateCommandContextPayload(input: {
  requestId: string;
  transactionId: string;
  actorId: string;
  actorTier?: string;
  guildId?: string;
  channelId?: string;
  taskProfileId: string;
  toolId: string;
  operationFingerprint?: string;
  ttlSeconds?: number;
  platform?: string;
}): GateCommandContextPayload {
  const now = Date.now();
  const ttl = Math.max(60, input.ttlSeconds ?? 900);
  const issued = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const expires = new Date(now + ttl * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    route: 'adapter',
    // Adapter verify allows "discord" | "my_agent".
    platform: input.platform ?? 'my_agent',
    transaction_id: input.transactionId,
    request_id: input.requestId,
    actor_id: input.actorId,
    actor_tier: input.actorTier ?? 'operator',
    guild_id: input.guildId ?? 'cqr-pa',
    channel_id: input.channelId ?? 'cqr-pa-chat',
    task_profile_id: input.taskProfileId,
    tool_id: input.toolId,
    approval_token_ref: '',
    incident_reference: '',
    requested_scope: {},
    token_scope: {},
    operation_fingerprint: input.operationFingerprint ?? 'cqr-pa-automaton',
    issued_at: issued,
    expires_at: expires,
    nonce: `cqr-${randomUUID().replace(/-/g, '')}`,
  };
}

export function signGateCommandContext(
  payload: GateCommandContextPayload,
  privateKeyHex: string,
): SignedGateCommandContext {
  if (!privateKeyHex?.trim()) {
    throw new Error('GATE_CONTEXT_PRIVATE_KEY_MISSING');
  }
  const key = ed25519PrivateKeyFromSeedHex(privateKeyHex);
  const signature = cryptoSign(null, canonicalJsonBytes(payload), key);
  return {
    version: 'gate-command-context/v1',
    payload,
    signature: b64url(signature),
  };
}
