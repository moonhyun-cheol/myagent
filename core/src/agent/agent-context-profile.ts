import { chatContentToText, type ChatMessage } from '../providers/openai-compatible.js';
import { agentToolOutputOk } from './agent-tool-result.js';
import type { AgentToolDefinition } from './agent-tool-types.js';

export type AgentContextProfile = 'orient' | 'execute' | 'repair' | 'verify' | 'final';

export interface AgentContextEvidence {
  mutatedPaths: string[];
  acceptanceOk: boolean;
}

function hasRecentFailure(messages: ChatMessage[]): boolean {
  const latestToolResult = [...messages].reverse().find((message) => message.role === 'tool');
  if (!latestToolResult) return false;
  // Only the canonical result envelope decides failure; body substrings never change phase.
  return !agentToolOutputOk(chatContentToText(latestToolResult.content));
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
      `이번 호출에 사용 가능한 전체 도구: ${toolNames.join(', ') || '(없음)'}`,
      '컨텍스트 프로필은 작업 지침만 바꾸며 도구를 제한하지 않는다. 현재 단계에서도 필요한 조회·수정·검증 도구를 직접 사용하라.',
      '서로 독립적인 읽기 전용 조회는 한 응답에서 여러 tool call로 함께 요청하라. 앞 조회 결과가 필요한 호출과 수정·실행·승인 도구는 순차 호출하라.',
      '안전·승인·근거·완료 규칙은 모든 단계에 계속 적용된다.',
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
  // Profiles guide context and verification behavior only. They must not hide
  // capabilities: a failed verification may need an immediate repair without
  // waiting for another profile transition or user turn.
  const agentTools = input.agentTools;
  const toolNames = agentTools.map((tool) => tool.function.name);
  const compacted = compactConsumedToolResults(input.messages);
  // Append after the latest tool result/user turn. Because this is an ephemeral
  // user message, phase changes cannot invalidate the cacheable system prefix.
  const messages = [...compacted, profileTailNote(input.profile, toolNames)];
  return { profile: input.profile, messages, agentTools, toolNames };
}
