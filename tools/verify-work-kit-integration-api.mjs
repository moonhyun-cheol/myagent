#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createApiServer } from '../core/dist/api-server.js';

const server = await createApiServer(0);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  for (const pathname of ['/launcher', '/launcher/', '/launcher/index.html', '/launcher/assets/legacy.js']) {
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status, 404, `${pathname} must be 404`);
  }
  const workspace = await fetch(`${base}/`);
  assert.equal(workspace.status, 200);
  console.log('verify-work-kit-integration-api: /launcher/* 404 and workspace / available');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
