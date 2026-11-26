import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BASE_LIB, demoApp, tmpRoot } from './helpers/demo.mjs';

const root = tmpRoot();
const { setApp, defineApp } = await import(path.join(BASE_LIB, 'app.mjs'));
const store = await import(path.join(BASE_LIB, 'store.mjs'));
const paths = await import(path.join(BASE_LIB, 'paths.mjs'));
const WRITER = path.join(path.dirname(new URL(import.meta.url).pathname), 'helpers', 'writer.mjs');

test('a base store used with an app that declared no state shape fails with a clear error', async () => {
  setApp(defineApp({ skillDir: path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'alpha') }));
  assert.throws(() => store.loadState(), /has not declared its state shape/);
});

test('writes are atomic: no temp or lock file lingers, the file is valid JSON, mode 0600', async () => {
  setApp(await demoApp('alpha'));
  store.updateState((s) => { s.n = 1; });
  const dir = paths.stateDir();
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock')), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).n, 1);
  assert.equal(fs.statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600);
});

test('an unknown op is refused and a batch with one lands nothing', async () => {
  setApp(await demoApp('alpha'));
  assert.throws(() => store.applyOps([{ op: 'count', key: 'x' }, { op: 'delete_everything' }]), /unknown op: delete_everything/);
  assert.equal(store.loadState().counts.x, undefined);
  store.applyOps([{ op: 'count', key: 'x' }, { op: 'count', key: 'x' }]);
  assert.equal(store.loadState().counts.x, 2);
});

test('an old field is refused with its name', async () => {
  setApp(await demoApp('outreach'));
  assert.deepEqual(store.readOldStateFields(), []);
  const file = store.stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, legacy: 1 }));
  const list = store.readOldStateFields();
  assert.deepEqual(list, [{ field: 'legacy', why: 'it is gone' }]);
  assert.match(store.oldStateError(list), /^state\.json has an old field the skill no longer reads: legacy \(it is gone\)\. Remove it from state\.json, then run the command again\.$/);
});

test('a newer schema is refused by older code', async () => {
  setApp(await demoApp('alpha'));
  fs.writeFileSync(store.stateFile(), JSON.stringify({ schemaVersion: 99 }));
  assert.throws(() => store.loadState(), /schema 99, newer than this code \(1\)/);
  fs.writeFileSync(store.stateFile(), JSON.stringify({ schemaVersion: 1, n: 5 }));
  assert.equal(store.loadState().n, 5);
  assert.deepEqual(store.loadState().counts, {}, 'missing fields come from the empty state');
});

test('two processes writing 100 ops each land all 200', async () => {
  const app = await demoApp('alpha');
  setApp(app);
  fs.rmSync(store.stateFile(), { force: true });
  const run = () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [WRITER, 'alpha', '100'], { env: { ...process.env, TENJIN_SKILLS_DIR: root }, stdio: 'inherit' });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
  });
  await Promise.all([run(), run()]);
  assert.equal(store.loadState().counts.w, 200);
});

test('a stale lock whose pid is gone is reclaimed, and a live one times out', async () => {
  setApp(await demoApp('alpha'));
  const lock = path.join(paths.stateDir(), 'state.lock');
  fs.writeFileSync(lock, '2147483646');
  store.updateState((s) => { s.n = 7; });
  assert.equal(store.loadState().n, 7);
  fs.writeFileSync(lock, String(process.pid));
  assert.throws(() => store.withLock(() => 1, { timeoutMs: 60 }), /state lock timeout/);
  fs.unlinkSync(lock);
});
