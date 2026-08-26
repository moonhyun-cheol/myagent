import { loadHarnessPolicy } from '../providers/harness-policy.js';
import {
  buildContextBudgetSnapshot,
  resolveContextBudgets,
  type BudgetDebitOpts,
  type ContextBudgetSnapshot,
} from '../providers/model-context-limits.js';

export type CompressTelemetry = {
  foldedTurns: number;
  charsBefore: number;
  charsAfter: number;
  modelId: string | null;
  contextLength: number;
  effectiveContextLength: number;
  budgetScale: number;
  usedFallback128k: boolean;
  compressed: boolean;
  pinnedFactCount: number;
};

export type HistoryBudgetOpts = {
  modelId?: string | null;
  pinnedFacts?: string[];
  debit?: BudgetDebitOpts;
  onCompress?: (t: CompressTelemetry) => void;
  onSnapshot?: (s: ContextBudgetSnapshot) => void;
};

/** Default turn window for chat + code-agent (overridable via MY_AGENT_HISTORY_TURNS + model scale). */
export function getHistoryTurns(
  env: NodeJS.ProcessEnv = process.env,
  opts?: HistoryBudgetOpts,
): number {
  if (opts?.modelId) return resolveContextBudgets(opts.modelId, env, opts.debit).historyTurns;
  return loadHarnessPolicy(env).historyTurns;
}

export function getHistoryAssistantMaxChars(
  env: NodeJS.ProcessEnv = process.env,
  opts?: HistoryBudgetOpts,
): number {
  if (opts?.modelId) {
    return resolveContextBudgets(opts.modelId, env, opts.debit).historyAssistantMaxChars;
  }
  return loadHarnessPolicy(env).historyAssistantMaxChars;
}

function totalHistoryChars(messages: Array<{ content?: string }>): number {
  let n = 0;
  for (const m of messages) n += String(m.content ?? '').length;
  return n;
}

function excerptForRole(role: string, content: string): string {
  const c = String(content || '').replace(/\s+/g, ' ').trim();
  const max = role === 'user' ? 200 : role === 'assistant' ? 120 : 80;
  if (c.length <= max) return c;
  return `${c.slice(0, max)}…`;
}

function normalizePinnedFacts(facts: string[] | undefined): string[] {
  if (!Array.isArray(facts)) return [];
  return [...new Set(facts.map((f) => String(f || '').trim()).filter(Boolean))].slice(0, 24);
}

/**
 * Deterministic history compress: when total chars exceed budget, fold older
 * user/assistant turns into one compact note; keep recent N verbatim.
 * Pinned facts always appear at the top of the fold note.
 * Does not write back to SessionStore — request-scoped only.
 */
export function applyHistoryContextCompress<T extends { role: string; content: string }>(
  messages: T[],
  env: NodeJS.ProcessEnv = process.env,
  opts?: HistoryBudgetOpts,
): T[] {
  if (!messages.length) return messages;
  const pinned = normalizePinnedFacts(opts?.pinnedFacts);
  const budgets = opts?.modelId
    ? resolveContextBudgets(opts.modelId, env, opts.debit)
    : {
        historyKeepRecent: loadHarnessPolicy(env).historyKeepRecent,
        historyCompressChars: loadHarnessPolicy(env).historyCompressChars,
        contextLength: 128_000,
        effectiveContextLength: 120_000,
        scale: 1,
        limitsFallback: true,
      };
  const keepRecent = budgets.historyKeepRecent;
  const compressChars = budgets.historyCompressChars;
  const charsBefore = totalHistoryChars(messages);

  const emit = (compressed: boolean, foldedTurns: number, out: T[]) => {
    const charsAfter = totalHistoryChars(out);
    const telemetry: CompressTelemetry = {
      foldedTurns,
      charsBefore,
      charsAfter,
      modelId: opts?.modelId ?? null,
      contextLength: budgets.contextLength ?? 128_000,
      effectiveContextLength: budgets.effectiveContextLength ?? budgets.contextLength ?? 128_000,
      budgetScale: budgets.scale ?? 1,
      usedFallback128k: Boolean(budgets.limitsFallback),
      compressed,
      pinnedFactCount: pinned.length,
    };
    opts?.onCompress?.(telemetry);
    opts?.onSnapshot?.(
      buildContextBudgetSnapshot({
        modelId: opts?.modelId,
        usedChars: charsAfter,
        compressed,
        foldedTurns,
        debit: opts?.debit,
        env,
      }),
    );
  };

  if (charsBefore <= compressChars || messages.length <= keepRecent) {
    emit(false, 0, messages);
    return messages;
  }

  const head = messages.slice(0, -keepRecent);
  const tail = messages.slice(-keepRecent);
  const lines: string[] = [
    `[history compress · ${head.length} earlier turns folded]`,
  ];
  if (pinned.length) {
    lines.push('[pinned facts]');
    for (const f of pinned) lines.push(`- ${f}`);
  }
  for (const m of head) {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue;
    const ex = excerptForRole(m.role, m.content);
    if (!ex) continue;
    lines.push(`- ${m.role}: ${ex}`);
  }
  if (lines.length <= 1) {
    emit(false, 0, messages);
    return messages;
  }

  const note = {
    role: 'user',
    content: lines.join('\n'),
  } as T;
  const out = [note, ...tail];
  emit(true, head.length, out);
  return out;
}

/**
 * Cap long assistant turns so failed TOOL_CALL dumps do not crowd out the current task.
 * Runs deterministic compress first, then assistant truncate.
 */
export function applyHistoryContentBudget<T extends { role: string; content: string }>(
  messages: T[],
  env: NodeJS.ProcessEnv = process.env,
  opts?: HistoryBudgetOpts,
): T[] {
  const compressed = applyHistoryContextCompress(messages, env, opts);
  const maxChars = getHistoryAssistantMaxChars(env, opts);
  return compressed.map((m) => {
    if (m.role !== 'assistant') return m;
    const c = m.content ?? '';
    if (c.length <= maxChars) return m;
    return {
      ...m,
      content: `${c.slice(0, maxChars)}\n…(history truncated ${c.length.toLocaleString()}→${maxChars.toLocaleString()} chars)`,
    };
  });
}

export type { ContextBudgetSnapshot, BudgetDebitOpts };
