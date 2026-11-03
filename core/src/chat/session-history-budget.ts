/**
 * Wire session pinnedFacts + compress telemetry into HistoryBudgetOpts.
 */
import {
  loadAgentRunMeta,
  recordSessionContextBudget,
  appendSessionPinnedFacts,
} from '../agent/agent-run-meta.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BudgetDebitOpts, FoldNoteStore, HistoryBudgetOpts } from './history-budget.js';

/** data/agent-run-meta/<session>.fold-note.json — keeps the fold note byte-stable across restarts. */
function fileFoldNoteStore(cqrRoot: string): FoldNoteStore {
  const dir = path.join(cqrRoot, 'data', 'agent-run-meta');
  const fileFor = (key: string) =>
    path.join(dir, `${key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default'}.fold-note.json`);
  return {
    load(key) {
      const fp = fileFor(key);
      if (!existsSync(fp)) return null;
      const raw = JSON.parse(readFileSync(fp, 'utf8')) as { sig?: unknown; content?: unknown };
      return typeof raw.sig === 'string' && typeof raw.content === 'string'
        ? { sig: raw.sig, content: raw.content }
        : null;
    },
    save(key, sig, content) {
      mkdirSync(dir, { recursive: true });
      const fp = fileFor(key);
      const tmp = `${fp}.tmp`;
      writeFileSync(tmp, JSON.stringify({ sig, content }), 'utf8');
      renameSync(tmp, fp);
    },
  };
}

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
    foldNoteKey: input.sessionId,
    foldNoteStore: input.sessionId ? fileFoldNoteStore(input.cqrRoot) : undefined,
    onSnapshot: (s) => {
      recordSessionContextBudget(input.cqrRoot, input.sessionId, {
        at: new Date().toISOString(),
        usedChars: s.usedChars,
        budgetChars: s.budgetChars,
        contextLength: s.contextLength,
        effectiveContextLength: s.effectiveContextLength,
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
