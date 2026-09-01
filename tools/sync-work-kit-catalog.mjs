#!/usr/bin/env node
/**
 * Dev/CI CLI — refresh work-kit catalog feed or install one shelf.
 */
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installWorkKitShelf,
  refreshWorkKitCatalog,
} from '../core/dist/updates/work-kit-catalog-feed.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values } = parseArgs({
  options: {
    feed: { type: 'string' },
    locker: { type: 'string' },
    root: { type: 'string', default: repoRoot },
    refresh: { type: 'boolean', default: false },
    install: { type: 'string' },
    'meta-only': { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

const cqrRoot = path.resolve(values.root ?? repoRoot);
const lockerRoot = values.locker?.trim() || undefined;
const feed = values.feed?.trim();

if (!feed) {
  console.error('Usage: node tools/sync-work-kit-catalog.mjs --feed <url|local.json> [--refresh] [--install group/id] [--locker path] [--root cqrRoot]');
  process.exit(1);
}

const feedPath = feed.startsWith('http://') || feed.startsWith('https://') ? undefined : path.resolve(feed);
const feedUrl = feedPath ? undefined : feed;

async function main() {
  if (values.refresh || !values.install) {
    const doc = await refreshWorkKitCatalog(cqrRoot, {
      lockerRoot,
      feedPath,
      feedUrl,
    });
    console.log(`refreshed catalog sequence=${doc.sequence} groups=${doc.groups.length}`);
  }

  const installTarget = values.install?.trim();
  if (installTarget) {
    const [group, id] = installTarget.split('/');
    if (!group || !id) {
      console.error('--install requires group/id format, e.g. cqr/product-dev');
      process.exit(1);
    }
    const result = await installWorkKitShelf(cqrRoot, group, id, {
      lockerRoot,
      feedPath,
      forceMetaOnly: values['meta-only'] === true,
    });
    console.log(`installed ${result.group}/${result.id} → ${result.shelf_dir}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
