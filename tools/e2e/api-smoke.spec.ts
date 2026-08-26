import { test, expect } from '@playwright/test';

/** API-only smoke — no browser binary required (verify:e2e default). */
test.describe('MY Agent API smoke', () => {
  test('health responds', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.ui).toBe('workspace');
    expect(data.legacy_ui).toBeUndefined();
  });

  test('model picker endpoint responds', async ({ request }) => {
    const res = await request.get('/models/picker');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(Array.isArray(data.options)).toBeTruthy();
  });

  test('static UI index is served', async ({ request }) => {
    const res = await request.get('/');
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toMatch(/\/assets\/index-[^"]+\.js/);
  });

  test('removed legacy routes are not served', async ({ request }) => {
    for (const route of ['/legacy', '/legacy/', '/legacy/index.html', '/legacy/ui/chat/app.js', '/ui/chat/app.js']) {
      const res = await request.get(route);
      expect(res.status(), route).toBe(404);
    }
  });

  test('skills list includes domain market skill', async ({ request }) => {
    const res = await request.get('/skills');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.skills ?? data.items ?? []);
    expect(Array.isArray(list)).toBeTruthy();
    const blob = JSON.stringify(list);
    expect(blob).toMatch(/cqr_market|시장|market/i);
  });

  test('agent-plugins REST responds (local tools catalog)', async ({ request }) => {
    const res = await request.get('/agent-plugins');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(Array.isArray(data.plugins)).toBeTruthy();
    expect(Array.isArray(data.templates)).toBeTruthy();
    const blob = JSON.stringify(data.templates);
    expect(blob).toMatch(/git_history_tree|demo_echo|vcs_tree/);
  });

  test('user MCP servers REST responds', async ({ request }) => {
    const res = await request.get('/mcp/servers');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.ok).toBeTruthy();
    expect(Array.isArray(data.servers)).toBeTruthy();
  });

  test('terminal cancel endpoint accepts empty job', async ({ request }) => {
    const res = await request.post('/fs/run-terminal/cancel', {
      data: { job_id: 'nonexistent_e2e' },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.ok).toBeTruthy();
    expect(data.cancelled).toBe(false);
  });

  test('checkpoint preview requires args', async ({ request }) => {
    const res = await request.get('/workspace/checkpoint/preview');
    expect(res.status()).toBe(400);
  });

  test('terminal jobs list endpoint', async ({ request }) => {
    const res = await request.get('/fs/run-terminal/jobs');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.ok).toBeTruthy();
    expect(Array.isArray(data.jobs)).toBeTruthy();
  });
});
