#!/usr/bin/env node
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distHref = (rel) => pathToFileURL(path.join(root, 'core', 'dist', rel)).href;

const cryptoMod = await import(distHref('updates/organization-module-crypto.js'));
const installerMod = await import(distHref('updates/organization-module-installer.js'));
const registryMod = await import(distHref('skills/skill-registry.js'));
const {
  MODULE_FEED_SCHEMA,
  MODULE_PAYLOAD_SCHEMA,
  OrganizationModuleError,
  createSignedEnvelope,
  sha256Bytes,
  sha256File,
} = cryptoMod;
const { installOrganizationModule, readInstalledOrganizationModule } = installerMod;
const { listAllSkills, getSkillSystemPrompt, listBundledSkills } = registryMod;

function walkFiles(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (lstatSync(abs).isDirectory()) {
      out.push(...walkFiles(abs, rel.replaceAll('\\', '/')));
    } else {
      out.push({
        path: rel.replaceAll('\\', '/'),
        size: statSync(abs).size,
        sha256: sha256File(abs),
      });
    }
  }
  return out;
}

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
    throw new Error(zip.stderr?.toString().trim() || 'zip failed');
  }
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function buildPack({ sequence, version, skillBody, overlayBody }) {
  const stage = mkdtempSync(path.join(os.tmpdir(), 'org-mod-stage-'));
  const org = path.join(stage, 'modules', 'organization');
  mkdirSync(path.join(org, 'skills'), { recursive: true });
  mkdirSync(path.join(org, 'brand'), { recursive: true });
  writeFileSync(
    path.join(org, 'skills', 'manifest.json'),
    `${JSON.stringify({
      version: 1,
      overlays: {
        web_landing: { brand_files: ['brand/web-landing-context.md'] },
      },
      skills: {
        market_research: {
          label: '시장조사',
          mode: 'org:market_research',
          feature: 'chat',
          brand_files: ['skills/market-research.md'],
          bundle_files: [],
        },
      },
    }, null, 2)}\n`,
  );
  writeFileSync(path.join(org, 'skills', 'market-research.md'), `${skillBody}\n`);
  writeFileSync(path.join(org, 'brand', 'web-landing-context.md'), `${overlayBody}\n`);
  writeFileSync(
    path.join(org, 'module.json'),
    `${JSON.stringify({
      id: 'organization',
      kind: 'organization-module',
      version,
      update_sequence: sequence,
      install_root: 'modules/organization',
      required_core_api: '1.0.0-beta.1',
      update_feed_url: 'https://raw.githubusercontent.com/moonhyun-cheol/myagent-org/main/channels/beta.json',
      update_channel: 'beta',
      capabilities: ['skills', 'brand-context'],
    }, null, 2)}\n`,
  );
  const files = walkFiles(stage).filter((file) => file.path !== 'update-payload.json');
  const payload = {
    schema: MODULE_PAYLOAD_SCHEMA,
    update_sequence: sequence,
    minimum_supported_sequence: 1,
    version,
    channel: 'beta',
    created_at: '2026-08-27T00:00:00.000Z',
    files,
    deleted: [],
  };
  const payloadEnvelope = createSignedEnvelope(payload, privatePem);
  const payloadBytes = Buffer.from(`${JSON.stringify(payloadEnvelope, null, 2)}\n`);
  writeFileSync(path.join(stage, 'update-payload.json'), payloadBytes);
  const zipPath = path.join(os.tmpdir(), `org-mod-${sequence}-${Date.now()}.zip`);
  zipDirectory(stage, zipPath);
  const feed = {
    schema: MODULE_FEED_SCHEMA,
    kind: 'organization-module',
    update_sequence: sequence,
    minimum_supported_sequence: 1,
    version,
    channel: 'beta',
    published_at: '2026-08-27T00:00:00.000Z',
    asset: {
      repository: 'moonhyun-cheol/myagent-org',
      release_tag: `update-${sequence}`,
      name: path.basename(zipPath),
      size: statSync(zipPath).size,
      sha256: sha256File(zipPath),
    },
    payload_manifest_sha256: sha256Bytes(payloadBytes),
    release_notes: 'fixture',
  };
  const feedPath = path.join(os.tmpdir(), `org-feed-${sequence}-${Date.now()}.json`);
  writeFileSync(feedPath, `${JSON.stringify(createSignedEnvelope(feed, privatePem), null, 2)}\n`);
  rmSync(stage, { recursive: true, force: true });
  return { zipPath, feedPath };
}

const installRoot = mkdtempSync(path.join(os.tmpdir(), 'org-mod-install-'));
const leftovers = [];
try {
  writeFileSync(
    path.join(installRoot, 'manifest.json'),
    `${JSON.stringify({ name: 'MY Agent', version: '1.0.0-beta.1', update_sequence: 1 }, null, 2)}\n`,
  );
  mkdirSync(path.join(installRoot, 'core', 'config', 'defaults'), { recursive: true });
  writeFileSync(path.join(installRoot, 'core', 'config', 'defaults', 'organization-module-public.pem'), publicPem);

  assert.deepEqual(
    listBundledSkills().map((skill) => skill.id).sort(),
    ['prompt_master', 'web_dev', 'web_landing'],
  );
  assert.equal(listAllSkills(installRoot).some((skill) => skill.source === 'organization'), false);

  const pack2 = buildPack({
    sequence: 2,
    version: '1.0.1',
    skillBody: 'ORG MARKET RESEARCH FIXTURE',
    overlayBody: 'ORG LANDING OVERLAY FIXTURE',
  });
  leftovers.push(pack2.zipPath, pack2.feedPath);
  const installed = installOrganizationModule({
    cqrRoot: installRoot,
    zipPath: pack2.zipPath,
    feedPath: pack2.feedPath,
    publicKeyPem: publicPem,
  });
  assert.equal(installed.installed.update_sequence, 2);
  assert.ok(readInstalledOrganizationModule(installRoot));

  const skills = listAllSkills(installRoot);
  const orgSkill = skills.find((skill) => skill.id === 'market_research' && skill.source === 'organization');
  assert.ok(orgSkill);
  assert.equal(orgSkill.mode, 'org:market_research');
  assert.equal(orgSkill.editable, false);
  const prompt = getSkillSystemPrompt('market_research', installRoot);
  assert.match(prompt ?? '', /ORG MARKET RESEARCH FIXTURE/);
  const landing = getSkillSystemPrompt('web_landing', installRoot);
  assert.match(landing ?? '', /ORG LANDING OVERLAY FIXTURE/);

  const pack1 = buildPack({
    sequence: 1,
    version: '1.0.0',
    skillBody: 'OLD',
    overlayBody: 'OLD',
  });
  leftovers.push(pack1.zipPath, pack1.feedPath);
  let rejected = false;
  try {
    installOrganizationModule({
      cqrRoot: installRoot,
      zipPath: pack1.zipPath,
      feedPath: pack1.feedPath,
      publicKeyPem: publicPem,
    });
  } catch (error) {
    rejected = error instanceof OrganizationModuleError && error.code === 'MODULE_NOT_NEWER';
  }
  assert.equal(rejected, true);

  const zipOnlyRoot = mkdtempSync(path.join(os.tmpdir(), 'org-mod-zip-only-'));
  leftovers.push(zipOnlyRoot);
  writeFileSync(
    path.join(zipOnlyRoot, 'manifest.json'),
    `${JSON.stringify({ name: 'MY Agent', version: '1.0.0-beta.1', update_sequence: 1 }, null, 2)}\n`,
  );
  mkdirSync(path.join(zipOnlyRoot, 'core', 'config', 'defaults'), { recursive: true });
  writeFileSync(path.join(zipOnlyRoot, 'core', 'config', 'defaults', 'organization-module-public.pem'), publicPem);
  const zipOnly = installOrganizationModule({
    cqrRoot: zipOnlyRoot,
    zipPath: pack2.zipPath,
    publicKeyPem: publicPem,
  });
  assert.equal(zipOnly.installed.update_sequence, 2);
  assert.ok(readInstalledOrganizationModule(zipOnlyRoot));
  assert.equal(
    listAllSkills(zipOnlyRoot).some((skill) => skill.id === 'market_research' && skill.source === 'organization'),
    true,
  );

  const current = readInstalledOrganizationModule(installRoot);
  assert.ok(current?.update_feed_url?.includes('raw.githubusercontent.com'));

  const feedMod = await import(distHref('updates/organization-module-feed.js'));
  const moduleJsonPath = path.join(current.root, 'module.json');
  const moduleDoc = JSON.parse(readFileSync(moduleJsonPath, 'utf8'));
  moduleDoc.update_feed_url = 'https://example.com/feed.json';
  writeFileSync(moduleJsonPath, `${JSON.stringify(moduleDoc, null, 2)}\n`);
  let hostRejected = false;
  try {
    await feedMod.checkOrganizationModuleUpdate(installRoot);
  } catch (error) {
    hostRejected = error instanceof OrganizationModuleError && error.code === 'MODULE_FEED_HOST';
  }
  assert.equal(hostRejected, true);
  moduleDoc.update_feed_url = current.update_feed_url;
  writeFileSync(moduleJsonPath, `${JSON.stringify(moduleDoc, null, 2)}\n`);

  const dispatch = readFileSync(path.join(root, 'core', 'src', 'routes', 'dispatch.ts'), 'utf8');
  assert.match(dispatch, /\/organization-module/);
  assert.match(dispatch, /organization-module\/check/);
  assert.match(dispatch, /organization-module\/install/);
  const skillsUi = readFileSync(path.join(root, 'ui', 'workspace', 'src', 'components', 'SettingsSkillsPage.tsx'), 'utf8');
  assert.match(skillsUi, /purpose: 'organizationModuleZip'/);
  assert.match(skillsUi, /data-testid="organization-module-install"/);
  assert.match(skillsUi, /organization-skill-\$\{skill\.id\}/);
  assert.match(skillsUi, /채팅에 사용/);
  const shell = readFileSync(path.join(root, 'shell', 'CqrPa.Shell', 'MainWindow.xaml.cs'), 'utf8');
  assert.match(shell, /organizationModuleZip/);
  const apiServer = readFileSync(path.join(root, 'core', 'src', 'api-server.ts'), 'utf8');
  assert.match(apiServer, /maybeApplyOrganizationModuleOnLaunch/);
  const feedSrc = readFileSync(path.join(root, 'core', 'src', 'updates', 'organization-module-feed.ts'), 'utf8');
  assert.match(feedSrc, /maybeApplyOrganizationModuleOnLaunch/);
  assert.match(feedSrc, /MY_AGENT_UPDATE_CHECK/);

  const skipPrev = process.env.MY_AGENT_UPDATE_CHECK;
  process.env.MY_AGENT_UPDATE_CHECK = '0';
  const skipped = await feedMod.maybeApplyOrganizationModuleOnLaunch(installRoot, { licensed: true });
  assert.equal(skipped.applied, false);
  if (skipPrev === undefined) delete process.env.MY_AGENT_UPDATE_CHECK;
  else process.env.MY_AGENT_UPDATE_CHECK = skipPrev;
  const unlicensed = await feedMod.maybeApplyOrganizationModuleOnLaunch(installRoot, { licensed: false });
  assert.equal(unlicensed.applied, false);
  const publish = readFileSync(
    path.join(root, '..', 'MY_CUSTOM_CODEX-COMPANY', 'tools', 'publish-module-update.mjs'),
    'utf8',
  );
  assert.match(publish, /channelFeedPath/);
  assert.match(publish, /stageAgentModule/);

  console.log('verify-organization-module: ok');
} finally {
  rmSync(installRoot, { recursive: true, force: true });
  for (const leftover of leftovers) {
    try { rmSync(leftover, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
