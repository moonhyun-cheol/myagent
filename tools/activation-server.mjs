#!/usr/bin/env node
/**
 * MY Agent central activation server — lightweight LAN service.
 * Auto-issues signed license.ocx bound to DOMAIN\user + machine_id (no pre-registration).
 */
import { createServer } from 'node:http';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REQUIRED_LICENSE_FEATURES } from './deploy-parity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.ACTIVATION_DATA_DIR ?? path.join(root, 'activation-server'));
const configPath = path.join(dataDir, 'config.json');
const policyPath = path.join(dataDir, 'policy.json');
const legacyAllowlistPath = path.join(dataDir, 'allowlist.json');
const bundlePath = path.join(dataDir, 'keys-bundle.enc');
const logPath = path.join(dataDir, 'activation.log');

const UNLIMITED_EXPIRES = '2099-12-31T23:59:59.000Z';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function log(line) {
  const msg = `${new Date().toISOString()} ${line}\n`;
  try {
    appendFileSync(logPath, msg, 'utf8');
  } catch {
    /* ignore */
  }
  console.log(line);
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function loadJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, doc) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

function loadConfig() {
  return loadJson(configPath, {});
}

function loadPolicy() {
  if (existsSync(policyPath)) return loadJson(policyPath, {});
  if (existsSync(legacyAllowlistPath)) return loadJson(legacyAllowlistPath, {});
  return {};
}

function readOperatorVaultAdapter() {
  const p = path.join(root, 'data', 'vault', 'openclaw-adapter.json');
  if (!existsSync(p)) return {};
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    return doc && typeof doc === 'object' ? doc : {};
  } catch {
    return {};
  }
}

function ensureDataDir() {
  mkdirSync(dataDir, { recursive: true });
  if (!existsSync(configPath)) {
    const token = randomBytes(24).toString('hex');
    const vault = readOperatorVaultAdapter();
    saveJson(configPath, {
      host: '0.0.0.0',
      port: 10201,
      admin_token: token,
      activation_token: '',
      include_keys_bundle: true,
      openclaw_adapter: {
        base_url: String(vault.base_url || 'http://127.0.0.1:8790').trim().replace(/\/+$/, ''),
        token: String(vault.token || '').trim(),
      },
      note: 'Optional adapter settings are written to the device-local vault during activation.',
    });
    log(`Created config -> ${configPath}`);
    log(`Admin token: ${token}`);
  }
  if (!existsSync(policyPath) && !existsSync(legacyAllowlistPath)) {
    saveJson(policyPath, {
      org_id: 'myorg',
      license_days: null,
      require_allowlist: false,
      features: [...REQUIRED_LICENSE_FEATURES, 'web_search'],
      allowed_users: [],
    });
    log(`Created policy -> ${policyPath}`);
  }
}

function ensureBuilt() {
  if (process.env.MY_AGENT_ACTIVATION_SKIP_BUILD === '1') return;
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

async function loadDist() {
  const format = await import(
    pathToFileURL(path.join(root, 'core', 'dist', 'license', 'license-format.js')).href
  );
  const crypto = await import(
    pathToFileURL(path.join(root, 'core', 'dist', 'license', 'license-crypto.js')).href
  );
  const win = await import(
    pathToFileURL(path.join(root, 'core', 'dist', 'license', 'windows-user-id.js')).href
  );
  const bundle = await import(
    pathToFileURL(path.join(root, 'core', 'dist', 'setup', 'key-bundle.js')).href
  );
  return { format, crypto, win, bundle };
}

function readPrivateKey() {
  const privPath = path.join(root, 'tools', 'keys', 'license-private.pem');
  if (!existsSync(privPath)) {
    throw new Error('Private key missing. Run: node tools/cqr-admin.mjs keygen');
  }
  return readFileSync(privPath, 'utf8');
}

function resolveExpiresAt(licenseDays) {
  if (licenseDays == null || licenseDays === '' || Number(licenseDays) === 0) {
    return UNLIMITED_EXPIRES;
  }
  const exp = new Date();
  exp.setUTCDate(exp.getUTCDate() + Number(licenseDays));
  return exp.toISOString();
}

/**
 * OpenClaw Adapter provision for employee CQR (URL + MAIN_API_TOKEN).
 * Env, then config.json, then this machine's data/vault/openclaw-adapter.json.
 * config.json is re-read per request so filling the token does not require a restart.
 */
function resolveOpenClawAdapter(config) {
  const fromConfig = config.openclaw_adapter && typeof config.openclaw_adapter === 'object'
    ? config.openclaw_adapter
    : {};
  const fromVault = readOperatorVaultAdapter();
  const base_url = String(
    process.env.OPENCLAW_ADAPTER_BASE_URL
    || process.env.MY_AGENT_OPENCLAW_ADAPTER_URL
    || fromConfig.base_url
    || fromConfig.baseUrl
    || fromVault.base_url
    || '',
  ).trim().replace(/\/+$/, '');
  const token = String(
    process.env.OPENCLAW_ADAPTER_TOKEN
    || process.env.MAIN_API_TOKEN
    || process.env.MANAGER_API_TOKEN
    || fromConfig.token
    || fromVault.token
    || '',
  ).trim();
  if (!base_url || !token) return null;
  return { base_url, token };
}

function isUserAllowed(policy, userId, win) {
  if (!policy.require_allowlist) return true;
  const normalized = win.normalizeUserHint(userId);
  const users = (policy.allowed_users ?? []).map((u) => win.normalizeUserHint(u));
  return users.includes(normalized);
}

function issueLicense({ format, crypto, win }, policy, userId, machineId) {
  const priv = readPrivateKey();
  const now = new Date();

  const payload = {
    v: 1,
    org_id: policy.org_id ?? 'myorg',
    features: policy.features ?? ['chat'],
    issued_at: now.toISOString(),
    expires_at: resolveExpiresAt(policy.license_days),
    machine_hint: machineId,
    user_hint: win.normalizeUserHint(userId),
    nonce: randomUUID(),
  };

  const sig = crypto.signLicensePayload(payload, priv);
  const doc = format.buildSignedLicense(payload, sig);
  return format.serializeLicense(doc);
}

async function resolveKeysBundle(bundleMod, policy) {
  if (existsSync(bundlePath)) {
    return readFileSync(bundlePath, 'utf8').trim();
  }

  const { buildDefaultBundlePayload } = await import(
    pathToFileURL(path.join(root, 'core', 'dist', 'setup', 'default-bundle-payload.js')).href
  );

  try {
    const payload = buildDefaultBundlePayload({
      orgId: policy.org_id ?? 'myorg',
      cqrRoot: root,
      requireOpenWebUi: false,
    });
    return bundleMod.encryptBundle(payload);
  } catch {
    return null;
  }
}

function checkBearer(req, expected) {
  if (!expected) return true;
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return Boolean(m && m[1] === expected);
}

function checkAdmin(req, config) {
  return checkBearer(req, config.admin_token);
}

async function main() {
  ensureDataDir();
  ensureBuilt();
  const dist = await loadDist();
  const bootConfig = loadConfig();
  const host = process.env.ACTIVATION_HOST ?? bootConfig.host ?? '0.0.0.0';
  const port = Number(process.env.ACTIVATION_PORT ?? bootConfig.port ?? 10201);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const method = req.method ?? 'GET';
    const config = loadConfig();

    try {
      if (method === 'GET' && url.pathname === '/health') {
        const policy = loadPolicy();
        return sendJson(res, 200, {
          ok: true,
          product: 'MY_AGENT_ACTIVATION',
          org_id: policy.org_id ?? null,
          require_allowlist: Boolean(policy.require_allowlist),
          license_days: policy.license_days ?? null,
          openclaw_configured: Boolean(resolveOpenClawAdapter(config)),
        });
      }

      if (method === 'POST' && url.pathname === '/v1/activate') {
        if (!checkBearer(req, config.activation_token)) {
          return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED', message: '잘못된 활성화 토큰' });
        }

        const body = JSON.parse(await readBody(req));
        const userId = String(body.windows_user ?? '').trim();
        const machineId = String(body.machine_id ?? '').trim();
        if (!userId) {
          return sendJson(res, 400, { ok: false, error: 'USER_REQUIRED', message: 'windows_user 필요' });
        }
        if (!machineId) {
          return sendJson(res, 400, { ok: false, error: 'MACHINE_REQUIRED', message: 'machine_id 필요' });
        }

        const policy = loadPolicy();
        if (!isUserAllowed(policy, userId, dist.win)) {
          log(`DENY ${userId}`);
          return sendJson(res, 403, {
            ok: false,
            error: 'USER_NOT_ALLOWED',
            message: '허용 목록에 없는 계정입니다.',
          });
        }

        const license = issueLicense(dist, policy, userId, machineId);
        let keys_bundle;
        if (config.include_keys_bundle !== false) {
          keys_bundle = await resolveKeysBundle(dist.bundle, policy);
        }

        const openclaw_adapter = resolveOpenClawAdapter(config);

        log(`OK ${userId} ${machineId.slice(0, 8)}…`);
        return sendJson(res, 200, {
          ok: true,
          license,
          keys_bundle: keys_bundle ?? undefined,
          openclaw_adapter: openclaw_adapter ?? undefined,
          org_id: policy.org_id,
          expires_at: resolveExpiresAt(policy.license_days),
        });
      }

      if (method === 'GET' && url.pathname === '/v1/openclaw-adapter') {
        if (!checkBearer(req, config.activation_token)) {
          return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED', message: '잘못된 활성화 토큰' });
        }
        const openclaw_adapter = resolveOpenClawAdapter(config);
        if (!openclaw_adapter) {
          return sendJson(res, 404, {
            ok: false,
            error: 'OPENCLAW_NOT_CONFIGURED',
            message: '활성화 서버에 OpenClaw 토큰이 없습니다. 운영 PC의 activation-server/config.json 또는 data/vault/openclaw-adapter.json 을 확인하고 서버를 재시작하세요.',
          });
        }
        return sendJson(res, 200, { ok: true, openclaw_adapter });
      }

      if (method === 'GET' && url.pathname === '/v1/admin/policy') {
        if (!checkAdmin(req, config)) {
          return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
        }
        return sendJson(res, 200, loadPolicy());
      }

      if (method === 'GET' && url.pathname === '/v1/admin/allowlist') {
        if (!checkAdmin(req, config)) {
          return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
        }
        return sendJson(res, 200, loadPolicy());
      }

      if (method === 'POST' && url.pathname === '/v1/admin/allowlist') {
        if (!checkAdmin(req, config)) {
          return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
        }
        const body = JSON.parse(await readBody(req));
        const action = body.action ?? 'add';
        const policy = loadPolicy();
        policy.allowed_users = policy.allowed_users ?? [];
        policy.require_allowlist = true;

        if (action === 'add' && body.user) {
          const user = dist.win.normalizeUserHint(body.user);
          if (!policy.allowed_users.includes(user)) {
            policy.allowed_users.push(user);
          }
        } else if (action === 'remove' && body.user) {
          const user = dist.win.normalizeUserHint(body.user);
          policy.allowed_users = policy.allowed_users.filter((u) => u !== user);
        } else {
          return sendJson(res, 400, { ok: false, error: 'BAD_REQUEST' });
        }

        saveJson(existsSync(policyPath) ? policyPath : legacyAllowlistPath, policy);
        log(`allowlist ${action} ${body.user}`);
        return sendJson(res, 200, { ok: true, policy });
      }

      return sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
    } catch (e) {
      log(`ERR ${e instanceof Error ? e.message : e}`);
      return sendJson(res, 500, { ok: false, error: 'SERVER_ERROR', message: String(e) });
    }
  });

  server.listen(port, host, () => {
    const policy = loadPolicy();
    log(`MY Agent activation server http://${host}:${port}`);
    log(`data: ${dataDir}`);
    log(
      `policy: allowlist=${Boolean(policy.require_allowlist)} license_days=${policy.license_days ?? 'unlimited'}`,
    );
    log(`openclaw: ${resolveOpenClawAdapter(loadConfig()) ? 'configured' : 'MISSING token'}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
