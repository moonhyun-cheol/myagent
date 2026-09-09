import net from 'node:net';
import { randomUUID } from 'node:crypto';

const REQUEST_TIMEOUT_MS = 20_000;
const LOCK_LEASE_MS = 45_000;

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
  private lock: LockState | null = null;

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

  lockFor(sessionId: string): { owner: string; expires_at: string } {
    const owner = sessionId.trim() || 'default';
    const now = Date.now();
    if (this.lock && this.lock.expiresAt > now && this.lock.owner !== owner) {
      throw new Error(`VISIBLE_BROWSER_LOCKED:${this.lock.owner}`);
    }
    this.lock = { owner, expiresAt: now + LOCK_LEASE_MS };
    return { owner, expires_at: new Date(this.lock.expiresAt).toISOString() };
  }

  unlockFor(sessionId: string): { unlocked: boolean } {
    const owner = sessionId.trim() || 'default';
    if (!this.lock || this.lock.expiresAt <= Date.now()) {
      this.lock = null;
      return { unlocked: false };
    }
    if (this.lock.owner !== owner) throw new Error(`VISIBLE_BROWSER_LOCKED:${this.lock.owner}`);
    this.lock = null;
    return { unlocked: true };
  }

  assertLockedBy(sessionId: string): void {
    const owner = sessionId.trim() || 'default';
    if (!this.lock || this.lock.expiresAt <= Date.now()) {
      this.lock = null;
      throw new Error('VISIBLE_BROWSER_LOCK_REQUIRED');
    }
    if (this.lock.owner !== owner) throw new Error(`VISIBLE_BROWSER_LOCKED:${this.lock.owner}`);
    this.lock.expiresAt = Date.now() + LOCK_LEASE_MS;
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
    this.lock = null;
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
