import { test, expect } from '@playwright/test';

/** Full browser UI regression — requires Chromium (`bootstrap-playwright` or `npx playwright install`). */
test.describe('MY Agent UI smoke', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('loads primary workspace chat shell', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle').catch(() => undefined);
    // Product brand in GeminiNavSidebar (· between CQR and PA) or document title
    await expect(page.getByText(/CQR/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('textarea:not([aria-hidden="true"])').first()).toBeVisible();
    await expect(page.getByRole('button', { name: '전송' })).toBeVisible();
  });

  test('workspace exposes its primary navigation', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle').catch(() => undefined);
    // Expand sidebar if collapsed (icon-only rail)
    const expand = page.getByTitle('사이드바 펼치기');
    if (await expand.isVisible().catch(() => false)) {
      await expand.click();
    }
    await expect(page.getByText('CQR').first()).toBeVisible({ timeout: 20_000 });
    // Prefer text match so icon-only dual instances of the same action don't double-hit
    for (const name of ['새 채팅', '노트북', '스킬', '플러그인', '모델', '파일']) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    }
  });

  test('composer exposes @ context affordance', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await expect(page.getByTestId('context-at-button')).toBeVisible({ timeout: 20_000 });
  });
});
