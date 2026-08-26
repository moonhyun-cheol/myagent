#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_BUILD_LANES, runBuildLanes } from './build-lanes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  const result = runBuildLanes(root, { lanes: PRODUCT_BUILD_LANES, force: true });
  console.log(`build ok -> ${result.built.join(', ')}`);
} catch (error) {
  console.error(`build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
