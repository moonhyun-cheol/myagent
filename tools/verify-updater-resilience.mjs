import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const runner = await readFile('shell/CqrPa.Updater/UpdateRunner.cs', 'utf8');
const installer = await readFile('shell/CqrPa.Updater/TransactionalInstaller.cs', 'utf8');
const app = await readFile('shell/CqrPa.Updater/App.xaml.cs', 'utf8');

const preflight = runner.indexOf('TransactionalInstaller.Preflight(root, update);');
const stop = runner.indexOf('ProductProcessStop.StopAll(root, parentPid, Log);');
assert.ok(preflight >= 0 && preflight < stop, 'permission preflight must run before product shutdown');
assert.match(installer, /ProbeDirectoryMutation\(directory\)/, 'destination directories must be mutation-probed');
assert.match(installer, /FileShare\.ReadWrite \| FileShare\.Delete/, 'existing managed files must be readable for backup');
assert.match(installer, /ClearReadOnly\(destination\);/, 'read-only managed files must be normalized');
assert.match(runner, /if \(restartRequired\)[\s\S]*StartProduct\(restartExe, root\)/, 'previous app restart must be attempted after stop/apply failure');
assert.match(runner, /recoveryErrors\.Insert\(0, updateError\)/, 'rollback and restart failures must retain the original error');
assert.match(installer, /WriteState\("rollback_failed"\)/, 'incomplete rollback must be recorded');
assert.match(runner, /ContainsException<UnauthorizedAccessException>/, 'permission failures need actionable user guidance');
assert.match(app, /runner\.LastFailureDetail/, 'the updater window must display the actionable failure detail');
assert.match(runner, /Status callback failed/, 'UI status callback failures must not roll back a committed update');

console.log('updater resilience verification OK');
