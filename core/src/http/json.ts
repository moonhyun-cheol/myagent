import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function sessionFromReq(req: IncomingMessage): string {
  const h = req.headers['x-cqr-session'];
  if (typeof h === 'string' && h.trim()) return h.trim().slice(0, 64);
  return 'default';
}
