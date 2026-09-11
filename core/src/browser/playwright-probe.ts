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

/**
 * A `chromium-*` directory alone does not mean the browser finished downloading:
 * an interrupted or antivirus-blocked bootstrap leaves a partial folder behind.
 * Require an actual browser binary so a half-installed tree is not reported as
 * available (otherwise the app tries to launch a corrupt Chromium).
 */
function chromiumDirHasBrowserBinary(browsers: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(browsers);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (!name.toLowerCase().startsWith('chromium')) continue;
    const winDir = path.join(browsers, name, 'chrome-win');
    if (
      existsSync(path.join(winDir, 'chrome.exe')) ||
      existsSync(path.join(winDir, 'headless_shell.exe'))
    ) {
      return true;
    }
  }
  return false;
}

export function isPlaywrightChromiumInstalled(cqrRoot: string): boolean {
  const browsers = resolvePlaywrightBrowsersPath(cqrRoot);
  const marker = path.join(browsers, '.chromium-installed');
  if (existsSync(marker)) return true;
  if (!existsSync(browsers)) return false;
  return chromiumDirHasBrowserBinary(browsers);
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
      reason: 'Chromium not installed',
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
