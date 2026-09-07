import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Exercise the freshly built UI, not the potentially older bundle served by a
// running desktop instance. API reads may continue; all writes are blocked.
const dist = path.resolve('ui/workspace/dist');
const skills = [
  { id: 'sample', label: '샘플 사이즈', selectable: false },
  { id: 'research', label: '시장조사', selectable: true },
  { id: 'concept', label: '컨셉 RA', selectable: true },
  { id: 'brand', label: 'CQR 브랜드', selectable: false },
].map((skill) => ({ ...skill, mode: `org:${skill.id}`, source: 'organization', editable: false }));

test.use({ channel: process.env.CQR_E2E_BROWSER_CHANNEL ?? 'msedge', viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') return route.fulfill({ status: 403, body: 'UI regression: writes blocked' });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: await readFile(path.join(dist, 'index.html')) });
    if (/^\/assets\/[\w.-]+$/.test(url.pathname)) return route.fulfill({ path: path.join(dist, url.pathname) });
    if (url.pathname === '/skills') return route.fulfill({ json: { skills } });
    if (url.pathname === '/skills/selectable') return route.fulfill({ json: { skills: skills.filter((skill) => skill.selectable) } });
    if (url.pathname === '/organization-module') return route.fulfill({ json: { can_check_remote: false } });
    return route.continue();
  });
  await page.goto('/');
  await expect(page.getByTestId('skill-status-bar')).toBeVisible();
});

async function choose(page: Page, label: string) {
  await page.getByTestId('organization-skill-button').click();
  await page.getByTestId('organization-skill-menu').getByRole('button', { name: label, exact: true }).click();
}

async function openSkills(page: Page) {
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page.getByRole('button', { name: '스킬', exact: true }).click();
  await page.getByText('고급 · 스킬 관리', { exact: true }).click();
  await expect(page.getByTestId('organization-skill-chips')).toBeVisible();
}

async function expectTextContrast(locator: Locator) {
  const ratio = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    const luminance = (color: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
        const s = value / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const fg = luminance(style.color);
    const bg = luminance(style.backgroundColor);
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
  return ratio;
}

test('selection, switching and clear stay synchronized with settings', async ({ page }) => {
  const bar = page.getByTestId('skill-status-bar');
  await expect(bar).toHaveAttribute('data-active', 'false');
  await expect(bar).toContainText('스킬 미적용');
  await expectTextContrast(bar);
  await openSkills(page);
  await expect(page.getByTestId('organization-skill-chips').locator('[data-active="true"]')).toHaveCount(0);
  await expect(page.getByTestId('organization-skill-chips')).toContainText('현재 대화: 스킬 미적용');
  // Non-selectable org skills (sample/brand) must not appear in Settings chips.
  await expect(page.getByTestId('organization-skill-sample')).toHaveCount(0);
  await expect(page.getByTestId('organization-skill-brand')).toHaveCount(0);
  await expect(page.getByTestId('organization-skill-research')).toBeVisible();
  await expect(page.getByTestId('organization-skill-concept')).toBeVisible();
  await page.getByRole('button', { name: '설정 닫기' }).click();

  await choose(page, '시장조사');
  await expect(bar).toHaveAttribute('data-active', 'true');
  await expect(bar).toContainText('스킬 적용 중');
  await expect(bar).toContainText('시장조사');
  const activeContrast = await expectTextContrast(bar);
  await expectTextContrast(page.getByTestId('skill-status-action'));
  await openSkills(page);
  const chips = page.getByTestId('organization-skill-chips');
  await expect(chips.locator('[data-active="true"]')).toHaveCount(1);
  await expect(page.getByTestId('organization-skill-research')).toContainText('적용 중');
  await expect(page.getByTestId('organization-skill-concept')).toContainText('미적용');
  await expectTextContrast(page.getByTestId('organization-skill-research'));
  await expectTextContrast(page.getByTestId('organization-skill-research').locator('span').last());
  await page.getByRole('button', { name: '설정 닫기' }).click();

  await choose(page, '컨셉 RA');
  await expect(bar).toContainText('컨셉 RA');
  await openSkills(page);
  await expect(page.getByTestId('organization-skill-concept')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('organization-skill-research')).toHaveAttribute('data-active', 'false');
  await page.getByRole('button', { name: '설정 닫기' }).click();
  await page.getByTestId('skill-status-action').click();
  await expect(bar).toContainText('스킬 미적용');
  await openSkills(page);
  await expect(chips.locator('[data-active="true"]')).toHaveCount(0);
  console.log(`Active status contrast: ${activeContrast.toFixed(2)}:1`);
});

test('keyboard selection, pressed state and existing toggle-off work', async ({ page }) => {
  const action = page.getByTestId('skill-status-action');
  await action.focus();
  await action.press('Enter');
  const menu = page.getByTestId('organization-skill-menu');
  const research = menu.getByRole('button', { name: '시장조사', exact: true });
  await research.focus();
  await research.press('Enter');
  await page.getByTestId('organization-skill-button').click();
  const selected = menu.getByRole('button', { pressed: true });
  await expect(selected).toContainText('시장조사 · 적용 중');
  await expectTextContrast(selected);
  await selected.click();
  await expect(page.getByTestId('skill-status-bar')).toHaveAttribute('data-active', 'false');
  await choose(page, '컨셉 RA');
  await page.getByTestId('organization-skill-button').click();
  await page.getByTestId('organization-skill-clear').click();
  await expect(page.getByTestId('skill-status-bar')).toContainText('스킬 미적용');
});

test('long skill labels wrap at narrower desktop width', async ({ page }) => {
  const longLabel = '아주 긴 조직 스킬 이름과 적용 상태 확인 '.repeat(8);
  const longSkill = { ...skills[1], label: longLabel };
  await page.route('**/skills', (route) => route.fulfill({ json: { skills: [longSkill] } }));
  await page.route('**/skills/selectable', (route) => route.fulfill({ json: { skills: [longSkill] } }));
  await page.reload();
  await page.setViewportSize({ width: 900, height: 900 });
  const closePreview = page.getByTitle('Preview 닫기', { exact: true });
  if (await closePreview.isVisible()) await closePreview.click();
  await choose(page, longLabel.trim());
  const bar = page.getByTestId('skill-status-bar');
  await expect(bar).toContainText(longLabel.trim());
  await expect(page.getByTestId('skill-status-action')).toBeVisible();
  expect(await bar.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await openSkills(page);
  const chips = page.getByTestId('organization-skill-chips');
  expect(await chips.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(page.getByTestId('organization-skill-research')).toContainText('적용 중');
});
