import type { MyAgentApiConfig } from '../global';

export function getApiConfig(): MyAgentApiConfig {
  const cfg = window.__MY_AGENT_API__;
  if (cfg?.baseUrl) return cfg;
  const host = window.location.hostname;
  if (host === '127.0.0.1' || host === 'localhost') {
    const port = Number(window.location.port) || 10200;
    return {
      baseUrl: window.location.origin,
      port,
      cqrRoot: '',
    };
  }
  return {
    baseUrl: '',
    port: 10200,
    cqrRoot: '',
  };
}

export function apiUrl(path: string): string {
  const base = getApiConfig().baseUrl.replace(/\/$/, '');
  if (!base) return path;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), init);
}
