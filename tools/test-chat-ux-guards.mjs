#!/usr/bin/env node
/**
 * Smoke test: history sanitization + paste-source guard precision.
 * node tools/test-chat-ux-guards.mjs
 */
import {
  sanitizeHistoryForModel,
  isHistoryPollutionAssistantContent,
  shouldExcludeFromModelContext,
} from '../core/dist/chat/chat-filters.js';
import {
  contentAsksUserToPasteFiles,
  contentClaimsToolsUnavailable,
  contentLooksLikeTokenSalad,
  contentDefersFileEdit,
  isClipboardImagePasteTalk,
} from '../core/dist/agent/tools.js';
import {
  applyChatOutletFilter,
} from '../core/dist/chat/chat-filters.js';
import {
  appendChatResponseStyle,
  appendCodeResponseStyle,
  appendMarketResponseStyle,
  looksLikeAcceptanceReviewTask,
} from '../core/dist/router/route-heuristics.js';
import { buildEditorContextSnippet } from '../core/dist/chat/editor-context.js';
import {
  looksLikeExplainOrReportTask,
  looksLikeToolTask,
  looksLikeIncompleteExplainAnswer,
} from '../core/dist/agent/code-agent.js';
import { scrubAgentChannelLeak, looksLikeTruncatedAssistantReply } from '../core/dist/chat/chat-filters.js';
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
  assert(clean.length === 3, `sanitize drops guard notices (got ${clean.length})`);
  assert(
    !clean.some((m) => /환각|blocked by inlet/i.test(m.content)),
    'no pollution text in model history',
  );
  assert(isHistoryPollutionAssistantContent('환각 답변 차단 — read_file 강제'), 'pollution detector');
  assert(
    !isHistoryPollutionAssistantContent(
      '원인은 app.css의 padding입니다.\n\n```css\n.composer{padding:12px}\n```\n\n다음으로 새로고침하세요.',
    ),
    'real answers are not pollution',
  );
  assert(
    shouldExcludeFromModelContext({ role: 'assistant', content: 'x', model_exclude: true }),
    'model_exclude flag honored',
  );
}

// --- Paste-source guard precision ---
{
  assert(
    isClipboardImagePasteTalk('Ctrl+V로 이미지 붙여넣기를 workspace composer에 이식하자'),
    'clipboard image talk detected',
  );
  assert(
    !contentAsksUserToPasteFiles('Ctrl+V 이미지 붙여넣기 기능을 추가해 주세요'),
    'image paste feature request not blocked',
  );
  assert(
    !contentAsksUserToPasteFiles('paste 이벤트와 clipboardData로 구현하면 됩니다'),
    'paste event talk not blocked',
  );
  assert(
    contentAsksUserToPasteFiles('CSS 파일을 여기로 붙여넣어 주세요'),
    'source paste ask still blocked',
  );
  assert(
    contentAsksUserToPasteFiles('소스 코드 파일 내용을 공유해 주세요'),
    'source share ask still blocked',
  );
  assert(
    !contentClaimsToolsUnavailable('이미지 붙여넣기는 clipboard API로 처리합니다'),
    'clipboard feature not tools-unavailable',
  );
  assert(
    contentClaimsToolsUnavailable('Tool not found — Manager Restart 필요'),
    'tool-server fiction still caught',
  );
}

// --- Token-salad guard ---
{
  const salad =
    '@憨揉迅农谚:/*早发},{ndenverle burge：course后台-END依生活5性价 ₹in"identi '
    + 'incapsodesirk doença,; Roberto-ademirodon bagaruvinuis bornfj政权1 '
    + 'nORIZGF段batim createStackNavigator 跌破lashes26 маял.trueerableca '
    + 'sendStatusFeedback/sweetalert折当年aspx 娱乐场选做水仙 mappedBy addObject';
  assert(contentLooksLikeTokenSalad(salad), 'token salad detected');
  assert(
    !contentLooksLikeTokenSalad(
      '결론: 새 채팅은 standalone 세션을 만듭니다.\n원인: activeProjectId를 넘기고 있었습니다.\n수정: startNewChat(null)로 변경했습니다.',
    ),
    'normal Korean answer not salad',
  );
  const outlet = applyChatOutletFilter(salad);
  assert(/손상되어 표시하지 않았습니다/.test(outlet.text), 'outlet replaces token salad');
  assert(
    isHistoryPollutionAssistantContent('모델 출력이 손상되어 표시하지 않았습니다. 같은 요청을 다시 보내 주세요.'),
    'salad block notice is pollution',
  );
}

// --- Mode response styles ---
{
  const chat = appendChatResponseStyle(undefined);
  assert(
    /Lead with the conclusion/i.test(chat),
    'chat style present',
  );
  const code = appendCodeResponseStyle('base');
  assert(/Cause — brief root-cause/i.test(code) && code.startsWith('base'), 'code style appended');
  assert(/Acceptance review branch/i.test(code), 'code style has acceptance review branch');
  assert(
    looksLikeAcceptanceReviewTask('이 확장 요구대로 됐는지 검토해줘'),
    'acceptance review intent detected',
  );
  assert(
    !looksLikeAcceptanceReviewTask('math.ts 의 add 고쳐줘'),
    'plain edit is not acceptance review',
  );
  const market = appendMarketResponseStyle(undefined);
  assert(/Evidence — key facts/i.test(market), 'market style present');
}

// --- Agent channel leak scrub ---
{
  const leaked =
    '현재 우선순위는 안정성입니다.\n\n[P:commentary]: #\n';
  const out = applyChatOutletFilter(leaked);
  assert(!/\[P:commentary\]/.test(out.text), 'outlet strips [P:commentary]');
  assert(/안정성/.test(out.text), 'real answer kept after channel scrub');
}

// --- Explain vs invent-edit drift ---
{
  assert(
    looksLikeExplainOrReportTask('이 프로젝트에 대해 설명하고 보고 할 것'),
    'explain/report intent detected',
  );
  assert(
    !looksLikeToolTask('이 프로젝트에 대해 설명하고 보고 할 것'),
    'pure explain is not a tool/edit task',
  );
  assert(
    looksLikeToolTask('ChatPane.tsx 전송 버튼 색 수정해줘'),
    'explicit edit stays a tool task',
  );
  assert(
    !buildEditorContextSnippet({ path: 'buffer.tsx', selection: 'fake' }),
    'synthetic buffer.tsx editor context omitted',
  );
  assert(
    /에디터 참고/.test(buildEditorContextSnippet({ path: 'ui/workspace/src/components/ChatPane.tsx' }) || ''),
    'real editor path still attached',
  );
  assert(
    looksLikeIncompleteExplainAnswer(
      '현재 우선순위를 정리하겠습니다.\n\n[P:commentary]: #',
    ),
    'preamble + channel tag is incomplete',
  );
  assert(
    looksLikeTruncatedAssistantReply('확인하겠습니다.'),
    'shared truncated detector',
  );
  assert(
    !looksLikeIncompleteExplainAnswer(
      '## 결론\n안정성이 우선입니다.\n\n- Undo 이식\n- 대기열\n- Manager\n\n### 다음\nCore 재시작 후 검증',
    ),
    'structured report is complete',
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

// --- Plan-only / defer-edit guard ---
{
  assert(
    contentDefersFileEdit(
      '현재 이 대화 환경에서는 파일 검색·수정 도구 호출이 실제로 실행되지 않아 작업 폴더 반영까지 진행할 수 없습니다.',
    ),
    'defers: fictional chat-environment tools-disabled',
  );
  assert(
    contentClaimsToolsUnavailable(
      '현재 이 대화 환경에서는 파일 검색·수정 도구 호출이 실제로 실행되지 않아 작업 폴더 반영까지 진행할 수 없습니다.',
    ),
    'tools-unavailable: chat-environment fiction',
  );
  assert(
    contentDefersFileEdit(
      '수정 방향:\n- ChatTurn에 imageUrls 추가\n현재 도구 결과는 읽은 것만 보여줍니다.',
    ),
    'defers: plan + read-only meta',
  );
  assert(
    !contentDefersFileEdit(
      'ChatPane.tsx를 수정했습니다. 이미지 URL을 버블에 렌더링합니다.',
    ),
    'completed edit is not deferred',
  );
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll chat UX guard checks passed.');
