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
