import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BASE_LIB, FIXTURES, demoApp, tmpRoot } from './helpers/demo.mjs';

const root = tmpRoot();
const appMod = await import(path.join(BASE_LIB, 'app.mjs'));
const paths = await import(path.join(BASE_LIB, 'paths.mjs'));
const graphMod = await import(path.join(BASE_LIB, 'graph.mjs'));

test('a base module used before setApp fails with a clear error', () => {
  for (const f of [() => paths.stateDir(), () => paths.skillDir(), () => graphMod.graph(), () => graphMod.manifest(), () => appMod.envName('TICK_MS'), () => appMod.getApp()]) {
    assert.throws(f, /no app is registered.*setApp\(defineApp/);
  }
});

test('defineApp reads the app\'s identity from its manifest and refuses a bad object', async () => {
  const alpha = await demoApp('alpha');
  assert.deepEqual([alpha.name, alpha.envPrefix, alpha.skillDir], ['alpha', 'ALPHA', path.join(FIXTURES, 'alpha')]);
  assert.throws(() => appMod.defineApp(), /takes an object/);
  assert.throws(() => appMod.defineApp({ skillDir: 'relative/dir' }), /absolute path/);
  assert.throws(() => appMod.defineApp({ skillDir: path.join(FIXTURES, 'missing') }), /manifest\.json cannot be read/);
  assert.throws(() => appMod.defineApp({ skillDir: path.join(FIXTURES, 'alpha'), name: 'beta' }), /differs from its manifest/);
  assert.throws(() => appMod.setApp({ name: 'x' }), /takes the object defineApp returned/);
  assert.ok(Object.isFrozen(alpha));
  const bad = fs.mkdtempSync(path.join(root, 'bad-'));
  fs.writeFileSync(path.join(bad, 'manifest.json'), JSON.stringify({ name: 'Bad Name' }));
  assert.throws(() => appMod.defineApp({ skillDir: bad }), /needs a name/);
  const dash = fs.mkdtempSync(path.join(root, 'dash-'));
  fs.writeFileSync(path.join(dash, 'manifest.json'), JSON.stringify({ name: 'job-search' }));
  assert.equal(appMod.defineApp({ skillDir: dash }).envPrefix, 'JOB_SEARCH');
});

test('two apps keep their data in two folders, and neither reads or writes the other\'s', async () => {
  const alpha = appMod.setApp(await demoApp('alpha'));
  assert.equal(paths.stateDir(), path.join(root, 'alpha'));
  assert.equal(appMod.envName('TICK_MS'), 'ALPHA_TICK_MS');
  paths.writeJsonAtomic(path.join(paths.stateDir(), 'state.json'), { who: 'alpha' });
  assert.deepEqual(graphMod.graph().terminal, ['done']);
  assert.equal(graphMod.manifest().name, 'alpha');

  appMod.setApp(await demoApp('outreach'));
  assert.equal(paths.stateDir(), path.join(root, 'outreach'));
  assert.equal(paths.readJson(path.join(paths.stateDir(), 'state.json'), null), null, 'outreach cannot see alpha\'s state');
  paths.writeJsonAtomic(path.join(paths.stateDir(), 'state.json'), { who: 'outreach' });
  assert.deepEqual(graphMod.graph().terminal, ['replied', 'closed']);
  assert.equal(appMod.envName('OPEN_BIN'), 'OUTREACH_OPEN_BIN');

  appMod.setApp(alpha);
  assert.deepEqual(paths.readJson(path.join(paths.stateDir(), 'state.json'), null), { who: 'alpha' });
  assert.deepEqual(fs.readdirSync(root).filter((d) => ['alpha', 'outreach'].includes(d)).sort(), ['alpha', 'outreach']);
  assert.equal(paths.writingRulesPath(), path.join(root, 'writing', 'rules.md'), 'the writing rules are the one shared file');
});

test('writes are atomic: no temporary file is left, and the file mode is private', async () => {
  appMod.setApp(await demoApp('alpha'));
  const file = path.join(paths.stateDir(), 'atomic.json');
  for (let i = 0; i < 20; i++) paths.writeJsonAtomic(file, { i });
  assert.deepEqual(paths.readJson(file, null), { i: 19 });
  assert.deepEqual(fs.readdirSync(paths.stateDir()).filter((f) => f.endsWith('.tmp')), []);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
