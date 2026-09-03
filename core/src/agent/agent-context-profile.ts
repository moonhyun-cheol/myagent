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
  // Tool bodies may be source files or docs containing words such as ERROR or
  // failure-marker examples. Only the canonical result envelope/prefix decides
  // whether the tool itself failed; arbitrary body substrings never change phase.
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
  // Profiles are telemetry only. They must neither hide capabilities nor add a
  // synthetic user/instruction message that can steer the model between tool
  // rounds. The original conversation and tool results remain authoritative.
  const agentTools = input.agentTools;
  const toolNames = agentTools.map((tool) => tool.function.name);
  const messages = compactConsumedToolResults(input.messages);
  return { profile: input.profile, messages, agentTools, toolNames };
}
