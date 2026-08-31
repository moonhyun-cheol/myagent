#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ollamaModelInstalled,
  resolveInstalledOllamaModel,
} from '../core/dist/providers/ollama-models.js';

const installed = ['qwen2.5:7b'];

assert.equal(resolveInstalledOllamaModel('qwen2.5:7b', installed), 'qwen2.5:7b');
assert.equal(
  resolveInstalledOllamaModel('qwen2.5:latest', installed),
  'qwen2.5:7b',
  'lone same-family tag must stand in for missing :latest',
);
assert.equal(resolveInstalledOllamaModel('qwen2.5', installed), 'qwen2.5:7b');
assert.equal(resolveInstalledOllamaModel('llama3:latest', installed), null);
assert.equal(
  resolveInstalledOllamaModel('qwen2.5:latest', ['qwen2.5:7b', 'qwen2.5:14b']),
  null,
  'must not guess among multiple same-family tags',
);
assert.equal(resolveInstalledOllamaModel('qwen2.5:latest', ['qwen2.5:latest']), 'qwen2.5:latest');
assert.equal(ollamaModelInstalled(['qwen2.5:7b'], 'qwen2.5:latest'), true);
assert.equal(ollamaModelInstalled(['qwen2.5:7b'], 'llama3:latest'), false);
assert.equal(
  ollamaModelInstalled(['qwen2.5:7b', 'qwen2.5:14b'], 'qwen2.5:latest'),
  false,
  ':latest is not a wildcard for every qwen2.5:* tag',
);

const picker = readFileSync(new URL('../core/src/models/model-picker.ts', import.meta.url), 'utf8');
assert.match(picker, /def\.id === 'ollama'/);
assert.match(picker, /listInstalledOllamaNames/);
assert.match(picker, /remapOllamaModelId/);

console.log('verify-ollama-models: PASS');
