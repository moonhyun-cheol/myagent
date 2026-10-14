#!/usr/bin/env node
/**
 * Model-switch notice: stored model refs only, one-shot, turn context not system.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appendTurnContext } from '../core/dist/agent/agent-context-assembler.js';
import { wrapUserMessageWithContext } from '../core/dist/chat/chat-context.js';
import {
  detectModelSwitch,
  formatModelSwitchTurnNote,
  formatResumeModelSwitchLine,
  prependModelSwitchContext,
  sameModelRef,
} from '../core/dist/chat/model-switch.js';

const A = 'OpenRouter/anthropic/claude-opus-5.5';
const B = 'OpenRouter/openai/gpt-6-astra';
const reply = (model, extra = {}) => ({ role: 'assistant', content: 'done', model, mode: 'chat', ...extra });

assert.equal(detectModelSwitch([], A), null, 'first request has no notice');
assert.equal(detectModelSwitch([reply(A), reply(A)], A), null, 'same model has no notice');
assert.equal(
  detectModelSwitch([reply(A)], 'anthropic/claude-opus-5.5'),
  null,
  'display-prefix and bare vendor/model are the same model',
);
assert.equal(sameModelRef('OpenAI/gpt-4o', 'gpt-4o'), true);

{
  const hit = detectModelSwitch([reply(A), reply(A), reply(A)], B);
  assert.ok(hit, 'switch is detected');
  assert.equal(hit.previous, A);
  assert.equal(hit.current, B);
  assert.equal(hit.previousReplies, 3);
  const note = formatModelSwitchTurnNote(hit);
  assert.match(note, /### Model switch/);
  assert.match(note, /OpenRouter\/anthropic\/claude-opus-5\.5/);
  assert.match(note, /previous 3 replies/);
}

{
  const after = [reply(A), reply(B)];
  assert.equal(detectModelSwitch(after, B), null, 'notice disappears after the new model replies once');
}

{
  const history = [
    reply('browser/playwright', { mode: 'browser_automation' }),
    reply('org/market_research', { mode: 'org:market_research' }),
    reply('google/veo-3.1-fast', { video_job: { job_id: 'v1' } }),
    reply('filter/inlet', { model_exclude: true }),
    reply('', { application_notice: { kind: 'failure' }, content: '' }),
    reply(A, { status: 'stopped', content: '' }),
    reply(A),
  ];
  const hit = detectModelSwitch(history, B);
  assert.equal(hit?.previousReplies, 1, 'non-language replies are ignored');
  assert.equal(hit?.previous, A);
  assert.equal(detectModelSwitch([reply('google/veo-3.1-fast')], A), null, 'video catalog ids are not language models');
}

{
  const system = 'STATIC SYSTEM PREFIX';
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: 'continue' },
  ];
  const note = formatModelSwitchTurnNote(detectModelSwitch([reply(A)], B));
  appendTurnContext(messages, note);
  assert.equal(messages[0].content, system, 'system prefix is byte-identical');
  const turn = messages.find((message) => String(message.content).includes('### Model switch'));
  assert.equal(turn?.role, 'user', 'agent notice is turn context, not system');
  assert.match(String(turn?.content), /not written by the user/);
}

{
  const system = 'CHAT SYSTEM';
  const ctx = prependModelSwitchContext('attachment note', [reply(A)], B);
  const user = wrapUserMessageWithContext('hello', ctx);
  assert.match(user, /### Model switch/);
  assert.match(user, /attachment note/);
  assert.equal(system, 'CHAT SYSTEM', 'chat system string is untouched');
  assert.equal(prependModelSwitchContext(undefined, [reply(A)], A), undefined);
}

{
  const line = formatResumeModelSwitchLine(A, B);
  assert.match(line, /progressed by/);
  assert.match(line, /gpt-6-astra/);
  const covered = detectModelSwitch([reply(A)], B);
  const resumeExtra = covered ? '' : line;
  assert.equal(resumeExtra, '', 'resume line is omitted when the turn-context notice already fired');
  assert.match(formatResumeModelSwitchLine(A, B), /resuming it/);
  const loop = readFileSync(new URL('../core/src/agent/agent-run-loop.ts', import.meta.url), 'utf8');
  assert.match(loop, /if \(snapModel && !modelSwitch && !sameModelRef/);
  assert.match(loop, /appendTurnContext\(messages, formatModelSwitchTurnNote\(modelSwitch\)\)/);
}

console.log('verify-model-switch-notice: ok');
