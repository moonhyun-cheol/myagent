#!/usr/bin/env node
/**
 * Smoke test: explicit history exclusion, secret/channel filters, and reply plumbing.
 * node tools/test-chat-ux-guards.mjs
 */
import {
  sanitizeHistoryForModel,
  shouldExcludeFromModelContext,
} from '../core/dist/chat/chat-filters.js';
import {
  applyChatOutletFilter,
} from '../core/dist/chat/chat-filters.js';
import { buildEditorContextSnippet } from '../core/dist/chat/editor-context.js';
import { scrubAgentChannelLeak } from '../core/dist/chat/chat-filters.js';
import { appendAssistantReply } from '../core/dist/chat/assistant-reply.js';

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  } else {
    console.log('ok:', msg);
  }
}

// --- History sanitization ---
{
  const polluted = [
    { role: 'user', content: '레이아웃 고쳐줘' },
    {
      role: 'assistant',
      content:
        '도구는 정상입니다. 모델이 소스 파일 붙여넣기를 요청하는 환각을 냈습니다. 같은 요청을 다시 보내 주세요.',
    },
    { role: 'user', content: '다시 시도' },
    { role: 'assistant', content: 'app.css 패딩을 12px로 늘렸습니다.', model_exclude: false },
    {
      role: 'assistant',
      content: 'Message blocked by inlet filter.',
      model_exclude: true,
    },
  ];
  const clean = sanitizeHistoryForModel(polluted);
  assert(clean.length === 4, `sanitize honors only explicit model_exclude (got ${clean.length})`);
  assert(
    shouldExcludeFromModelContext({ role: 'assistant', content: 'x', model_exclude: true }),
    'model_exclude flag honored',
  );
}

// --- Agent channel leak scrub ---
{
  const leaked =
    '현재 우선순위는 안정성입니다.\n\n[P:commentary]: #\n';
  const out = applyChatOutletFilter(leaked);
  assert(!/\[P:commentary\]/.test(out.text), 'outlet strips [P:commentary]');
  assert(/안정성/.test(out.text), 'real answer kept after channel scrub');
}

// --- Editor context and reply plumbing ---
{
  assert(
    !buildEditorContextSnippet({ path: 'buffer.tsx', selection: 'fake' }),
    'synthetic buffer.tsx editor context omitted',
  );
  assert(
    /에디터 참고/.test(buildEditorContextSnippet({ path: 'ui/workspace/src/components/ChatPane.tsx' }) || ''),
    'real editor path still attached',
  );
  assert(
    !/\[P:/.test(scrubAgentChannelLeak('본문입니다.\n[P:commentary]: #\n')),
    'scrubAgentChannelLeak helper',
  );
  assert(
    typeof appendAssistantReply === 'function',
    'appendAssistantReply exported for all modes',
  );
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll chat UX guard checks passed.');
