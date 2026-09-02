import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UserSkillError, UserSkillStore } from '../core/dist/skills/user-skill-store.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const skillsUi = readFileSync(path.join(projectRoot, 'ui/workspace/src/components/SettingsSkillsPage.tsx'), 'utf8');
const shell = readFileSync(path.join(projectRoot, 'shell/CqrPa.Shell/MainWindow.xaml.cs'), 'utf8');
assert.match(skillsUi, /type:\s*'filePicker\.open'/);
assert.match(skillsUi, /data-testid="skill-zip-browse-button"/);
assert.match(skillsUi, /filePicker\.result/);
assert.match(skillsUi, /data-testid={`installed-skill-\$\{skill.id\}`}/);
assert.match(skillsUi, /existingId/);
assert.match(skillsUi, /scrollIntoView/);
assert.match(shell, /case "filePicker\.open"/);
assert.match(shell, /OpenFileDialog/);
assert.match(shell, /PostWebMessageAsJson\(payload\)/);

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const content = Buffer.from(text, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

const root = mkdtempSync(path.join(tmpdir(), 'cqr-pa-skill-package-'));
try {
  const zipPath = path.join(root, 'rulebook.zip');
  writeFileSync(zipPath, storedZip([
    ['rulebook/SKILL.md', '---\nname: rulebook\ndescription: Reproduction contract manager.\n---\n\n# Rulebook\nRead references/schema.md when needed.\n'],
    ['rulebook/references/schema.md', '# Schema\n'],
    ['rulebook/agents/openai.yaml', 'interface:\n  display_name: Rulebook Manager\n'],
  ]));

  const store = new UserSkillStore(path.join(root, 'data', 'skills'), root);
  const installed = store.installPackage(zipPath, (id) => id === 'bundled-only');
  assert.equal(installed.id, 'rulebook');
  assert.equal(installed.label, 'Rulebook Manager');
  assert.equal(installed.install_kind, 'package');
  assert.equal(installed.file_count, 3);
  assert.match(store.readPrompt('rulebook') ?? '', /# Rulebook/);
  const installedRoot = path.join(root, 'data', 'skills', 'packages', 'rulebook');
  assert.equal(readFileSync(path.join(installedRoot, 'references', 'schema.md'), 'utf8'), '# Schema\n');
  assert.equal(readdirSync(installedRoot, { recursive: true }).some((entry) => String(entry).toLowerCase().endsWith('.zip')), false);
  assert.equal(existsSync(zipPath), true, '사용자가 제공한 원본 ZIP은 삭제하지 않는다');

  try {
    store.installPackage(zipPath, (id) => id === 'bundled-only');
    assert.fail('duplicate install should throw');
  } catch (error) {
    if (!(error instanceof UserSkillError)) throw error;
    assert.equal(error.code, 'DUPLICATE_ID');
    assert.match(error.message, /Rulebook Manager \(rulebook\)/);
    assert.deepEqual(error.existing, { id: 'rulebook', label: 'Rulebook Manager' });
  }

  const indexPath = path.join(root, 'data', 'skills', 'index.json');
  writeFileSync(indexPath, `${JSON.stringify({ version: 1, skills: [] }, null, 2)}\n`);
  const recovered = store.list().find((skill) => skill.id === 'rulebook');
  assert.ok(recovered, 'index에서 빠져도 packages 폴더가 있으면 목록에 복구한다');
  assert.equal(recovered.label, 'Rulebook Manager');
  assert.equal(recovered.install_kind, 'package');

  writeFileSync(indexPath, `${JSON.stringify({ version: 1, skills: [{ id: 'broken' }] }, null, 2)}\n`);
  assert.doesNotThrow(() => store.list());

  assert.equal(store.delete('rulebook'), true);
  assert.equal(store.readPrompt('rulebook'), null);

  const unsafeZip = path.join(root, 'unsafe.zip');
  writeFileSync(unsafeZip, storedZip([
    ['SKILL.md', '---\nname: unsafe\ndescription: unsafe test\n---\n'],
    ['../outside.txt', 'blocked'],
  ]));
  assert.throws(
    () => store.installPackage(unsafeZip),
    (error) => error instanceof UserSkillError && error.code === 'SKILL_ZIP_PATH',
  );

  console.log('verify-skill-packages: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
