import { loadDeployDefaults } from '../config/deploy-defaults.js';

const DISABLED = new Set(['0', 'off', 'none', 'false', 'disabled']);
const ENABLED = new Set(['1', 'on', 'true', 'enabled']);

/**
 * File-license gates are off by default. The public repo already ships the
 * verifier, so a signed .ocx is not an access control. Turn back on with
 * deploy-defaults.license_enforcement or MY_AGENT_LICENSE_ENFORCEMENT=1.
 */
export function isLicenseEnforcementEnabled(cqrRoot: string): boolean {
  const raw = process.env.MY_AGENT_LICENSE_ENFORCEMENT ?? process.env.CQR_LICENSE_ENFORCEMENT;
  if (raw !== undefined) {
    const value = raw.trim().toLowerCase();
    if (!value || DISABLED.has(value)) return false;
    if (ENABLED.has(value)) return true;
  }
  return loadDeployDefaults(cqrRoot).license_enforcement === true;
}
