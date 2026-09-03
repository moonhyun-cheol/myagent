#!/usr/bin/env node
/**
 * One-time migration: personal-scheduler.sqlite -> JSON document store.
 * Usage: node tools/migrate-scheduler-sqlite-to-json.mjs [schedulerRoot]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schedulerRoot = path.resolve(process.argv[2] || path.join(root, 'data', 'scheduler'));

const { migrateSchedulerSqliteToJson } = await import(
  path.join(root, 'core', 'dist', 'scheduler', 'migrate-sqlite-to-json.js')
);

const migrated = migrateSchedulerSqliteToJson(schedulerRoot);
console.log(
  migrated
    ? `migrate-scheduler-sqlite-to-json: migrated ${schedulerRoot}`
    : `migrate-scheduler-sqlite-to-json: nothing to do (${schedulerRoot})`,
);
process.exit(migrated ? 0 : 0);
