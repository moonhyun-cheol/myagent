#!/usr/bin/env node
import { runJourneys } from './runners/journeys.mjs';

runJourneys()
  .then((r) => {
    console.log(`\n=== FPV L4 ok=${r.ok} ===`);
    for (const row of r.rows) console.log(`  ${row.tag} ${row.id}`);
    process.exit(r.ok ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
