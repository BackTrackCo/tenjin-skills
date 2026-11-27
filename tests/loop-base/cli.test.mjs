import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BASE_LIB, releasableSkill, tmpRoot } from './helpers/demo.mjs';

const root = tmpRoot();
const APP = path.join(path.dirname(new URL(import.meta.url).pathname), 'helpers', 'cli-app.mjs');
const skill = releasableSkill('alpha');
const run = (...args) => {
  const r = spawnSync(process.execPath, [APP, ...args], { env: { ...process.env, TENJIN_SKILLS_DIR: root, CLI_SKILL_DIR: skill }, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
};
const store = async () => {
  const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
  const { defineDemo } = await import('./helpers/demo.mjs');
  setApp(defineDemo(skill));
  return import(path.join(BASE_LIB, 'store.mjs'));
};

test('every command prints JSON; an unknown command prints the command list in the app\'s order, then the rest', () => {
  const r = run('hello', 'Pat');
  assert.deepEqual([r.code, r.json], [0, { hello: 'Pat' }]);
  const bad = run('nope');
  assert.equal(bad.code, 2);
  assert.equal(bad.json.error, 'unknown command: nope');
  assert.deepEqual(bad.json.commands, ['hello', 'rules', 'work', 'shown', 'lessons', 'gates', 'release', 'news', 'refused', 'boom']);
  const boom = run('boom');
  assert.deepEqual([boom.code, boom.json], [2, { error: 'it broke' }]);
});

test('an app command replaces a base one of the same name, and a pre-check can refuse a command with its text', () => {
  assert.deepEqual(run('rules').json, { own: true });
  const r = run('refused');
  assert.deepEqual([r.code, r.json], [2, { error: 'a pre-check said no' }]);
});

test('an old field in the state is refused with its name before any command runs', async () => {
  const s = await store();
  fs.mkdirSync(path.dirname(s.stateFile()), { recursive: true });
  fs.writeFileSync(s.stateFile(), JSON.stringify({ schemaVersion: 1, legacy: 1 }));
  const r = run('hello');
  assert.equal(r.code, 2);
  assert.match(r.json.error, /^state\.json has an old field the skill no longer reads: legacy \(it is gone\)/);
  fs.rmSync(s.stateFile());
});

test('a batch that is open refuses the app\'s denied commands, and an expired one does not', async () => {
  const s = await store();
  const batch = await import(path.join(BASE_LIB, 'batch.mjs'));
  const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
  s.updateState((st) => { st.batch = { mode: 'attended', openedAt: new Date().toISOString(), touchedAt: new Date().toISOString() }; });
  const denied = run('rules', 'add');
  assert.equal(denied.code, 4);
  assert.match(denied.json.error, /^rules add is refused while a batch is open/);
  assert.equal(run('hello').code, 0, 'a command off the list runs');
  s.updateState((st) => { st.batch = { mode: 'attended', openedAt: '2026-01-01T00:00:00Z', touchedAt: '2026-01-01T00:00:00Z' }; });
  assert.notEqual(run('rules', 'add').code, 4, 'two hours with no activity: the batch counts as closed');
  s.updateState((st) => { st.batch = null; });
  void batch; void setApp;
});

test('after a start, a stopped watcher is named in every reply', async () => {
  const s = await store();
  assert.equal(run('hello').json.watcher, undefined);
  s.updateState((st) => { st.watcherEver = true; });
  assert.equal(run('hello').json.watcher, 'stopped');
  s.updateState((st) => { st.watcherEver = false; });
});

test('the shared commands: rules add and list with the app\'s vocabulary, lessons derive, shown, gates --write and release errors', async () => {
  const s = await store();
  // `rules` is replaced in this app, so the shared ones are exercised through the table itself
  const cli = await import(path.join(BASE_LIB, 'cli.mjs'));
  const { setApp, defineApp } = await import(path.join(BASE_LIB, 'app.mjs'));
  const { defineDemo } = await import('./helpers/demo.mjs');
  const { demoState } = await import('./helpers/demo.mjs');
  const st = demoState();
  const empty = st.empty;
  st.empty = () => ({ ...empty(), update: { waiting: null }, held: [], updateLines: [] });
  setApp(defineDemo(skill, { state: st, rules: { effects: () => ['exclude_company', 'daily_max'], lessonEffects: () => [], lessonDays: () => [1], lessonTemplates: {}, exempt: [], hashParts: () => ({}) }, release: { repo: 'Org/skills', displayName: 'Alpha', skillsCli: 'skills@1.9.0', companions: [] }, work: { waitingSetRaw: () => ({}), notifyParts: () => [], clockFields: [] }, cli: { deriveLessons: () => ['derived'], commands: { watch: 'A watch' } } }));
  const captured = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (t) => { captured.push(t); return true; };
  const say = async (fn, ...a) => { captured.length = 0; await fn(...a); return JSON.parse(captured.join('')); };
  try {
    const shared = cli.sharedCommands();
    const added = await say(shared.rules, ['add'], { effect: 'daily_max', value: '5', words: 'five a day' });
    assert.deepEqual([added.effect, added.value, added.words], ['daily_max', 5, 'five a day']);
    assert.equal((await say(shared.rules, [], {})).length, 1);
    await assert.rejects(shared.rules(['add'], { effect: 'nope', words: 'x' }), /not in the vocabulary/);
    assert.deepEqual(await say(shared.rules, ['add'], { 'from-choice': true }), { error: 'rules add --from-choice "<the option label the person chose>"' });
    assert.deepEqual(await say(shared.rules, ['remove', added.id], {}), { removed: 1 });
    assert.deepEqual(await say(shared.lessons, ['derive'], {}), ['derived']);
    assert.deepEqual(await say(shared.lessons, [], {}), []);
    assert.equal(typeof (await say(shared.shown, [], {})).shown, 'number');
    const before = JSON.parse(fs.readFileSync(path.join(skill, 'manifest.json'), 'utf8'));
    const g = await say(shared.gates, [], {});
    assert.match(g.gatesHash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(skill, 'manifest.json'), 'utf8')).gatesHash, before.gatesHash, 'no write without the flag');
    await say(shared.gates, [], { write: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(skill, 'manifest.json'), 'utf8')).gatesHash, g.gatesHash);
    assert.deepEqual(await say(shared.release, ['apply'], {}), { error: 'no update waits' });
    assert.deepEqual(await say(shared.release, [], {}), { error: 'release check | apply (after the person says yes)' });
  } finally { process.stdout.write = realWrite; process.exitCode = 0; }
  void s; void defineApp;
});

test('work hands out the app\'s list after its own first step, and says to start the watcher last', () => {
  const r = run('work', '--commit');
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { items: [{ key: 'k', reason: 'r' }], notify: null, commit: true, then: 'start A watch last, with run_in_background, after every item is handed out or done' });
  assert.match(r.stderr, /before work/);
  assert.equal(run('work').json.then, undefined);
});
