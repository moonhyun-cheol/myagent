import { chatContentToText, type ChatMessage } from '../providers/openai-compatible.js';
import type { AgentToolDefinition } from './agent-tool-types.js';

export type AgentContextProfile = 'orient' | 'execute' | 'repair' | 'verify' | 'final';

export interface AgentContextEvidence {
  mutatedPaths: string[];
  acceptanceOk: boolean;
}

const ORIENT_TOOLS = new Set([
  'active_task',
  'task_history_search',
  'task_history_detail',
  'list_directory',
  'read_file',
  'search_files',
  'query_repo_map',
  'search_embeddings',
  'git_status',
  'git_diff',
  'git_log',
  'git_history_tree',
  'git_show',
  'git_blame',
  'plugin_list',
]);

const WORKSPACE_TOOLS = new Set([
  ...ORIENT_TOOLS,
  'write_file',
  'edit_file',
  'apply_patch',
  'delete_file',
  'rename_file',
  'run_terminal',
  'run_tests',
  'run_diagnostics',
  'workspace_checkpoint',
  'workspace_rollback',
  'markitdown_convert',
  'repomix_pack',
  'ast_grep_search',
]);

const VERIFY_TOOLS = new Set([
  'active_task',
  'read_file',
  'git_status',
  'git_diff',
  'run_terminal',
  'run_tests',
  'run_diagnostics',
  'browser_navigate',
  'browser_screenshot',
  'browser_click',
  'browser_fill',
  'browser_evaluate',
]);

const FINAL_TOOLS = new Set(['active_task', 'read_file', 'git_status', 'git_diff']);
const GIT_WRITE_RE = /\b(?:commit|push|pull|stage|unstage|stash|branch|switch)\b|커밋|푸시|풀|스테이지|브랜치|전환/i;
const BROWSER_RE = /https?:\/\/|브라우저|browser|웹\s*검증|localhost|스크린샷|screenshot/i;
const PLUGIN_RE = /플러그인|plugin|mcp/i;

function hasRecentFailure(messages: ChatMessage[]): boolean {
  const latestToolResult = [...messages].reverse().find((message) => message.role === 'tool');
  if (!latestToolResult) return false;
  const text = chatContentToText(latestToolResult.content);
  return /\bERROR\b|ATOMIC_ABORT|SYNTAX_BROKEN|exit[_ ]?code["']?\s*[:=]\s*[1-9]|"ok"\s*:\s*false/i.test(text);
}

export function resolveAgentContextProfile(input: {
  step: number;
  messages: ChatMessage[];
  evidence?: AgentContextEvidence | null;
}): AgentContextProfile {
  if (input.step <= 1) return 'orient';
  if (hasRecentFailure(input.messages)) return 'repair';
  if (input.evidence?.acceptanceOk) return 'final';
  if ((input.evidence?.mutatedPaths.length ?? 0) > 0) return 'verify';
  return 'execute';
}

function selectedNamesForProfile(
  profile: AgentContextProfile,
  userMessage: string,
  available: AgentToolDefinition[],
): Set<string> {
  const names = new Set(
    profile === 'orient'
      ? ORIENT_TOOLS
      : profile === 'verify'
        ? VERIFY_TOOLS
        : profile === 'final'
          ? FINAL_TOOLS
          : WORKSPACE_TOOLS,
  );

  if (profile === 'execute' || profile === 'repair') {
    if (GIT_WRITE_RE.test(userMessage)) {
      for (const tool of available) {
        if (tool.function.name.startsWith('git_')) names.add(tool.function.name);
      }
    }
    if (BROWSER_RE.test(userMessage)) {
      for (const tool of available) {
        if (tool.function.name.startsWith('browser_') || tool.function.name === 'save_web_asset') {
          names.add(tool.function.name);
        }
      }
    }
    if (PLUGIN_RE.test(userMessage)) {
      for (const tool of available) {
        if (/^(?:plugin_|mcp_)/.test(tool.function.name)) names.add(tool.function.name);
      }
    }
  }
  return names;
}

function compactConsumedToolResults(messages: ChatMessage[]): ChatMessage[] {
  const toolIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'tool')
    .map(({ index }) => index);
  const keepFrom = toolIndexes.at(-6) ?? Number.POSITIVE_INFINITY;

  return messages.map((message, index) => {
    if (message.role !== 'tool' || index >= keepFrom) return message;
    const text = chatContentToText(message.content);
    if (text.length <= 600) return message;
    return {
      ...message,
      content: `${text.slice(0, 420)}\n[이전 도구 결과 압축됨 · 원문 ${text.length}자]`,
    };
  });
}

function profileTailNote(profile: AgentContextProfile, toolNames: string[]): ChatMessage {
  const phaseInstruction: Record<AgentContextProfile, string> = {
    orient: '요청을 짧게 구조화하고 필요한 소스를 일괄 탐색하라. 아직 수정하지 말고 다음 실행에 필요한 근거를 확보하라.',
    execute: '확인된 근거와 작업 목표에 집중해 수정하라. 무관한 과거 이력과 완료된 조회를 다시 확장하지 마라.',
    repair: '최근 실패 원인과 관련 파일만 사용해 복구하라. 같은 실패 호출을 그대로 반복하지 마라.',
    verify: '변경 결과를 Acceptance 기준으로 검증하라. 실패 시 오류 근거를 남겨 복구 단계로 넘겨라.',
    final: '검증된 결과만 요약하고 열린 작업 게이트를 닫아라. 새 범위를 시작하지 마라.',
  };
  return {
    // Keep volatile phase guidance in the dynamic conversation tail. Provider
    // adapters may promote this ephemeral user note to native instructions.
    role: 'user',
    ephemeral: true,
    content: [
      `[Native context profile: ${profile}]`,
      phaseInstruction[profile],
      `이번 호출에 제공된 도구: ${toolNames.join(', ') || '(없음)'}`,
      '서로 독립적인 읽기 전용 조회는 한 응답에서 여러 tool call로 함께 요청하라. 앞 조회 결과가 필요한 호출과 수정·실행·승인 도구는 순차 호출하라.',
      '제공되지 않은 도구 스키마는 이번 단계에서 사용할 수 없다. 안전·승인·근거·완료 규칙은 모든 단계에 계속 적용된다.',
    ].join('\n'),
  };
}

export function compileAgentStepContext(input: {
  profile: AgentContextProfile;
  messages: ChatMessage[];
  agentTools: AgentToolDefinition[];
  userMessage: string;
}): {
  profile: AgentContextProfile;
  messages: ChatMessage[];
  agentTools: AgentToolDefinition[];
  toolNames: string[];
} {
  const allowed = selectedNamesForProfile(input.profile, input.userMessage, input.agentTools);
  const agentTools = input.agentTools.filter((tool) => allowed.has(tool.function.name));
  const toolNames = agentTools.map((tool) => tool.function.name);
  const compacted = compactConsumedToolResults(input.messages);
  // Append after the latest tool result/user turn. Because this is an ephemeral
  // user message, phase changes cannot invalidate the cacheable system prefix.
  const messages = [...compacted, profileTailNote(input.profile, toolNames)];
  return { profile: input.profile, messages, agentTools, toolNames };
}
