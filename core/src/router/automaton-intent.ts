import {
  buildAutomatonCommandText,
  getSlashAutomatonPatterns,
} from '../automaton/tool-catalog.js';
import type { RouteDecision } from './types.js';

export interface AutomatonIntentResult {
  action: 'run';
  toolId: string;
  commandText: string;
  confidence: 1;
  layer: 'explicit';
}

/** Explicit slash commands are structural input, not inferred user intent. */
export function peekAutomatonIntent(message: string, cqrRoot?: string): AutomatonIntentResult | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) return null;

  const match = getSlashAutomatonPatterns(cqrRoot).find(({ pattern }) => pattern.test(trimmed));
  if (!match) return null;

  return {
    action: 'run',
    toolId: match.toolId,
    commandText: buildAutomatonCommandText(match.toolId, trimmed, cqrRoot),
    confidence: 1,
    layer: 'explicit',
  };
}

export function automatonIntentToRoute(intent: AutomatonIntentResult): RouteDecision {
  return {
    mode: 'automaton_direct',
    confidence: intent.confidence,
    layer: 'explicit',
    matched_tool: intent.toolId,
  };
}

/** 등록되지 않은 슬래시 명령에 대한 한국어 안내 (LLM 폴백 금지). */
export const SLASH_COMMAND_UNREGISTERED_MESSAGE =
  '**슬래시 명령 미등록** — 이 명령은 automaton 도구 목록에 없습니다. 회사(조직) 모듈이 로드되지 않았거나 명령 철자가 다를 수 있습니다. 일반 대화는 `/` 없이 입력하세요.';

export interface SlashRouteResult {
  routing: RouteDecision;
  automatonText: string;
}

/**
 * `/` + 비공백으로 시작하는 입력은 항상 구조적 명령으로 취급한다.
 * - 등록된 slash prefix에 매칭 → automaton_direct (matched_tool 설정)
 * - 미등록 slash → automaton_direct (matched_tool 없음) — 오케스트레이터가 미등록 안내로 종료하고 LLM으로 폴백하지 않는다.
 * - slash가 아니면 null (일반 라우팅 계속).
 */
export function resolveSlashRoute(message: string, cqrRoot?: string): SlashRouteResult | null {
  if (!/^\/\S/.test(message.trim())) return null;
  const intent = peekAutomatonIntent(message, cqrRoot);
  if (intent) {
    return {
      routing: automatonIntentToRoute(intent),
      automatonText: intent.commandText ?? message,
    };
  }
  return {
    routing: { mode: 'automaton_direct', confidence: 1, layer: 'explicit' },
    automatonText: message,
  };
}
