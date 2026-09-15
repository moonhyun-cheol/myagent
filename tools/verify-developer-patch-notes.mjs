#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const notesPath = path.join(root, 'ui/workspace/src/data/developer-patch-notes.json');
const componentPath = path.join(root, 'ui/workspace/src/components/DeveloperPatchNotesMenu.tsx');
const allowedStatuses = new Set(['development', 'released']);
const allowedEntryKeys = ['area', 'created_at', 'detail', 'id', 'release', 'source_paths', 'status', 'title'];
const bannedPublicText = /(?:commit|sha\b|pull request|\bpr\b|branch|stack trace|stdout|stderr|request_?id|update_sequence|\.tsx\b|\.mjs\b|(?:src|core|tools)\/)/i;

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} keys must be exactly: ${wanted.join(', ')}`);
  }
}

try {
  const document = JSON.parse(readFileSync(notesPath, 'utf8'));
  const releaseManifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  exactKeys(document, ['schema', 'notes'], 'patch notes document');
  if (document.schema !== 'my-agent-developer-patch-notes/v1') fail('unsupported patch notes schema');
  if (!Array.isArray(document.notes) || document.notes.length === 0) fail('patch notes must not be empty');

  const ids = new Set();
  const titles = new Set();
  let previousDate = '9999-12-31';
  for (const [index, note] of document.notes.entries()) {
    const label = `notes[${index}]`;
    if (!note || typeof note !== 'object' || Array.isArray(note)) fail(`${label} must be an object`);
    exactKeys(note, allowedEntryKeys, label);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(note.id)) fail(`${label}.id must be stable kebab-case`);
    if (ids.has(note.id)) fail(`duplicate patch note id: ${note.id}`);
    ids.add(note.id);
    if (!allowedStatuses.has(note.status)) fail(`${label}.status must be development or released`);
    if (typeof note.title !== 'string' || note.title.trim().length < 4 || note.title.length > 60) fail(`${label}.title length is invalid`);
    if (typeof note.detail !== 'string' || note.detail.trim().length < 12 || note.detail.length > 240) fail(`${label}.detail length is invalid`);
    if (titles.has(note.title)) fail(`duplicate patch note title: ${note.title}`);
    titles.add(note.title);
    if (bannedPublicText.test(`${note.title}\n${note.detail}`)) fail(`${label} exposes internal implementation metadata`);
    if (typeof note.area !== 'string' || !/^[a-z][a-z0-9-]*$/.test(note.area)) fail(`${label}.area is invalid`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(note.created_at) || Number.isNaN(Date.parse(`${note.created_at}T00:00:00Z`))) fail(`${label}.created_at is invalid`);
    if (note.created_at > previousDate) fail('patch notes must be newest first');
    previousDate = note.created_at;

    if (!note.release || typeof note.release !== 'object' || Array.isArray(note.release)) fail(`${label}.release must be an object`);
    exactKeys(note.release, ['update_sequence', 'version'], `${label}.release`);
    if (note.status === 'development') {
      if (note.release.version !== null || note.release.update_sequence !== null) fail(`${label} development note must not claim a release`);
    } else {
      if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(note.release.version)) fail(`${label} released note requires a valid version`);
      if (!Number.isSafeInteger(note.release.update_sequence) || note.release.update_sequence < 1) fail(`${label} released note requires update_sequence`);
      if (note.release.version !== releaseManifest.version || note.release.update_sequence !== releaseManifest.update_sequence) {
        fail(`${label} released state must match the current release manifest`);
      }
    }

    if (!Array.isArray(note.source_paths) || note.source_paths.length === 0) fail(`${label}.source_paths must contain evidence`);
    for (const sourcePath of note.source_paths) {
      if (typeof sourcePath !== 'string' || path.isAbsolute(sourcePath) || sourcePath.includes('..')) fail(`${label} has an unsafe source path`);
      if (!existsSync(path.join(root, sourcePath))) fail(`${label} source path does not exist: ${sourcePath}`);
    }
  }

  const component = readFileSync(componentPath, 'utf8');
  if (!component.includes("../data/developer-patch-notes.json")) fail('DeveloperPatchNotesMenu must render the structured patch note SSOT');
  if (/const\s+PATCH_NOTES\s*=/.test(component)) fail('component-local patch note arrays are forbidden');
  console.log(`developer patch notes: PASS (${document.notes.length} entries)`);
} catch (error) {
  console.error(`developer patch notes: FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
