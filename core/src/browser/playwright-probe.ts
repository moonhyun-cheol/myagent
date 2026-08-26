import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface PlaywrightProbeResult {
  available: boolean;
  module_path: string | null;
  browsers_path: string;
  chromium_installed: boolean;
  reason?: string;
}

export function resolvePlaywrightBrowsersPath(cqrRoot: string): string {
  return path.join(cqrRoot, 'runtime', 'playwright', 'browsers');
}

function playwrightPackageCandidates(cqrRoot: string): string[] {
  return [
    path.join(cqrRoot, 'node_modules', 'playwright', 'package.json'),
    path.join(cqrRoot, 'runtime', 'playwright', 'package', 'node_modules', 'playwright', 'package.json'),
  ];
}

export function resolvePlaywrightModuleRoot(cqrRoot: string): string | null {
  for (const pkg of playwrightPackageCandidates(cqrRoot)) {
    if (existsSync(pkg)) return path.dirname(pkg);
  }
  return null;
}

export function isPlaywrightChromiumInstalled(cqrRoot: string): boolean {
  const browsers = resolvePlaywrightBrowsersPath(cqrRoot);
  const marker = path.join(browsers, '.chromium-installed');
  if (existsSync(marker)) return true;
  if (!existsSync(browsers)) return false;
  try {
    return readdirSync(browsers).some((name) => name.toLowerCase().startsWith('chromium'));
  } catch {
    return false;
  }
}

export function probePlaywright(cqrRoot: string): PlaywrightProbeResult {
  const browsers_path = resolvePlaywrightBrowsersPath(cqrRoot);
  const moduleRoot = resolvePlaywrightModuleRoot(cqrRoot);
  const chromium_installed = isPlaywrightChromiumInstalled(cqrRoot);
  if (!moduleRoot) {
    return {
      available: false,
      module_path: null,
      browsers_path,
      chromium_installed,
      reason: 'playwright npm package not installed',
    };
  }
  if (!chromium_installed) {
    return {
      available: false,
      module_path: moduleRoot,
      browsers_path,
      chromium_installed: false,
      reason: 'Chromium not installed — run tools/bootstrap-playwright.ps1 (Playwright zip is NOT bundled; on-demand bootstrap only)',
    };
  }
  return {
    available: true,
    module_path: moduleRoot,
    browsers_path,
    chromium_installed: true,
  };
}

export function isPlaywrightAvailable(cqrRoot: string): boolean {
  return probePlaywright(cqrRoot).available;
}

export function applyPlaywrightEnv(cqrRoot: string): void {
  process.env.PLAYWRIGHT_BROWSERS_PATH = resolvePlaywrightBrowsersPath(cqrRoot);
}

export async function importPlaywright(cqrRoot: string): Promise<{
  chromium: { launch(opts: { headless: boolean }): Promise<unknown> };
}> {
  applyPlaywrightEnv(cqrRoot);
  try {
    return await import('playwright');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`PLAYWRIGHT_IMPORT_FAILED: ${msg}`);
  }
}
