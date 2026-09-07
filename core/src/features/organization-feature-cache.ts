/** Break import cycles: feature manager must not statically import automaton loaders. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function invalidateOrganizationFeatureCaches(): void {
  try {
    const catalog = require('../automaton/tool-catalog.js') as {
      resetAutomatonToolManifestCache?: () => void;
    };
    catalog.resetAutomatonToolManifestCache?.();
  } catch {
    /* dist may be mid-build */
  }
  try {
    const workflows = require('../automaton/openclaw-workflow-map.js') as {
      resetOpenClawWorkflowMapCache?: () => void;
    };
    workflows.resetOpenClawWorkflowMapCache?.();
  } catch {
    /* dist may be mid-build */
  }
}
