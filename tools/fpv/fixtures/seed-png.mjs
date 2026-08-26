#!/usr/bin/env node
/** Minimal 1×1 PNG fixture for attachment/vision journeys. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = path.join(root, 'tools/fpv/fixtures/media');
mkdirSync(dir, { recursive: true });

// 1x1 PNG (red pixel)
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const out = path.join(dir, 'fpv-sample.png');
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
