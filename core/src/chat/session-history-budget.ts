/**
 * Wire session pinnedFacts + compress telemetry into HistoryBudgetOpts.
 */
import {
  loadAgentRunMeta,
  recordSessionContextBudget,
  appendSessionPinnedFacts,
} from '../agent/agent-run-meta.js';
import type { BudgetDebitOpts, HistoryBudgetOpts } from './history-budget.js';

/** Extract short pin candidates from a user message (paths / explicit markers). */
export function extractPinCandidatesFromMessage(message: string): string[] {
  const text = String(message || '');
  const out: string[] = [];
  const pathRe =
    /(?:[A-Za-z]:\\[^\s"'<>|]+|\/(?:Users|home|var|tmp|opt)[^\s"'<>|]+|[\w.-]+\/[\w./-]{3,})/g;
  for (const m of text.match(pathRe) || []) {
    const t = m.trim();
    if (t.length >= 6 && t.length <= 180) out.push(t);
  }
  const marker = text.match(/#\s*[\w.-]{4,40}/g);
  if (marker) out.push(...marker.map((s) => s.trim()));
  return [...new Set(out)].slice(0, 8);
}

export function buildSessionHistoryBudgetOpts(input: {
  cqrRoot: string;
  sessionId: string | undefined;
  modelId?: string | null;
  debit?: BudgetDebitOpts;
  extraPins?: string[];
}): HistoryBudgetOpts {
  const meta = loadAgentRunMeta(input.cqrRoot, input.sessionId);
  const pins = [
    ...(input.extraPins || []),
    ...(meta.pinnedFacts || []),
  ];
  return {
    modelId: input.modelId,
    pinnedFacts: pins,
    debit: input.debit,
    onSnapshot: (s) => {
      recordSessionContextBudget(input.cqrRoot, input.sessionId, {
        at: new Date().toISOString(),
        usedChars: s.usedChars,
        budgetChars: s.budgetChars,
        compressed: s.compressed,
        fallback128k: s.fallback128k,
        foldedTurns: s.foldedTurns,
        modelId: s.modelId,
        mismatch: s.mismatch ?? null,
      });
    },
  };
}

/** Persist newly noticed pins for later turns. */
export function rememberMessagePins(
  cqrRoot: string,
  sessionId: string | undefined,
  message: string,
): void {
  const pins = extractPinCandidatesFromMessage(message);
  if (pins.length) appendSessionPinnedFacts(cqrRoot, sessionId, pins);
}
