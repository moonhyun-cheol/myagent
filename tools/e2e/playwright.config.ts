import { defineConfig } from '@playwright/test';

/** Dev/CI UI regression — requires MY Agent API on http://127.0.0.1:10200 */
export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.CQR_E2E_BASE_URL ?? 'http://127.0.0.1:10200',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  reporter: [['list']],
});
