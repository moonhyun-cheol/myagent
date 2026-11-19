/**
 * Wire caller-supplied pins (e.g. mutated paths) + compress telemetry into HistoryBudgetOpts.
 * User message text is never mined for pins.
 */
import { recordSessionContextBudget } from '../agent/agent-run-meta.js';
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
      const raw = JSON.parse(readFileSync(fp, 'utf8')) as { sig?: unknown; content?: unknown; count?: unknown };
      return typeof raw.sig === 'string' && typeof raw.content === 'string'
        ? { sig: raw.sig, content: raw.content, ...(typeof raw.count === 'number' ? { count: raw.count } : {}) }
        : null;
    },
    save(key, sig, content, count) {
      mkdirSync(dir, { recursive: true });
      const fp = fileFor(key);
      const tmp = `${fp}.tmp`;
      writeFileSync(tmp, JSON.stringify({ sig, content, count }), 'utf8');
      renameSync(tmp, fp);
    },
  };
}

export function buildSessionHistoryBudgetOpts(input: {
  cqrRoot: string;
  sessionId: string | undefined;
  modelId?: string | null;
  debit?: BudgetDebitOpts;
  extraPins?: string[];
}): HistoryBudgetOpts {
  return {
    modelId: input.modelId,
    pinnedFacts: [...(input.extraPins || [])],
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
