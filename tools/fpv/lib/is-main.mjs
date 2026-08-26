#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** True when this module was launched directly via `node path/to/file.mjs`. */
export function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === importMetaUrl;
  } catch {
    return false;
  }
}
