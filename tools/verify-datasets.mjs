/**
 * verify-datasets — team datasets deployed by a signed Organization Feature.
 * Temp folders stand in for the team shared folder; an in-process ssh2 server on 127.0.0.1
 * stands in for the database host. Nothing leaves this machine.
 *
 * Covers: a pack with a secret field is refused, definitions keep their source kind
 * (unsupported kinds are listed, never read), shared-folder status branches (missing,
 * unreachable, 권한 없음, 갱신 지연), the fixed export (hash checked before anything is sent,
 * inline password refused, personal columns dropped, atomic snapshot, twice-daily due check),
 * dataset_query needs no approval and returns only filtered rows as a table with 기준 시각,
 * personal columns stay hidden on read, and no secret lands on disk.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ssh2 from 'ssh2';
import { needsHumanApproval } from '../core/dist/agent/tool-approval.js';
import { CODE_AGENT_TOOLS } from '../core/dist/agent/agent-tool-definitions.js';
import {
  FEATURE_JSON_SCHEMA,
  buildSignedFeaturePayloadFromDir,
  enableOrganizationFeature,
  installOrganizationFeatureFromZip,
} from '../core/dist/features/organization-feature-manager.js';
import {
  listDatasetDefinitions,
  loadDataConnectionSettings,
  saveDataConnectionSettings,
} from '../core/dist/datasets/dataset-catalog.js';
import {
  DATASET_SNAPSHOT_SCHEMA,
  loadDatasetStatus,
  queryDataset,
  runDatasetQueryTool,
} from '../core/dist/datasets/dataset-source.js';
import {
  dataConnectionOverview,
  datasetCommandSha256,
  datasetExportsPath,
  findInlineSecret,
  parseExportOutput,
  registerDatasetExport,
  runDatasetExport,
  runDueDatasetExports,
} from '../core/dist/datasets/dataset-export.js';
import { saveSshServers, sshServersPath, trustSshServer } from '../core/dist/ssh/ssh-profile-store.js';
import { closeSshConnections, unlockSshKey } from '../core/dist/ssh/ssh-service.js';

const { Server, utils } = ssh2;
const root = mkdtempSync(path.join(os.tmpdir(), 'my-agent-datasets-'));
const scratch = mkdtempSync(path.join(os.tmpdir(), 'my-agent-datasets-pack-'));
const share = mkdtempSync(path.join(os.tmpdir(), 'my-agent-datasets-share-'));
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
const fingerprint = `SHA256:${createHash('sha256').update(utils.parseKey(hostKey).getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
const PASSWORD = 'export fixture pw';
const EXPORT_COMMAND = 'mysql --defaults-extra-file=~/.my-agent-export.cnf -B -e "SELECT sale_date, style, color, units, buyer_email FROM sales"';
const TSV = [
  'sale_date\tstyle\tcolor\tunits\tbuyer_email',
  '2026-11-20\tTXP802\tBlack\t12\ta@example.com',
  '2026-11-21\tTXP802\tNavy\t7\tb@example.com',
  '2026-11-21\tTXS803\tBlack\t3\tc@example.com',
  '',
].join('\n');

const commands = [];
const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('error', () => {});
  client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'ops' && ctx.password === PASSWORD
    ? ctx.accept()
    : ctx.reject(['password'])));
  client.on('ready', () => {
    client.on('session', (accept) => {
      accept().on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec();
        commands.push(info.command);
        if (info.command === EXPORT_COMMAND) {
          stream.write(TSV);
          stream.exit(0);
        } else {
          stream.stderr.write('unexpected command\n');
          stream.exit(1);
        }
        stream.end();
      });
    });
  });
});

function zipDirectory(sourceDir, zipPath) {
  const zip = spawnSync('powershell', ['-NoProfile', '-Command', [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[IO.Compression.ZipFile]::CreateFromDirectory('${sourceDir.replace(/'/g, "''")}', '${zipPath.replace(/'/g, "''")}', [IO.Compression.CompressionLevel]::Optimal, $false, [Text.Encoding]::UTF8)`,
  ].join('; ')], { encoding: 'utf8' });
  if (zip.status !== 0 || !existsSync(zipPath)) throw new Error(zip.stderr?.toString() || 'zip failed');
}

function buildPack(name, sequence, datasets) {
  const stage = path.join(scratch, name);
  mkdirSync(stage, { recursive: true });
  writeFileSync(path.join(stage, 'feature.json'), `${JSON.stringify({
    schema: FEATURE_JSON_SCHEMA,
    id: 'org.example.datasets',
    version: `1.0.${sequence}`,
    update_sequence: sequence,
    label: '팀 데이터',
    capabilities: ['datasets'],
    entrypoints: { datasets: 'datasets.json' },
  }, null, 2)}\n`);
  writeFileSync(path.join(stage, 'datasets.json'), `${JSON.stringify({ version: 1, datasets }, null, 2)}\n`);
  const { envelopeJson } = buildSignedFeaturePayloadFromDir(stage, privatePem);
  writeFileSync(path.join(stage, 'update-payload.json'), envelopeJson);
  const zipPath = path.join(scratch, `${name}.zip`);
  zipDirectory(stage, zipPath);
  return zipPath;
}

const salesDefinition = (commandSha256) => ({
  id: 'sales',
  label: '판매 데이터',
  description: '스타일·컬러별 일 판매',
  source: { kind: 'shared_folder', folder: share },
  exclude_columns: ['buyer_email'],
  stale_after_hours: 30,
  export: { command_sha256: commandSha256, format: 'tsv', interval_hours: 12, server_id: 'ops-db' },
});

const errnoFs = (code) => ({
  stat: async () => { throw Object.assign(new Error(code), { code }); },
  readFile: async () => { throw Object.assign(new Error(code), { code }); },
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const hash = datasetCommandSha256(EXPORT_COMMAND);

  // 1. A dataset pack that names a credential is refused at install.
  const secretZip = buildPack('secret', 1, [{ ...salesDefinition(hash), source: { kind: 'shared_folder', folder: share, api_key: 'leak' } }]);
  assert.throws(() => installOrganizationFeatureFromZip(root, secretZip, { publicKeyPem: publicPem, enable: true }), (error) => error.code === 'FEATURE_SECRET_FIELD');
  assert.deepEqual(listDatasetDefinitions(root), []);

  // 2. Definitions keep their source kind; invalid folders are dropped.
  installOrganizationFeatureFromZip(root, buildPack('v1', 1, [
    salesDefinition(hash),
    { id: 'future', label: '클라우드 데이터', source: { kind: 'cloud_store', bucket: 'later' } },
    { id: 'bad', label: '상대 경로', source: { kind: 'shared_folder', folder: 'relative/folder' } },
  ]), { publicKeyPem: publicPem, enable: false });
  enableOrganizationFeature(root, 'org.example.datasets', { confirm: true });
  const definitions = listDatasetDefinitions(root);
  assert.deepEqual(definitions.map((d) => d.id), ['sales', 'future']);
  const sales = definitions[0];
  assert.equal(sales.source.kind, 'shared_folder');
  assert.equal((await loadDatasetStatus(definitions[1])).status, 'unsupported', 'unknown source kind is listed, never read');

  // 3. Status branches on the employee side.
  assert.equal((await loadDatasetStatus(sales)).status, 'missing');
  assert.equal((await loadDatasetStatus(sales, { fs: errnoFs('ENOENT') })).status, 'unreachable');
  assert.equal((await loadDatasetStatus(sales, { fs: errnoFs('EACCES') })).status, 'no_access');
  const denied = await queryDataset(root, { dataset_id: 'sales' }, { fs: errnoFs('EPERM') });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 'no_access');
  assert.equal(denied.status_label, '권한 없음');
  assert.equal(denied.table, undefined, 'no rows without read permission');
  const employee = await dataConnectionOverview(root);
  assert.equal(employee.operatorMode, false);
  assert.equal(employee.sshServerCount, 0, 'employee PC: SSH screen stays hidden');
  assert.equal(employee.datasets.find((d) => d.id === 'sales').statusLabel, '데이터 없음');

  // 4. Operator setting is local and holds nothing else.
  saveDataConnectionSettings(root, { operatorMode: true });
  assert.equal(loadDataConnectionSettings(root).operatorMode, true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'data', 'config', 'data-connection.json'), 'utf8')), { version: 1, operatorMode: true });

  // 5. Export registration refusals send nothing.
  assert.throws(() => registerDatasetExport(root, { datasetId: 'sales', serverId: 'ops-db', command: EXPORT_COMMAND }), (error) => error.code === 'EXPORT_SERVER_NOT_FOUND');
  saveSshServers(root, [{ id: 'ops-db', label: '운영 DB', host: '127.0.0.1', port, username: 'ops', auth: 'password' }]);
  trustSshServer(root, 'ops-db', fingerprint);
  assert.throws(() => registerDatasetExport(root, { datasetId: 'sales', serverId: 'ops-db', command: 'mysql -B -e "SELECT * FROM customers"' }), (error) => error.code === 'EXPORT_HASH_MISMATCH');
  assert.throws(() => registerDatasetExport(root, { datasetId: 'sales', serverId: 'ops-db', command: 'mysql -pS3cret -B -e "SELECT 1"' }), (error) => error.code === 'EXPORT_INLINE_SECRET');
  assert.throws(() => registerDatasetExport(root, { datasetId: 'sales', serverId: 'other', command: EXPORT_COMMAND }), (error) => error.code === 'EXPORT_SERVER_MISMATCH');
  assert.equal(commands.length, 0, 'refused registrations send nothing');
  for (const inline of ['x --password=abc', 'PGPASSWORD=abc psql -c "select 1"', 'sshpass -p a ssh b', 'Server=db;Uid=a;Pwd=abc;']) {
    assert.ok(findInlineSecret(inline), `inline secret detected: ${inline}`);
  }
  assert.equal(findInlineSecret(EXPORT_COMMAND), null);
  assert.equal(findInlineSecret('find . -name "*.csv" -print'), null);

  // 6. Fixed export: exact command only, personal columns dropped, atomic snapshot.
  registerDatasetExport(root, { datasetId: 'sales', serverId: 'ops-db', command: `${EXPORT_COMMAND}\r\n` });
  await unlockSshKey(root, 'ops-db', PASSWORD);
  const run = await runDatasetExport(root, 'sales');
  assert.equal(run.ok, true, run.message);
  assert.equal(run.rows, 3);
  assert.deepEqual(commands, [EXPORT_COMMAND], 'only the hash-matching command ran');
  const snapshotFile = path.join(share, 'sales.snapshot.json');
  const snapshotText = readFileSync(snapshotFile, 'utf8');
  const snapshot = JSON.parse(snapshotText);
  assert.equal(snapshot.schema, DATASET_SNAPSHOT_SCHEMA);
  assert.deepEqual(snapshot.columns, ['sale_date', 'style', 'color', 'units']);
  assert.doesNotMatch(snapshotText, /buyer_email|@example\.com/, 'personal column never reaches the shared folder');
  assert.deepEqual(readdirSync(share).sort(), ['sales.snapshot.json'], 'no temp file left behind');

  // 7. Due check: twice a day, not before.
  assert.deepEqual(await runDueDatasetExports(root, Date.now()), []);
  assert.deepEqual(await runDueDatasetExports(root, Date.now() + 13 * 3_600_000), ['sales']);
  assert.equal(commands.length, 2);

  // 8. Model query: id + filters only, table + 기준 시각, no approval card.
  assert.ok(CODE_AGENT_TOOLS.some((tool) => tool.function.name === 'dataset_query'));
  const approval = needsHumanApproval('dataset_query', { dataset_id: 'sales', filters: [{ column: 'style', op: 'eq', value: 'TXP802' }] }, {}, { workspaceRoot: root, cqrRoot: root });
  assert.equal(approval.needed, false, 'dataset_query never opens an approval card');
  const answer = await queryDataset(root, { dataset_id: 'sales', filters: [{ column: 'style', op: 'eq', value: 'txp802' }] });
  assert.equal(answer.ok, true);
  assert.equal(answer.status, 'ready');
  assert.equal(answer.matched_rows, 2);
  assert.match(answer.as_of, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.match(answer.table, /^\| sale_date \| style \| color \| units \|\n\| --- \| --- \| --- \| --- \|\n\| 2026-11-20 \| TXP802 \| Black \| 12 \|/);
  assert.doesNotMatch(answer.table, /TXS803/, 'only matched rows are returned');
  assert.equal((await queryDataset(root, { dataset_id: 'sales', filters: [{ column: 'units', op: 'gte', value: '7' }] })).matched_rows, 2);
  assert.equal((await queryDataset(root, { dataset_id: 'sales', filters: { color: 'Black' }, limit: 1 })).shown_rows, 1);
  const hidden = await queryDataset(root, { dataset_id: 'sales', filters: [{ column: 'buyer_email', op: 'contains', value: '@' }] });
  assert.equal(hidden.error, 'DATASET_COLUMN_UNKNOWN', 'personal column cannot be filtered either');
  const listing = await queryDataset(root, {});
  assert.deepEqual(listing.datasets.map((d) => [d.id, d.status]), [['sales', 'ready'], ['future', 'unsupported']]);
  assert.deepEqual(listing.datasets[0].columns, ['sale_date', 'style', 'color', 'units']);
  const tool = await runDatasetQueryTool(root, { dataset_id: 'sales', filters: [{ column: 'color', op: 'in', value: 'Navy,Black' }] });
  assert.equal(tool.label, 'dataset sales (3/3 rows)');
  assert.match(JSON.parse(tool.output).table, /Navy/);

  // 9. Personal columns stay hidden on read even in an older snapshot that still has them.
  writeFileSync(snapshotFile, JSON.stringify({ ...snapshot, columns: [...snapshot.columns, 'buyer_email'], rows: snapshot.rows.map((row) => [...row, 'old@example.com']) }));
  const older = await queryDataset(root, { dataset_id: 'sales' });
  assert.doesNotMatch(older.table, /buyer_email|old@example\.com/);
  writeFileSync(snapshotFile, snapshotText);

  // 10. 갱신 지연: past stale_after_hours the table still comes with a warning.
  const stale = await queryDataset(root, { dataset_id: 'sales' }, { now: Date.parse(snapshot.as_of) + 31 * 3_600_000 });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.status_label, '갱신 지연');
  assert.ok(stale.warning && stale.table);

  // 11. A new deployed hash stops the old command before anything is sent.
  installOrganizationFeatureFromZip(root, buildPack('v2', 2, [salesDefinition(datasetCommandSha256(`${EXPORT_COMMAND} WHERE 1=1`))]), { publicKeyPem: publicPem });
  const sentBefore = commands.length;
  const refused = await runDatasetExport(root, 'sales');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'EXPORT_HASH_MISMATCH');
  assert.equal(commands.length, sentBefore, 'mismatched command is never sent');
  const operator = await dataConnectionOverview(root);
  assert.equal(operator.sshServerCount, 1);
  assert.equal(operator.datasets[0].export.registration.commandMatches, false);
  assert.equal(operator.datasets[0].export.registration.lastRun.code, 'EXPORT_HASH_MISMATCH');

  // 12. CSV parsing keeps quoted commas and quotes.
  assert.deepEqual(parseExportOutput('a,b\r\n"x, y","he said ""hi"""\r\n', 'csv'), { columns: ['a', 'b'], rows: [['x, y', 'he said "hi"']] });

  // 13. No secret on disk: export registry, SSH profiles, settings view.
  const registry = readFileSync(datasetExportsPath(root), 'utf8');
  assert.match(registry, /defaults-extra-file/);
  assert.doesNotMatch(registry, /export fixture pw|"(?:password|passphrase|secret)"\s*:/i);
  assert.doesNotMatch(readFileSync(sshServersPath(root), 'utf8'), /export fixture pw/);
  assert.doesNotMatch(JSON.stringify(operator), /export fixture pw|defaults-extra-file/, 'settings view carries neither the password nor the command');

  console.log('PASS: datasets — secret pack refused, source kinds kept, missing/unreachable/권한 없음/갱신 지연 branches, hash-pinned export (inline password refused, mismatch never sent), personal columns dropped and hidden, dataset_query table + 기준 시각 without approval, no secret on disk');
} finally {
  closeSshConnections();
  await new Promise((resolve) => server.close(resolve));
  for (const dir of [root, scratch, share]) rmSync(dir, { recursive: true, force: true });
}
