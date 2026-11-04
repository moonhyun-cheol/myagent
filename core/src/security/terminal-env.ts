/**
 * Environment passed to agent-spawned terminals (run_terminal).
 *
 * The core process may hold provider keys / tokens in its environment. A command chosen by the
 * model (possibly steered by untrusted content) must not be able to echo them, so variables whose
 * name looks like a credential are dropped. Users can pass specific names through with
 * `MY_AGENT_TERMINAL_ENV_ALLOW` (comma/space separated, case-insensitive).
 */

const SECRET_NAME_RE =
  /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|COOKIE|SESSION_?KEY|(^|_)KEY$)/i;

/** Names that match the pattern but are not secrets and are needed by common tooling. */
const ALWAYS_KEEP = new Set(['PSMODULEPATH', 'PATH', 'PATHEXT']);

function allowList(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env.MY_AGENT_TERMINAL_ENV_ALLOW ?? '';
  return new Set(
    raw
      .split(/[,;\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

export function isSecretEnvName(name: string): boolean {
  if (ALWAYS_KEEP.has(name.toUpperCase())) return false;
  return SECRET_NAME_RE.test(name);
}

export function buildTerminalEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allow = allowList(source);
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isSecretEnvName(name) && !allow.has(name.toUpperCase())) continue;
    out[name] = value;
  }
  return out;
}
