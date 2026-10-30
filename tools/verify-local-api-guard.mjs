/**
 * verify-local-api-guard — browser-originated requests into the unauthenticated local API.
 * Pure function checks (no server, no network).
 */
import assert from 'node:assert/strict';
import { checkLocalApiRequest } from '../core/dist/security/local-api-guard.js';

const PORT = 10200;
const env = {};
const req = (method, headers) => ({ method, headers });
const ok = (r) => checkLocalApiRequest(r, PORT, env).ok;
const reason = (r) => checkLocalApiRequest(r, PORT, env).reason;

// App UI (WebView2 at http://127.0.0.1:PORT) and Vite dev proxy are allowed.
assert.equal(ok(req('POST', { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' })), true);
assert.equal(ok(req('POST', { host: 'localhost:5174', origin: 'http://localhost:5174' })), true);
// Shell HttpClient / scripts: no Origin, no Sec-Fetch.
assert.equal(ok(req('POST', { host: `127.0.0.1:${PORT}` })), true);
assert.equal(ok(req('GET', { host: `localhost:${PORT}` })), true);
assert.equal(ok(req('GET', { host: `[::1]:${PORT}` })), true);

// DNS rebinding keeps the attacker hostname in Host.
assert.equal(reason(req('GET', { host: `rebind.evil.example:${PORT}` })), 'host_not_loopback');
assert.equal(reason(req('GET', { host: `127.0.0.1.evil.example:${PORT}` })), 'host_not_loopback');

// Cross-site CSRF form/fetch: foreign or null Origin on state-changing methods.
assert.equal(reason(req('POST', { host: `127.0.0.1:${PORT}`, origin: 'https://aireiter.com' })), 'origin_not_allowed');
assert.equal(reason(req('POST', { host: `127.0.0.1:${PORT}`, origin: 'null' })), 'origin_not_allowed');
assert.equal(reason(req('DELETE', { host: `127.0.0.1:${PORT}`, origin: 'http://localhost:3000' })), 'origin_not_allowed');

// Cross-site subresource GET (img/fetch) blocked; top-level GET navigation allowed.
assert.equal(reason(req('GET', { host: `127.0.0.1:${PORT}`, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' })), 'cross_site_request');
assert.equal(ok(req('GET', { host: `127.0.0.1:${PORT}`, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })), true);
assert.equal(reason(req('POST', { host: `127.0.0.1:${PORT}`, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })), 'cross_site_request');

// Explicit extra origins and the kill switch.
assert.equal(checkLocalApiRequest(req('POST', { host: `127.0.0.1:${PORT}`, origin: 'http://localhost:3000' }), PORT, { MY_AGENT_ALLOWED_ORIGINS: 'http://localhost:3000/' }).ok, true);
assert.equal(checkLocalApiRequest(req('GET', { host: 'evil.example' }), PORT, { MY_AGENT_LOCAL_API_GUARD: '0' }).ok, true);

console.log('verify-local-api-guard: ok');
