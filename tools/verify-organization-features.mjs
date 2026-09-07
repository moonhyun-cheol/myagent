#!/usr/bin/env node
/**
 * Organization Feature: signed install, work-kit apply, slash feature_required, shared refs.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distHref = (rel) => pathToFileURL(path.join(root, 'core', 'dist', rel)).href;

const featureMod = await import(distHref('features/organization-feature-manager.js'));
const catalogMod = await import(distHref('automaton/tool-catalog.js'));
const workflowMod = await import(distHref('automaton/openclaw-workflow-map.js'));
const intentMod = await import(distHref('router/automaton-intent.js'));
const profileMod = await import(distHref('config/agent-profile-store.js'));
const adapterMod = await import(distHref('automaton/adapter-connection.js'));

const {
  FEATURE_JSON_SCHEMA,
  OrganizationFeatureError,
  assertFeaturePayloadPath,
  buildSignedFeaturePayloadFromDir,
  disableOrganizationFeature,
  enableOrganizationFeature,
  installOrganizationFeatureFromZip,
  isOrganizationFeatureEnabled,
  listOrganizationFeatures,
  organizationFeaturesRoot,
  removeOrganizationFeature,
} = featureMod;
const { resetAutomatonToolManifestCache, listAutomatonTools } = catalogMod;
const { resetOpenClawWorkflowMapCache, resolveOpenClawWorkflow } = workflowMod;
const { peekAutomatonIntent, resolveSlashRoute } = intentMod;
const { applyWorkKit } = profileMod;
const { resolveAdapterConnectionPath, loadAdapterConnection } = adapterMod;

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function zipDirectory(sourceDir, zipPath) {
  if (existsSync(zipPath)) rmSync(zipPath, { force: true });
  const zip = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `[IO.Compression.ZipFile]::CreateFromDirectory('${sourceDir.replace(/'/g, "''")}', '${zipPath.replace(/'/g, "''")}', [IO.Compression.CompressionLevel]::Optimal, $false, [Text.Encoding]::UTF8)`,
      ].join('; '),
    ],
    { encoding: 'utf8' },
  );
  if (zip.status !== 0 || !existsSync(zipPath)) {
    throw new Error(zip.stderr?.toString() || 'zip failed');
  }
}

function writeFeatureStage(stageDir, featureId) {
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(
    path.join(stageDir, 'feature.json'),
    `${JSON.stringify({
      schema: FEATURE_JSON_SCHEMA,
      id: featureId,
      version: '1.0.0',
      update_sequence: 1,
      label: 'Test Automaton Routing',
      capabilities: ['automaton-routing'],
      entrypoints: {
        automaton_tools_manifest: 'automaton-tools.manifest.json',
        openclaw_workflow_map: 'openclaw-workflow-map.json',
        adapter_connection: 'adapter-connection.json',
      },
    }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(stageDir, 'automaton-tools.manifest.json'),
    `${JSON.stringify({
      version: 2,
      tools: [{
        id: 'feature_demo_tool',
        description_ko: '피처 데모',
        slash_prefixes: ['/피처데모'],
        default_command: '/피처데모',
      }],
    }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(stageDir, 'openclaw-workflow-map.json'),
    `${JSON.stringify({
      version: 1,
      workflows: {
        feature_demo_tool: {
          task_profile_id: 'demo',
          tool_id: 'feature_demo_tool',
          args: {},
        },
      },
    }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(stageDir, 'adapter-connection.json'),
    `${JSON.stringify({
      version: 1,
      base_url: 'https://example.invalid',
      authentication: { mode: 'install_bootstrap', bootstrap_path: '/auth/bootstrap' },
    }, null, 2)}\n`,
  );
  const { envelopeJson } = buildSignedFeaturePayloadFromDir(stageDir, privatePem);
  writeFileSync(path.join(stageDir, 'update-payload.json'), envelopeJson);
}

function buildFeatureZip(featureId) {
  const stage = mkdtempSync(path.join(os.tmpdir(), 'feat-stage-'));
  writeFeatureStage(stage, featureId);
  const zipPath = path.join(os.tmpdir(), `${featureId.replaceAll('.', '-')}-${Date.now()}.zip`);
  zipDirectory(stage, zipPath);
  rmSync(stage, { recursive: true, force: true });
  return zipPath;
}

const cqrRoot = mkdtempSync(path.join(os.tmpdir(), 'myagent-feat-'));
mkdirSync(path.join(cqrRoot, 'data', 'vault'), { recursive: true });
writeFileSync(path.join(cqrRoot, 'data', 'vault', 'organization-module-public.pem'), publicPem);
writeFileSync(path.join(cqrRoot, 'manifest.json'), JSON.stringify({ update_sequence: 41, version: '1.1.4' }));

// Path traversal blocked
assert.throws(() => assertFeaturePayloadPath('../escape'), /FEATURE_PATH|Unsafe/);
assert.throws(() => assertFeaturePayloadPath('data/secret'), /FEATURE_PATH|Protected/);

// Non-user: no feature directory until install
assert.equal(existsSync(organizationFeaturesRoot(cqrRoot)), false);
assert.deepEqual(listOrganizationFeatures(cqrRoot), []);

const featureId = 'org.example.automaton-routing';
const zipPath = buildFeatureZip(featureId);

// Bad signature rejected
{
  const badStage = mkdtempSync(path.join(os.tmpdir(), 'feat-bad-'));
  writeFeatureStage(badStage, featureId);
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherPem = other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const { envelopeJson } = buildSignedFeaturePayloadFromDir(badStage, otherPem);
  writeFileSync(path.join(badStage, 'update-payload.json'), envelopeJson);
  const badZip = path.join(os.tmpdir(), `bad-${Date.now()}.zip`);
  zipDirectory(badStage, badZip);
  assert.throws(
    () => installOrganizationFeatureFromZip(cqrRoot, badZip, { publicKeyPem: publicPem }),
    (err) => err instanceof OrganizationFeatureError && err.code === 'FEATURE_SIGNATURE',
  );
  rmSync(badStage, { recursive: true, force: true });
  rmSync(badZip, { force: true });
  assert.equal(existsSync(organizationFeaturesRoot(cqrRoot)), false, 'failed install must not create live root');
}

// Signed install success (not enabled yet)
installOrganizationFeatureFromZip(cqrRoot, zipPath, { publicKeyPem: publicPem, enable: false });
assert.equal(isOrganizationFeatureEnabled(cqrRoot, featureId), false);
resetAutomatonToolManifestCache();
assert.equal(peekAutomatonIntent('/피처데모', cqrRoot), null, 'disabled feature must not register slash');

enableOrganizationFeature(cqrRoot, featureId, { confirm: true });
resetAutomatonToolManifestCache();
resetOpenClawWorkflowMapCache();
const hit = peekAutomatonIntent('/피처데모 x', cqrRoot);
assert.ok(hit);
assert.equal(hit.toolId, 'feature_demo_tool');
assert.ok(listAutomatonTools(cqrRoot).some((t) => t.id === 'feature_demo_tool'));
assert.ok(resolveOpenClawWorkflow('feature_demo_tool', cqrRoot));
assert.ok(resolveAdapterConnectionPath(cqrRoot)?.includes(featureId));
assert.ok(loadAdapterConnection(cqrRoot)?.base_url);

disableOrganizationFeature(cqrRoot, featureId, { confirm: true });
resetAutomatonToolManifestCache();
assert.equal(peekAutomatonIntent('/피처데모', cqrRoot), null);

// Optional slash index → feature_required (not LLM)
const orgRoot = path.join(cqrRoot, 'modules', 'organization');
mkdirSync(orgRoot, { recursive: true });
writeFileSync(
  path.join(orgRoot, 'optional-feature-slash-index.json'),
  `${JSON.stringify({
    version: 1,
    slashes: [{
      prefix: '/피처데모',
      feature_id: featureId,
      message_ko: 'Work Kit 적용이 필요합니다.',
    }],
  }, null, 2)}\n`,
);
const required = resolveSlashRoute('/피처데모 OVERALL', cqrRoot);
assert.ok(required);
assert.equal(required.routing.mode, 'automaton_direct');
assert.equal(required.routing.matched_tool, undefined);
assert.equal(required.routing.feature_required?.feature_id, featureId);
assert.match(required.routing.feature_required.message, /Work Kit/);

enableOrganizationFeature(cqrRoot, featureId, { confirm: true });
resetAutomatonToolManifestCache();
const afterEnable = resolveSlashRoute('/피처데모 OVERALL', cqrRoot);
assert.equal(afterEnable.routing.matched_tool, 'feature_demo_tool');
assert.equal(afterEnable.routing.feature_required, undefined);

// Work Kit v1 compat (no features field) still applies
const locker = mkdtempSync(path.join(os.tmpdir(), 'feat-locker-'));
const shelfDir = path.join(locker, 'profiles', 'demo', 'kit-a');
mkdirSync(shelfDir, { recursive: true });
writeFileSync(
  path.join(shelfDir, 'shelf.json'),
  `${JSON.stringify({
    schema_version: 1,
    id: 'kit-a',
    group: 'demo',
    label: 'Demo Kit',
    pull: [],
    plugins: { enable: {} },
  }, null, 2)}\n`,
);
writeFileSync(path.join(shelfDir, '.install-meta.json'), JSON.stringify({ asset_sequence: 1 }));

// Point locker via env
process.env.MY_AGENT_WORK_KIT_LOCKER = locker;
const appliedV1 = applyWorkKit(cqrRoot, { group: 'demo', id: 'kit-a', confirm: true, lockerRoot: locker });
assert.equal(appliedV1.ok, true);
assert.deepEqual(appliedV1.installed_features ?? [], []);

// Work Kit with features.enable + pack
const shelfB = path.join(locker, 'profiles', 'demo', 'kit-b');
mkdirSync(path.join(shelfB, 'features'), { recursive: true });
const featureId2 = 'org.example.shared-routing';
const zip2 = buildFeatureZip(featureId2);
writeFileSync(path.join(shelfB, 'features', `${featureId2}.zip`), readFileSync(zip2));
writeFileSync(
  path.join(shelfB, 'shelf.json'),
  `${JSON.stringify({
    schema_version: 1,
    id: 'kit-b',
    group: 'demo',
    label: 'Feature Kit',
    pull: [],
    plugins: { enable: {} },
    features: { enable: { [featureId2]: { required: true } } },
  }, null, 2)}\n`,
);
writeFileSync(path.join(shelfB, '.install-meta.json'), JSON.stringify({ asset_sequence: 1 }));

const appliedB = applyWorkKit(cqrRoot, { group: 'demo', id: 'kit-b', confirm: true, lockerRoot: locker });
assert.equal(appliedB.ok, true);
assert.ok(appliedB.enabled_features.includes(featureId2));
assert.equal(isOrganizationFeatureEnabled(cqrRoot, featureId2), true);

// Shared ref: second kit
const shelfC = path.join(locker, 'profiles', 'demo', 'kit-c');
mkdirSync(path.join(shelfC, 'features'), { recursive: true });
writeFileSync(path.join(shelfC, 'features', `${featureId2}.zip`), readFileSync(zip2));
writeFileSync(
  path.join(shelfC, 'shelf.json'),
  `${JSON.stringify({
    schema_version: 1,
    id: 'kit-c',
    group: 'demo',
    label: 'Shared Feature Kit',
    pull: [],
    plugins: { enable: {} },
    features: { enable: { [featureId2]: { required: true } } },
  }, null, 2)}\n`,
);
writeFileSync(path.join(shelfC, '.install-meta.json'), JSON.stringify({ asset_sequence: 1 }));
applyWorkKit(cqrRoot, { group: 'demo', id: 'kit-c', confirm: true, lockerRoot: locker });
const shared = listOrganizationFeatures(cqrRoot).find((f) => f.id === featureId2);
assert.ok(shared?.refs.includes('demo/kit-b'));
assert.ok(shared?.refs.includes('demo/kit-c'));
assert.throws(
  () => removeOrganizationFeature(cqrRoot, featureId2, { confirm: true }),
  (err) => err instanceof OrganizationFeatureError && err.code === 'FEATURE_IN_USE',
);

// restore-last restores feature enabled snapshot
disableOrganizationFeature(cqrRoot, featureId2, { confirm: true, removeRef: 'demo/kit-b' });
// still enabled due to kit-c ref
assert.equal(isOrganizationFeatureEnabled(cqrRoot, featureId2), true);

// Legacy org module loading still works alongside features
writeFileSync(
  path.join(orgRoot, 'automaton-tools.manifest.json'),
  `${JSON.stringify({
    version: 2,
    tools: [{
      id: 'legacy_org_tool',
      description_ko: '레거시',
      slash_prefixes: ['/레거시명령'],
      default_command: '/레거시명령',
    }],
  }, null, 2)}\n`,
);
resetAutomatonToolManifestCache();
assert.ok(peekAutomatonIntent('/레거시명령', cqrRoot), 'legacy organization module must still route');

// Cleanup remove with force
removeOrganizationFeature(cqrRoot, featureId2, { confirm: true, force: true });
assert.equal(isOrganizationFeatureEnabled(cqrRoot, featureId2), false);

rmSync(cqrRoot, { recursive: true, force: true });
rmSync(locker, { recursive: true, force: true });
rmSync(zipPath, { force: true });
rmSync(zip2, { force: true });
delete process.env.MY_AGENT_WORK_KIT_LOCKER;

console.log('verify-organization-features: ok');
