import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadPortKeepPolicy(root = path.resolve(here, '..')) {
  const file = path.join(root, 'tools', 'port-keep-policy.json');
  const policy = JSON.parse(readFileSync(file, 'utf8'));
  if (policy.schema !== 'my-agent-port-keep/v1') {
    throw new Error(`port-keep-policy: unexpected schema ${policy.schema}`);
  }
  if (!Array.isArray(policy.keep) || policy.keep.length === 0) {
    throw new Error('port-keep-policy: keep rules required');
  }
  return policy;
}

export function keepRuleFor(relative, policy) {
  const file = String(relative || '').replace(/\\/g, '/');
  if (!file) return null;
  for (const rule of policy.keep) {
    if (Array.isArray(rule.files) && rule.files.includes(file)) return rule;
    if (Array.isArray(rule.prefixes)) {
      for (const prefix of rule.prefixes) {
        const p = String(prefix || '').replace(/\\/g, '/');
        if (!p) continue;
        if (file === p.replace(/\/$/, '') || file.startsWith(p.endsWith('/') ? p : `${p}/`)) {
          return rule;
        }
      }
    }
  }
  return null;
}

export function shouldKeepLocal(relative, policy) {
  return Boolean(keepRuleFor(relative, policy));
}
