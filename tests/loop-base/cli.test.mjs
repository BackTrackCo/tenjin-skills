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
  assert.deepEqual(bad.json.commands, ['hello', 'rules', 'work', 'shown', 'lessons', 'gates', 'release', 'tenjin', 'batch', 'ops', 'arm', 'consent', 'report', 'rc', 'chrome', 'notify', 'watch', 'news', 'refused', 'boom']);
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

// ---- the rest of the shared table: tenjin, batch, ops, arm, consent, report, rc, chrome, notify and watch, with the app's text in hooks ----
async function hooked() {
  const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
  const { defineDemo, demoState } = await import('./helpers/demo.mjs');
  const st = demoState();
  const empty = st.empty;
  st.empty = () => ({ ...empty(), update: { waiting: null }, held: [], updateLines: [], consentLog: [], shown: {}, consent: { unattended: null, writing: null, email: null, dryRun: { records: [] } } });
  const calls = [];
  setApp(defineDemo(skill, {
    state: st,
    rules: { effects: () => ['exclude_company'], lessonEffects: () => [], lessonDays: () => [1], lessonTemplates: {}, exempt: [], hashParts: () => ({}) },
    consents: { kinds: ['unattended', 'writing', 'email'], writingScope: 's', problems: () => [], limitsOf: () => ({}), loosened: () => false },
    batch: { denied: [], unattendedDenied: [] },
    work: { waitingSetRaw: () => ({}), notifyParts: () => [], clockFields: [], list: () => ({ items: [], notify: null }), roundMark: () => 'm' },
    report: { sections: ({ now }) => [[`# Alpha report, ${new Date(now).toISOString().slice(0, 10)}`, '', 'body'], { shared: 'updates' }] },
    cli: {
      word: 'A', commands: { work: 'A work', watch: 'A watch' }, readProfile: () => ({ p: 1 }),
      setupPeriod: () => 'period-1',
      batchOpen: (f) => (f.upload === 'bad' ? { error: 'the upload must be the named file' } : { uploadPath: f.upload ? '/named' : null }),
      batchNext: 'run A apply',
      beforeOps: (ops) => calls.push(['before', ops.length]),
      opsGuard: (ops) => (ops.some((o) => o.op === 'approve') ? 'ops approve is refused' : null),
      afterOps: (ops) => calls.push(['after', ops.length]),
      armView: (s) => ({ lease: s.lease ? s.lease.holder : null }),
      consentUsage: 'consent record unattended|writing|email | revoke ...',
      consentRecord: { unattended: (s, f) => { s.consentLog.push({ at: 'x', what: `unattended ${f['optional-writing']}` }); return { kind: 'unattended' }; }, email: () => ({ kind: 'email' }) },
      onFullReport: (s) => { s.fullDone = true; },
      markReported: (s, o) => { s.reportedAll = o.all; },
      reportFooter: () => '\nfooter line\n',
      rcReminder: (s, v) => `reminder ${v}`,
      rcAtPush: (reason) => `say ${reason}`,
      chromeSet: (s, v) => ({ cleared: v === 'on' ? 2 : 0, ...(v === 'off' ? { steps: ['a'] } : {}) }),
      watchSub: async (sub, name) => { calls.push(['watch', sub, name]); },
    },
  }));
  return calls;
}
async function say(fn, ...a) {
  const out = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (t) => { out.push(t); return true; };
  try { await fn(...a); } finally { process.stdout.write = real; process.exitCode = 0; }
  const text = out.join('');
  try { return JSON.parse(text); } catch { return text; }
}

test('tenjin, batch, ops and arm run the app\'s text and checks through hooks', async () => {
  const calls = await hooked();
  const cli = await import(path.join(BASE_LIB, 'cli.mjs'));
  const { loadState, updateState } = await import(path.join(BASE_LIB, 'store.mjs'));
  const t = cli.sharedCommands();
  updateState((s) => { s.batch = null; });
  assert.deepEqual(await say(t.tenjin, ['ask-done', 'yes'], {}), { asked: true, answer: 'yes' });
  assert.equal(loadState().tenjinSetup.period, 'period-1');
  assert.ok(loadState().held.some((h) => h.reason === 'tenjin_setup'));
  assert.equal((await say(t.tenjin, ['ask-done', 'no'], {})).answer, 'no');
  assert.ok(loadState().tenjin.declinedAt);
  assert.deepEqual(await say(t.batch, ['open'], { upload: 'bad' }), { error: 'the upload must be the named file' });
  assert.deepEqual(await say(t.batch, ['open'], { upload: 'x', unattended: true }), { mode: 'unattended', next: 'run A apply' });
  assert.equal(loadState().batch.uploadPath, '/named');
  assert.deepEqual(await say(t.batch, ['close'], {}), { closed: true });
  assert.equal((await say(t.batch, ['nope'], {})).error, 'batch open [--unattended] [--upload path] | close');
  assert.deepEqual(await say(t.ops, ['[{"op":"count","key":"a"}]'], {}), { applied: 1 });
  assert.deepEqual(calls.filter((c) => c[0] !== 'watch'), [['before', 1], ['after', 1]]);
  assert.equal((await say(t.ops, ['[{"op":"approve"}]'], {})).error, 'ops approve is refused');
  assert.equal(loadState().counts.a, 1, 'a refused batch lands nothing');
  const armed = await say(t.arm, [], {});
  assert.equal(armed.armed, true);
  assert.match(armed.watch, /^start A watch with the Bash tool, run_in_background true; start it again after each round and whenever a A command reports watcher: stopped$/);
  assert.deepEqual(armed.view, { lease: null });
  const lease = await import(path.join(BASE_LIB, 'lease.mjs'));
  lease.claimLease({ holder: 'w', pid: process.pid, now: Date.now() });
  const again = await say(t.arm, [], {});
  assert.deepEqual([again.armed, again.running, again.heldBy], [false, true, 'w']);
  lease.releaseLease('w');
  updateState((st) => { st.watcherEver = false; });
});

test('consent, report, rc, chrome, notify and watch: the base does the work and the app gives its words', async () => {
  const calls = await hooked();
  const cli = await import(path.join(BASE_LIB, 'cli.mjs'));
  const { loadState, updateState } = await import(path.join(BASE_LIB, 'store.mjs'));
  const t = cli.sharedCommands();
  assert.deepEqual(await say(t.consent, ['record', 'unattended'], { 'optional-writing': 'skip' }), { kind: 'unattended' });
  assert.equal((await say(t.consent, ['record', 'writing'], {})).error, 'consent record unattended|writing|email | revoke ...', 'a kind with no record hook shows the usage');
  assert.equal((await say(t.consent, ['record', 'nope'], {})).error, 'consent record unattended|writing|email | revoke ...');
  updateState((s) => { s.consent.email = { x: 1 }; });
  assert.deepEqual(await say(t.consent, ['revoke', 'email'], {}), { revoked: 'email' });
  assert.equal(loadState().consent.email, null);
  assert.ok(loadState().consentLog.some((c) => c.what === 'email consent revoked'));
  // report: saved to the reports folder, consent changes acknowledged, update lines cleared by the full report only
  updateState((s) => { s.updateLines = ['u']; s.shown = { 'update:abc': 'x', 'sig:1': 'y' }; });
  const short = await say(t.report, [], {});
  assert.match(short, /# Alpha report, \d{4}-\d{2}-\d{2}\n\nbody\n\n## Updates\n- u\n\nfooter line\n$/);
  assert.equal(loadState().reportedAll, false);
  assert.deepEqual(loadState().updateLines, ['u'], 'the short report keeps the update lines');
  assert.equal(loadState().fullDone, undefined);
  assert.ok(loadState().consentLog.every((c) => c.acked));
  await say(t.report, [], { all: true });
  assert.deepEqual(loadState().updateLines, []);
  assert.equal(loadState().fullDone, true);
  assert.equal(loadState().reportedAll, true);
  const { stateDir } = await import(path.join(BASE_LIB, 'paths.mjs'));
  assert.ok(fs.readdirSync(path.join(stateDir(), 'reports')).length >= 1);
  // rc, chrome, notify
  assert.deepEqual(await say(t.rc, ['set', 'on'], {}), { rc: 'on', reminder: 'reminder on' });
  assert.equal((await say(t.rc, ['set', 'maybe'], {})).error, 'rc set on|unknown');
  assert.deepEqual(await say(t.chrome, ['set', 'on'], {}), { chrome: 'on', cleared: 2 });
  assert.deepEqual(await say(t.chrome, ['set', 'off'], {}), { chrome: 'off', cleared: 0, steps: ['a'] });
  assert.equal((await say(t.chrome, ['set', 'x'], {})).error, 'chrome set on|off');
  assert.deepEqual(await say(t.notify, ['result', 'not_sent'], { reason: 'off' }), { recorded: 'not_sent', reason: 'off', say: 'say off' });
  assert.equal((await say(t.notify, ['result', 'not_sent'], { reason: 'off' })).say, null, 'once');
  assert.deepEqual(await say(t.notify, ['result', 'sent'], {}), { recorded: 'sent', say: null });
  assert.equal(loadState().pushSent, true);
  assert.equal((await say(t.notify, ['result', 'sent'], { reason: 'off' })).error, '--reason off|present|none goes with not_sent');
  assert.equal((await say(t.notify, ['later'], {})).error, 'notify result sent|not_sent|unknown [--reason off|present|none]');
  // watch: a sub-command goes to the app's hook
  await t.watch(['list', 'x'], {});
  assert.deepEqual(calls.filter((c) => c[0] === 'watch'), [['watch', 'list', 'x']]);
});
