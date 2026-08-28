/**
 * Single source of truth: dev test env === deploy activation env.
 * policy.json, license.ocx.example, and issued licenses must include these.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Unlocks + menu, chat, models tab, and all sidebar tools. */
export const REQUIRED_LICENSE_FEATURES = [
  'chat',
  'manager',
  'local_models',
  'image_generation',
  'deep_research',
  'local_image',
  'web_dev',
  'browser_automation',
];

export const REQUIRED_SKILL_MANIFEST = [
  { id: 'web_dev', feature: 'web_dev' },
];

export function missingFeatures(features, required = REQUIRED_LICENSE_FEATURES) {
  const set = new Set(features ?? []);
  return required.filter((f) => !set.has(f));
}

export function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function readLicenseFeatures(filePath) {
  const doc = readJsonFile(filePath);
  return doc?.payload?.features ?? null;
}

export function loadActivationPolicy(root) {
  const policyPath = path.join(root, 'activation-server', 'policy.json');
  const doc = readJsonFile(policyPath);
  if (!doc) return { ok: false, path: policyPath, error: 'POLICY_MISSING' };
  return { ok: true, path: policyPath, policy: doc };
}

export function loadDeployDefaults(root, appDir = root) {
  const rel = 'core/config/defaults/deploy-defaults.json';
  const filePath = path.join(appDir, rel);
  const doc = readJsonFile(filePath);
  if (!doc) return { ok: false, path: filePath, error: 'DEPLOY_DEFAULTS_MISSING' };
  return { ok: true, path: filePath, deploy: doc };
}

export function loadSkillsManifest(root, appDir = root) {
  const rel = 'core/config/defaults/skills/manifest.json';
  const filePath = path.join(appDir, rel);
  const doc = readJsonFile(filePath);
  if (!doc) return { ok: false, path: filePath, error: 'SKILLS_MANIFEST_MISSING' };
  return { ok: true, path: filePath, manifest: doc };
}

/**
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function checkDeployParity(root, options = {}) {
  const appDir = options.appDir ?? root;
  const errors = [];
  const warnings = [];

  const policyLoad = loadActivationPolicy(root);
  if (!policyLoad.ok) {
    errors.push(`activation-server/policy.json missing (${policyLoad.path})`);
  } else {
    const { policy } = policyLoad;
    const missing = missingFeatures(policy.features);
    if (missing.length) {
      errors.push(`policy.json missing features: ${missing.join(', ')}`);
    }
    if (policy.require_allowlist === true) {
      warnings.push(
        'policy.json require_allowlist=true — deploy PCs need manual allowlist (dev test uses open activation)',
      );
    }
    if (!policy.org_id?.trim()) {
      errors.push('policy.json org_id is empty');
    }
  }

  const deployLoad = loadDeployDefaults(root, appDir);
  if (!deployLoad.ok) {
    errors.push(`deploy-defaults.json missing (${deployLoad.path})`);
  } else {
    const { deploy } = deployLoad;
    if (!deploy.ollama_base_url?.trim()) {
      errors.push('deploy-defaults.json ollama_base_url is empty');
    }
    if (!deploy.activation_server_url?.trim()) {
      warnings.push(
        'deploy-defaults.json activation_server_url is empty — neutral core uses file-only/local mode',
      );
    }
    if (!deploy.ollama_default_model?.trim()) {
      warnings.push('deploy-defaults.json ollama_default_model is empty');
    }
  }

  if (policyLoad.ok && deployLoad.ok) {
    const bundleOrg = process.env.MY_AGENT_BUNDLE_ORG?.trim() || policyLoad.policy.org_id || 'myorg';
    if (policyLoad.policy.org_id !== bundleOrg) {
      warnings.push(
        `policy org_id=${policyLoad.policy.org_id} differs from bundle org=${bundleOrg}`,
      );
    }
  }

  const manifestLoad = loadSkillsManifest(root, appDir);
  if (!manifestLoad.ok) {
    errors.push(`skills manifest missing (${manifestLoad.path})`);
  } else {
    const skills = manifestLoad.manifest.skills ?? {};
    for (const { id, feature } of REQUIRED_SKILL_MANIFEST) {
      const def = skills[id];
      if (!def) {
        errors.push(`skills manifest missing skill: ${id}`);
        continue;
      }
      if (def.feature !== feature) {
        errors.push(`skills manifest ${id}: expected feature ${feature}, got ${def.feature ?? 'none'}`);
      }
      if (policyLoad.ok) {
        const policyFeatures = policyLoad.policy.features ?? [];
        if (!policyFeatures.includes(feature)) {
          errors.push(`policy.json missing manifest feature for ${id}: ${feature}`);
        }
      }
    }
  }

  const srcPem = path.join(appDir, 'core', 'config', 'defaults', 'license-public.pem');
  const distPem = path.join(appDir, 'core', 'dist', 'config', 'defaults', 'license-public.pem');
  if (!existsSync(srcPem)) {
    errors.push(`license-public.pem missing (${srcPem})`);
  } else if (!existsSync(distPem)) {
    errors.push(`built license-public.pem missing (${distPem}) — run: npm run build`);
  } else {
    const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
    if (hash(srcPem) !== hash(distPem)) {
      errors.push(
        'license-public.pem mismatch between core/config/defaults and core/dist/config/defaults — run: npm run build',
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function formatParityReport(result) {
  const lines = [];
  for (const w of result.warnings) lines.push(`  WARN ${w}`);
  for (const e of result.errors) lines.push(`  FAIL ${e}`);
  return lines.join('\n');
}
