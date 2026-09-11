import { agentToolOutputOk } from './agent-tool-result.js';

export interface ToolActivity {
  id: string;
  /** Stable id shared by every tool call returned by the same model response. */
  activityGroupId?: string;
  tool: string;
  target: string;
  state: 'running' | 'success' | 'failed' | 'cancelled';
  cancelSessionId?: string;
  cancelRequested?: boolean;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  lastOutputAt?: number;
  output: string;
  truncated: boolean;
  exitCode?: number | null;
}


/** Display-only redaction. Never rewrite tool evidence or commands being executed. */
export function redactActivity(text: string): string {
  let clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:token|secret|password|api_?key|credential)/i.test(key) && value && value.length >= 4) {
      clean = clean.split(value).join('[REDACTED]');
    }
  }
  return clean
    .replace(/-----BEGIN[\s\S]*?(?:PRIVATE KEY-----[\s\S]*?(?:-----END[^\n]*|$))/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{8,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, '$1 [REDACTED]')
    .replace(/((?:["']?(?:[\w-]*(?:token|secret|password|api[_-]?key|credential)[\w-]*)["']?)\s*(?:=|:|\s)\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

/** Full redacted snapshots make duplicate SSE deliveries idempotent without discarding output. */
export function createToolActivity(
  id: string, tool: string, args: Record<string, unknown>,
  emit?: (row: ToolActivity) => void,
  cancelSessionId?: string,
  activityGroupId?: string,
) {
  const target = ['command', 'path', 'query', 'url'].map((key) => args[key]).find((v) => typeof v === 'string') ?? '';
  const row: ToolActivity = {
    id, ...(activityGroupId ? { activityGroupId } : {}),
    tool, target: redactActivity(String(target)).slice(0, 600), state: 'running',
    startedAt: Date.now(), updatedAt: Date.now(), output: '', truncated: false, cancelSessionId,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const pending = { stdout: '', stderr: '' };
  const privateKey = { stdout: false, stderr: false };
  const publish = () => {
    timer = undefined;
    row.updatedAt = Date.now();
    try { emit?.({ ...row }); } catch { /* observer cannot fail execution */ }
  };
  const append = (stream: 'stdout' | 'stderr', text: string) => {
    if (/-----BEGIN .*PRIVATE KEY/.test(text)) privateKey[stream] = true;
    if (privateKey[stream]) {
      if (/-----END .*PRIVATE KEY/.test(text)) privateKey[stream] = false;
      text = '[REDACTED PRIVATE KEY]\n';
    }
    const chunk = `${stream === 'stderr' ? '[stderr] ' : ''}${redactActivity(text)}`;
    row.output += chunk;
    if (!timer) timer = setTimeout(publish, 120);
  };
  publish();
  return {
    requestCancel() {
      if (closed) return;
      row.cancelRequested = true;
      if (timer) clearTimeout(timer);
      publish();
    },
    output(stream: 'stdout' | 'stderr', chunk: string) {
      if (closed) return;
      row.lastOutputAt = Date.now();
      // Buffer complete lines so secrets split across process chunks never leak.
      for (const part of chunk.split(/(?<=\n)/)) {
        if (!part) continue;
        pending[stream] += part;
        if (part.endsWith('\n')) {
          append(stream, pending[stream]);
          pending[stream] = '';
        }
      }
      if (!timer) timer = setTimeout(publish, 120);
    },
    finish(output: string, cancelled = false) {
      if (closed) return;
      closed = true;
      for (const stream of ['stdout', 'stderr'] as const) {
        if (pending[stream]) append(stream, pending[stream]);
      }
      let result: Record<string, unknown> = {};
      try { result = JSON.parse(output); } catch { /* plain-text tool result */ }
      row.state = result.termination_unconfirmed === true ? 'failed'
        : cancelled || result.cancelled === true ? 'cancelled'
        : !agentToolOutputOk(output) || result.skipped === true ? 'failed' : 'success';
      if (typeof result.exit_code === 'number' || result.exit_code === null) row.exitCode = result.exit_code;
      row.finishedAt = Date.now();
      if (timer) clearTimeout(timer);
      publish();
    },
  };
}
