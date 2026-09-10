import net from 'node:net';
import { randomUUID } from 'node:crypto';

const REQUEST_TIMEOUT_MS = 20_000;
const LOCK_LEASE_MS = 45_000;
/** Tab id used when a caller does not target a specific tab (single-tab compatibility). */
export const DEFAULT_VISIBLE_TAB = 'main';

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type LockState = { owner: string; expiresAt: number };

function pipePath(port: number): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\my-agent-visible-browser-${port}`
    : `/tmp/my-agent-visible-browser-${port}.sock`;
}

/** Core-side request broker for the shell-owned, user-visible BrowserWebView. */
export class VisibleBrowserBridge {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private buffer = '';
  private pending = new Map<string, PendingRequest>();
  /** One lease per visible tab. A missing tab id resolves to DEFAULT_VISIBLE_TAB. */
  private locks = new Map<string, LockState>();

  constructor(private readonly port: number) {}

  start(): void {
    if (this.server) return;
    this.server = net.createServer((socket) => this.attach(socket));
    this.server.on('error', () => {
      // The API remains usable when the optional desktop shell is absent.
    });
    this.server.listen(pipePath(this.port));
  }

  stop(): void {
    this.detach(new Error('VISIBLE_BROWSER_BRIDGE_CLOSED'));
    this.server?.close();
    this.server = null;
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  private tabKey(tabId?: string): string {
    const key = (tabId ?? '').trim();
    return key || DEFAULT_VISIBLE_TAB;
  }

  private sweepExpiredLocks(now: number): void {
    for (const [key, state] of this.locks) if (state.expiresAt <= now) this.locks.delete(key);
  }

  lockFor(sessionId: string, tabId?: string): { owner: string; tab_id: string; expires_at: string } {
    const owner = sessionId.trim() || 'default';
    const key = this.tabKey(tabId);
    const now = Date.now();
    this.sweepExpiredLocks(now);
    const existing = this.locks.get(key);
    if (existing && existing.expiresAt > now && existing.owner !== owner) {
      throw new Error(`VISIBLE_BROWSER_LOCKED:${existing.owner}`);
    }
    const state: LockState = { owner, expiresAt: now + LOCK_LEASE_MS };
    this.locks.set(key, state);
    return { owner, tab_id: key, expires_at: new Date(state.expiresAt).toISOString() };
  }

  unlockFor(sessionId: string, tabId?: string): { unlocked: boolean; tab_id: string } {
    const owner = sessionId.trim() || 'default';
    const key = this.tabKey(tabId);
    const existing = this.locks.get(key);
    if (!existing || existing.expiresAt <= Date.now()) {
      this.locks.delete(key);
      return { unlocked: false, tab_id: key };
    }
    if (existing.owner !== owner) throw new Error(`VISIBLE_BROWSER_LOCKED:${existing.owner}`);
    this.locks.delete(key);
    return { unlocked: true, tab_id: key };
  }

  assertLockedBy(sessionId: string, tabId?: string): void {
    const owner = sessionId.trim() || 'default';
    const key = this.tabKey(tabId);
    const existing = this.locks.get(key);
    if (!existing || existing.expiresAt <= Date.now()) {
      this.locks.delete(key);
      throw new Error('VISIBLE_BROWSER_LOCK_REQUIRED');
    }
    if (existing.owner !== owner) throw new Error(`VISIBLE_BROWSER_LOCKED:${existing.owner}`);
    existing.expiresAt = Date.now() + LOCK_LEASE_MS;
  }

  /** Drop every lease owned by a session (e.g. when a tab it held is closed). */
  releaseSession(sessionId: string): void {
    const owner = sessionId.trim() || 'default';
    for (const [key, state] of this.locks) if (state.owner === owner) this.locks.delete(key);
  }

  async request(action: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error('VISIBLE_BROWSER_NOT_CONNECTED');
    const id = randomUUID();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`VISIBLE_BROWSER_TIMEOUT:${action}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ type: 'command', id, action, payload })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private attach(socket: net.Socket): void {
    this.detach(new Error('VISIBLE_BROWSER_RECONNECTED'));
    this.socket = socket;
    this.buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.consume(chunk));
    socket.on('close', () => {
      if (this.socket === socket) this.detach(new Error('VISIBLE_BROWSER_DISCONNECTED'));
    });
    socket.on('error', () => {
      if (this.socket === socket) this.detach(new Error('VISIBLE_BROWSER_DISCONNECTED'));
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const raw = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!raw) continue;
      try {
        const message = JSON.parse(raw) as {
          type?: string;
          id?: string;
          ok?: boolean;
          result?: Record<string, unknown>;
          error?: string;
        };
        if (message.type !== 'result' || !message.id) continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.result ?? {});
        else pending.reject(new Error(message.error || 'VISIBLE_BROWSER_COMMAND_FAILED'));
      } catch {
        // Ignore malformed shell messages without dropping the transport.
      }
    }
  }

  private detach(error: Error): void {
    const socket = this.socket;
    this.socket = null;
    this.buffer = '';
    if (socket && !socket.destroyed) socket.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.locks.clear();
  }
}

let singleton: VisibleBrowserBridge | null = null;

export function startVisibleBrowserBridge(port: number): VisibleBrowserBridge {
  if (!singleton) singleton = new VisibleBrowserBridge(port);
  singleton.start();
  return singleton;
}

export function getVisibleBrowserBridge(): VisibleBrowserBridge | null {
  return singleton;
}

export function visibleBrowserConnected(): boolean {
  return singleton?.isConnected() === true;
}
