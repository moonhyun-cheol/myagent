#!/usr/bin/env node
import { runL0 } from './runners/l0.mjs';

runL0()
  .then((r) => {
    console.log(`\n=== FPV L0 ok=${r.ok} (${r.rows.filter((x) => x.ok).length}/${r.rows.length}) ===`);
    process.exit(r.ok ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
