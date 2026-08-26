#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectBuildLanes,
  PRODUCT_BUILD_LANES,
  RELEASE_BUILD_LANES,
  runBuildLanes,
} from './build-lanes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const assertFresh = args.includes('--assert-fresh');
const force = args.includes('--force');
const laneArg = args.find((arg) => arg.startsWith('--lanes='));
const lanes = laneArg
  ? laneArg.slice('--lanes='.length).split(',').map((lane) => lane.trim()).filter(Boolean)
  : RELEASE_BUILD_LANES;

for (const lane of lanes) {
  if (!RELEASE_BUILD_LANES.includes(lane)) throw new Error(`unknown build lane: ${lane}`);
}

function report(status, built = []) {
  console.log(JSON.stringify({
    built,
    lanes: Object.fromEntries(
      Object.entries(status).map(([lane, value]) => [
        lane,
        { stale: value.stale, reason: value.reason },
      ]),
    ),
  }, null, 2));
}

if (checkOnly || assertFresh) {
  const status = inspectBuildLanes(root);
  report(status);
  if (assertFresh && lanes.some((lane) => status[lane].stale)) process.exitCode = 1;
} else {
  const result = runBuildLanes(root, { lanes, force });
  report(result.status, result.built);
  if (lanes.some((lane) => result.status[lane].stale)) {
    console.error('build:smart failed to produce fresh selected lanes');
    process.exitCode = 1;
  }
}

export { PRODUCT_BUILD_LANES };
