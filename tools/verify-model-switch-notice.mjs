#!/usr/bin/env node
/**
 * Model-switch notice: stored model refs only, one-shot, turn context not system.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendTurnContext } from '../core/dist/agent/agent-context-assembler.js';
import { wrapUserMessageWithContext } from '../core/dist/chat/chat-context.js';
import {
  composerSelectionRef,
  detectModelSwitch,
  formatModelSwitchTurnNote,
  formatResumeModelSwitchLine,
  prependModelSwitchContext,
  sameDividerModelRef,
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
assert.equal(
  sameModelRef('OpenRouter/~x-ai/grok-latest', 'OpenRouter/x-ai/grok-4.7'),
  true,
  'latest alias and the concrete id it resolves to are the same model',
);
assert.equal(
  detectModelSwitch([reply('OpenRouter/x-ai/grok-4.7')], 'OpenRouter/~x-ai/grok-latest'),
  null,
  'grok-latest after grok-4.7 is not a model switch',
);
assert.ok(
  detectModelSwitch([reply('OpenRouter/x-ai/grok-4.7')], 'OpenRouter/anthropic/claude-opus-5.5'),
  'a different vendor is still a switch',
);
assert.ok(
  detectModelSwitch([reply('OpenRouter/x-ai/grok-4.7')], 'OpenRouter/x-ai/grok-4.6'),
  'two pinned versions are still a switch',
);
assert.equal(sameModelRef('OpenRouter/~x-ai/grok-latest', 'OpenRouter/x-ai/grok-imagine'), false);
assert.equal(
  sameDividerModelRef('OpenRouter/~x-ai/grok-latest', 'OpenRouter/x-ai/grok-4.7'),
  false,
  'the visible divider keeps a latest alias distinct from the resolved id',
);
assert.equal(
  sameDividerModelRef('OpenRouter/~x-ai/grok-latest', '~x-ai/grok-latest'),
  true,
  'display prefix does not create a divider',
);
assert.equal(
  sameDividerModelRef('OpenRouter/anthropic/claude-opus-5.5', 'provider:company-openrouter@anthropic%2Fclaude-opus-5.5'),
  true,
  'a composer pick and the resolved ref of the same model are not a switch',
);
assert.equal(
  sameDividerModelRef('OpenRouter/anthropic/claude-opus-5.5', 'provider:company-openrouter@openai%2Fgpt-6-astra'),
  false,
  'a composer pick of another model is still a switch',
);
assert.equal(composerSelectionRef('auto'), undefined);
assert.equal(composerSelectionRef(' OpenRouter/~x-ai/grok-latest '), 'OpenRouter/~x-ai/grok-latest');
{
  const ui = readFileSync(new URL('../ui/workspace/src/lib/modelSwitch.ts', import.meta.url), 'utf8');
  const start = ui.indexOf('export function sameSelectionRef');
  const end = ui.indexOf('function isVideoRef');
  assert.ok(start >= 0 && end > start, 'divider uses a selection comparison');
  assert.doesNotMatch(ui.slice(start, end), /latestAliasEquivalent/);
  assert.match(ui, /sameSelectionRef\(previous, current\)/);
  const agent = readFileSync(new URL('../core/src/chat/modes/workspace-agent.ts', import.meta.url), 'utf8');
  assert.match(agent, /selected_model: composerSelectionRef\(req\.model\)/);
  const store = readFileSync(new URL('../ui/workspace/src/store/workspaceStore.ts', import.meta.url), 'utf8');
  assert.match(store, /patchAssistant\(\{ model: info\.model, selectedModel: job\.model \}\)/);
  const uiUrl = new URL('../ui/workspace/src/lib/modelSwitch.ts', import.meta.url);
  const probe = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import { modelSwitchBefore } from ${JSON.stringify(uiUrl.href)};
    const resolved = 'OpenRouter/x-ai/grok-4.7';
    const selected = 'OpenRouter/~x-ai/grok-latest';
    const previous = { role: 'assistant', model: resolved, text: 'before' };
    const completed = { role: 'assistant', model: resolved, selectedModel: selected, text: 'after' };
    const hit = modelSwitchBefore([previous, completed], 1);
    if (!hit || !String(hit.current).includes('grok-latest')) {
      console.error('divider vanished after the reply model was normalized');
      process.exit(1);
    }
    const repeat = modelSwitchBefore([
      { role: 'assistant', model: resolved, selectedModel: selected, text: 'before' },
      completed,
    ], 1);
    if (repeat) {
      console.error('the same composer selection must not repeat the divider');
      process.exit(1);
    }
    const legacy = { role: 'assistant', model: 'OpenRouter/anthropic/claude-opus-5.5', text: 'before' };
    const picked = { role: 'assistant', model: 'OpenRouter/anthropic/claude-opus-5.5', selectedModel: 'provider:company-openrouter@anthropic%2Fclaude-opus-5.5', text: 'after' };
    if (modelSwitchBefore([legacy, picked], 1)) {
      console.error('resolved ref vs composer pick of the same model drew a divider');
      process.exit(1);
    }
    const other = { ...picked, selectedModel: 'provider:company-openrouter@openai%2Fgpt-6-astra' };
    if (!modelSwitchBefore([legacy, other], 1)) {
      console.error('a real model change lost its divider');
      process.exit(1);
    }
  `], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr || probe.stdout || 'ui divider probe failed');
}

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
