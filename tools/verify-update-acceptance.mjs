#!/usr/bin/env node
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { publishUpdater } from './updater-publish.mjs';
import {
  buildPayloadManifest,
  buildReleaseFeed,
  createSignedEnvelope,
  sha256Bytes,
  sha256File,
} from './update/update-signing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const updaterOut = path.join(root, 'bin', 'my-agent-updater');
const updater = publishUpdater({ root, outDir: updaterOut, label: 'verify-update-acceptance' });
assert.equal(updater.ok, true, updater.reason);

const temp = mkdtempSync(path.join(os.tmpdir(), 'my-agent-update-acceptance-'));
let runningFixturePid = null;

function resolveDotnet() {
  const candidates = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'dotnet', 'dotnet.exe') : null,
    process.env['ProgramFiles(x86)']
      ? path.join(process.env['ProgramFiles(x86)'], 'dotnet', 'dotnet.exe')
      : null,
  ].filter(Boolean);
  return candidates.find(candidate => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) ?? 'dotnet';
}

function copyDirectoryContents(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    cpSync(path.join(source, entry), path.join(destination, entry), {
      recursive: true,
      force: true,
    });
  }
}

function buildFixture(kind) {
  const projectDir = path.join(temp, `fixture-${kind}`);
  const outputDir = path.join(temp, `fixture-${kind}-out`);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    path.join(projectDir, 'Fixture.csproj'),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <AssemblyName>MYAgent</AssemblyName>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <UseAppHost>true</UseAppHost>
  </PropertyGroup>
</Project>
`,
  );
  const source = kind === 'healthy'
    ? `using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

using var manifest = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(Environment.CurrentDirectory, "manifest.json")));
var version = manifest.RootElement.GetProperty("version").GetString() ?? "unknown";
var port = manifest.RootElement.GetProperty("api_port_default").GetInt32();
File.WriteAllText(Path.Combine(Environment.CurrentDirectory, "fixture.pid"), Environment.ProcessId.ToString());
var listener = new TcpListener(IPAddress.Loopback, port);
listener.Start();
while (true)
{
    using var client = await listener.AcceptTcpClientAsync();
    await using var stream = client.GetStream();
    using var reader = new StreamReader(stream, Encoding.ASCII, leaveOpen: true);
    while (!string.IsNullOrEmpty(await reader.ReadLineAsync())) { }
    var body = JsonSerializer.Serialize(new { product = "MY Agent", version });
    var payload = Encoding.UTF8.GetBytes(body);
    var headers = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: " + payload.Length + "\\r\\nConnection: close\\r\\n\\r\\n");
    await stream.WriteAsync(headers);
    await stream.WriteAsync(payload);
}
`
    : `return 1;
`;
  writeFileSync(path.join(projectDir, 'Program.cs'), source);
  const built = spawnSync(
    resolveDotnet(),
    ['publish', path.join(projectDir, 'Fixture.csproj'), '-c', 'Release', '-o', outputDir, '-v', 'q'],
    { encoding: 'utf8', env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1' } },
  );
  assert.equal(built.status, 0, `${built.stdout ?? ''}${built.stderr ?? ''}`);
  assert.equal(statSync(path.join(outputDir, 'MYAgent.exe')).isFile(), true);
  return outputDir;
}

function writeProductManifest(directory, sequence, version, port) {
  writeFileSync(
    path.join(directory, 'manifest.json'),
    `${JSON.stringify({
      name: 'MY Agent',
      version,
      build: 'beta',
      update_channel: 'beta',
      update_sequence: sequence,
      minimum_supported_sequence: 1,
      update_repository: 'moonhyun-cheol/MY_CUSTOM_CODEX',
      update_feed_url:
        'https://raw.githubusercontent.com/moonhyun-cheol/MY_CUSTOM_CODEX/main/channels/beta.json',
      api_port_default: port,
    }, null, 2)}\n`,
  );
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function createUpdate({
  sequence,
  version,
  port,
  fixtureOutput,
  privatePem,
  deleted = [],
  stateText,
}) {
  const payloadDir = path.join(temp, `payload-${sequence}`);
  mkdirSync(payloadDir, { recursive: true });
  copyDirectoryContents(fixtureOutput, payloadDir);
  writeProductManifest(payloadDir, sequence, version, port);
  mkdirSync(path.join(payloadDir, 'core', 'dist'), { recursive: true });
  writeFileSync(path.join(payloadDir, 'core', 'dist', 'state.txt'), `${stateText}\n`);
  if (!deleted.includes('core/dist/keep.txt')) {
    writeFileSync(path.join(payloadDir, 'core', 'dist', 'keep.txt'), 'preserve-on-rollback\n');
  }

  const payloadDocument = buildPayloadManifest(payloadDir, {
    updateSequence: sequence,
    minimumSupportedSequence: 1,
    version,
    channel: 'beta',
    createdAt: `2026-08-26T00:00:0${sequence}.000Z`,
    deleted,
  });
  const payloadEnvelopePath = path.join(payloadDir, 'update-payload.json');
  writeFileSync(
    payloadEnvelopePath,
    `${JSON.stringify(createSignedEnvelope(payloadDocument, privatePem), null, 2)}\n`,
  );
  const zipPath = path.join(temp, `update-${sequence}.zip`);
  const zipped = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', payloadDir, '.'], {
    encoding: 'utf8',
  });
  assert.equal(zipped.status, 0, `${zipped.stdout ?? ''}${zipped.stderr ?? ''}`);
  const payloadEnvelopeBytes = readFileSync(payloadEnvelopePath);
  const feedDocument = buildReleaseFeed({
    updateSequence: sequence,
    minimumSupportedSequence: 1,
    version,
    channel: 'beta',
    publishedAt: payloadDocument.created_at,
    repository: 'moonhyun-cheol/MY_CUSTOM_CODEX',
    releaseTag: `update-${sequence}`,
    assetName: path.basename(zipPath),
    assetSize: statSync(zipPath).size,
    assetSha256: sha256File(zipPath),
    payloadManifestSha256: sha256Bytes(payloadEnvelopeBytes),
  });
  const feedPath = path.join(temp, `feed-${sequence}.json`);
  writeFileSync(
    feedPath,
    `${JSON.stringify(createSignedEnvelope(feedDocument, privatePem), null, 2)}\n`,
  );
  return { feedPath, zipPath };
}

function runUpdater(installRoot, publicKeyPath, update, timeoutSeconds) {
  return spawnSync(
    updater.executable,
    [
      '--root', installRoot,
      '--feed', update.feedPath,
      '--zip', update.zipPath,
      '--public-key', publicKeyPath,
      '--restart-exe', path.join(installRoot, 'MYAgent.exe'),
      '--health-timeout-seconds', String(timeoutSeconds),
    ],
    { cwd: installRoot, encoding: 'utf8', timeout: 45_000 },
  );
}

function stopFixture(installRoot) {
  const pidPath = path.join(installRoot, 'fixture.pid');
  if (!exists(pidPath)) return;
  const pid = Number(readFileSync(pidPath, 'utf8').trim());
  if (Number.isInteger(pid) && pid > 0) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
  }
  runningFixturePid = null;
  try {
    unlinkSync(pidPath);
  } catch {
    // Process cleanup is best effort.
  }
}

function exists(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

async function waitForFixture(installRoot, port, expectedVersion) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await response.json();
      if (body.version === expectedVersion) {
        const pidPath = path.join(installRoot, 'fixture.pid');
        if (exists(pidPath)) runningFixturePid = Number(readFileSync(pidPath, 'utf8').trim());
        return;
      }
    } catch {
      // Fixture is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`fixture health did not reach version ${expectedVersion}`);
}

try {
  const healthyFixture = buildFixture('healthy');
  const failingFixture = buildFixture('failing');
  const installRoot = path.join(temp, 'install');
  mkdirSync(installRoot, { recursive: true });
  copyDirectoryContents(healthyFixture, installRoot);
  const portServer = net.createServer();
  await new Promise((resolve, reject) => {
    portServer.once('error', reject);
    portServer.listen(0, '127.0.0.1', resolve);
  });
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  writeProductManifest(installRoot, 1, 'fixture-1', port);
  mkdirSync(path.join(installRoot, 'core', 'dist'), { recursive: true });
  writeFileSync(path.join(installRoot, 'core', 'dist', 'state.txt'), 'sequence-1\n');
  writeFileSync(path.join(installRoot, 'core', 'dist', 'obsolete.txt'), 'delete-on-success\n');
  mkdirSync(path.join(installRoot, 'data', 'sessions'), { recursive: true });
  mkdirSync(path.join(installRoot, 'data', 'vault'), { recursive: true });
  const sessionPath = path.join(installRoot, 'data', 'sessions', 'session.json');
  const vaultPath = path.join(installRoot, 'data', 'vault', 'license.ocx');
  writeFileSync(sessionPath, '{"messages":["keep me"]}\n');
  writeFileSync(vaultPath, 'fixture-license\n');
  const sessionHash = sha256(sessionPath);
  const vaultHash = sha256(vaultPath);

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPath = path.join(temp, 'update-public.pem');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));

  const update2 = createUpdate({
    sequence: 2,
    version: 'fixture-2',
    port,
    fixtureOutput: healthyFixture,
    privatePem,
    deleted: ['core/dist/obsolete.txt'],
    stateText: 'sequence-2',
  });
  const success = runUpdater(installRoot, publicKeyPath, update2, 10);
  assert.equal(success.status, 0, `${success.stdout ?? ''}${success.stderr ?? ''}`);
  await waitForFixture(installRoot, port, 'fixture-2');
  assert.equal(JSON.parse(readFileSync(path.join(installRoot, 'manifest.json'))).update_sequence, 2);
  assert.equal(readFileSync(path.join(installRoot, 'core', 'dist', 'state.txt'), 'utf8'), 'sequence-2\n');
  assert.equal(exists(path.join(installRoot, 'core', 'dist', 'obsolete.txt')), false);
  assert.equal(sha256(sessionPath), sessionHash);
  assert.equal(sha256(vaultPath), vaultHash);
  stopFixture(installRoot);

  const update3 = createUpdate({
    sequence: 3,
    version: 'fixture-3',
    port,
    fixtureOutput: failingFixture,
    privatePem,
    deleted: ['core/dist/keep.txt'],
    stateText: 'sequence-3',
  });
  const failed = runUpdater(installRoot, publicKeyPath, update3, 3);
  assert.notEqual(failed.status, 0, 'health failure must fail the update');
  assert.match(`${failed.stdout ?? ''}${failed.stderr ?? ''}`, /rolled back/i);
  await waitForFixture(installRoot, port, 'fixture-2');
  assert.equal(JSON.parse(readFileSync(path.join(installRoot, 'manifest.json'))).update_sequence, 2);
  assert.equal(readFileSync(path.join(installRoot, 'core', 'dist', 'state.txt'), 'utf8'), 'sequence-2\n');
  assert.equal(readFileSync(path.join(installRoot, 'core', 'dist', 'keep.txt'), 'utf8'), 'preserve-on-rollback\n');
  assert.equal(sha256(sessionPath), sessionHash);
  assert.equal(sha256(vaultPath), vaultHash);

  console.log('verify-update-acceptance: ok');
} finally {
  if (runningFixturePid) {
    spawnSync('taskkill', ['/PID', String(runningFixturePid), '/T', '/F'], { encoding: 'utf8' });
  }
  try {
    rmSync(temp, {
      recursive: true,
      force: true,
      maxRetries: 15,
      retryDelay: 200,
    });
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    console.warn(`verify-update-acceptance: deferred cleanup for ${temp}`);
  }
}
