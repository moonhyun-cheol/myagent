/**
 * Domain connectors L1 mock — registry match + invent/gate without live APIs.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function row(item, result, ms, note = '') {
  return { suite: 'domains', item, level: 1, result, ms, note: String(note).slice(0, 240) };
}

export async function runDomainL1(root) {
  const rows = [];
  const t0 = Date.now();
  try {
    const mod = await import(
      pathToFileURL(path.join(root, 'core/dist/agent/agent-domain-registry.js')).href
    );
    const {
      loadDomainConnectors,
      resolveDeliverySecrets,
      resetDomainConnectorsCache,
    } = mod;

    resetDomainConnectorsCache?.();
    const doc = loadDomainConnectors(root);
    const ids = (doc.connectors || []).map((c) => c.id);
    rows.push(
      row(
        'connectors_load',
        ids.length === 0 ? 'pass' : 'fail',
        Date.now() - t0,
        ids.length ? `unexpected defaults: ${ids.join(',')}` : 'neutral core has no organization connectors',
      ),
    );

    {
      const start = Date.now();
      const del = resolveDeliverySecrets({
        message: 'Discord webhook 웹훅  macro 전송',
        artifactKind: 'discord_bot',
        cqrRoot: root,
      });
      const ok =
        del.profileId === 'discord_webhook'
        || (del.secrets || []).includes('DISCORD_WEBHOOK_URL');
      rows.push(
        row(
          'delivery_webhook_prefer',
          ok ? 'pass' : 'fail',
          Date.now() - start,
          `profile=${del.profileId}; secrets=${(del.secrets || []).join(',')}`,
        ),
      );
    }
  } catch (e) {
    rows.push(row('domains_l1', 'fail', Date.now() - t0, e instanceof Error ? e.message : String(e)));
  }
  return rows;
}
