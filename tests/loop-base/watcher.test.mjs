import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BASE_LIB, defineDemo, releasableSkill, tmpRoot } from './helpers/demo.mjs';

tmpRoot();
const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
const w = await import(path.join(BASE_LIB, 'watcher.mjs'));
const lease = await import(path.join(BASE_LIB, 'lease.mjs'));
const store = await import(path.join(BASE_LIB, 'store.mjs'));
const work = await import(path.join(BASE_LIB, 'work.mjs'));
const NOW = Date.parse('2026-11-26T12:00:00Z');
const rulesDecl = { effects: () => ['notify_off', 'notify_quiet_hours'], lessonEffects: () => [], lessonDays: () => [1], lessonTemplates: {}, exempt: [] };

// An app whose watcher steps record what ran, and whose due items are whatever the test puts in `queue`.
async function setup({ steps, queue = [], notify = null, codeFiles = ['scripts/gate.mjs'] } = {}) {
  const dir = releasableSkill('alpha');
  const ran = [];
  const q = { items: queue, notify };
  const mk = (name, extra = {}) => ({ name, run: () => { ran.push(name); }, ...extra });
  const app = defineDemo(dir, {
    rules: rulesDecl,
    steps: (steps || [mk('first'), mk('second'), mk('third')]).map((s) => (typeof s === 'function' ? s(ran) : s)),
    watcher: {
      codeFiles, readProfile: () => ({ p: 1 }), blocking: /^(park|held):/, rearm: 'run it again to re-arm', commands: { work: 'A work', watch: 'A watch' },
      wakeLine: ({ counts, notify: n, newNotify }) => `Alpha round: ${Object.entries(counts).map(([k, c]) => `${c} ${k}`).join(', ') || 'waiting on you'}${newNotify ? `; notify: ${n}` : ''}`,
    },
    work: { waitingSetRaw: () => ({}), notifyParts: () => [], clockFields: [], list: () => ({ items: q.items, notify: q.notify }), roundMark: () => 'mark' },
  });
  setApp(app);
  store.updateState((s) => { for (const k of Object.keys(s)) if (!['schemaVersion', 'counts', 'lease', 'items', 'n'].includes(k)) delete s[k]; s.lease = null; s.claims = {}; });
  return { dir, ran, q, app };
}
const item = (key, reason, over = {}) => ({ key, reason, v: '1', waitsForPerson: false, ...over });
const tickCtx = (over = {}) => ({ holder: 'h', now: NOW, ...over });

test('an app that declared no watcher fails with a clear error', async () => {
  const { setApp: set, defineApp } = await import(path.join(BASE_LIB, 'app.mjs'));
  set(defineApp({ skillDir: releasableSkill('alpha') }));
  await assert.rejects(w.tick({ holder: 'h' }), /has not declared its watcher steps/);
});

test('the steps run in declared order every tick, skipping a step that is not due, and the lease heartbeat comes first', async () => {
  const { ran } = await setup({ steps: [(r) => ({ name: 'a', run: () => r.push('a') }), (r) => ({ name: 'b', due: () => false, run: () => r.push('b') }), (r) => ({ name: 'c', due: (c) => c.profile.p === 1, run: () => r.push('c') })] });
  assert.deepEqual((await w.tick(tickCtx())), { lines: ['lease lost: run it again to re-arm'], stop: true }, 'no lease: the tick ends before any step');
  assert.deepEqual(ran, []);
  lease.claimLease({ holder: 'h', pid: process.pid, now: NOW });
  assert.deepEqual(await w.tick(tickCtx()), { lines: [], stop: false });
  assert.deepEqual(ran, ['a', 'c']);
});

test('a throwing step with catch true goes to its onError and the tick goes on; with catch false the error ends the tick', async () => {
  const errors = [];
  const { ran } = await setup({ steps: [
    (r) => ({ name: 'a', run: () => r.push('a') }),
    (r) => ({ name: 'boom', catch: true, run: () => { throw new Error('read failed'); }, onError: (e, c) => errors.push([e.message, c.now]) }),
    (r) => ({ name: 'c', run: () => r.push('c') }),
  ] });
  lease.claimLease({ holder: 'h', pid: process.pid, now: NOW });
  await w.tick(tickCtx());
  assert.deepEqual(ran, ['a', 'c']);
  assert.deepEqual(errors, [['read failed', NOW]]);
  const hard = await setup({ steps: [(r) => ({ name: 'a', run: () => r.push('a') }), { name: 'hard', catch: false, run: () => { throw new Error('stop here'); } }, (r) => ({ name: 'c', run: () => r.push('c') })] });
  lease.claimLease({ holder: 'h', pid: process.pid, now: NOW });
  await assert.rejects(w.tick(tickCtx()), /stop here/);
  assert.deepEqual(hard.ran, ['a'], 'the later step did not run');
});

test('a quiet state prints nothing; due work prints the app\'s wake line once, and the same work does not wake again', async () => {
  const { q } = await setup();
  lease.claimLease({ holder: 'h', pid: process.pid, now: NOW });
  assert.deepEqual((await w.tick(tickCtx())).lines, []);
  q.items = [item('k1', 'new_item'), item('k2', 'new_item'), item('k3', 'ask', { waitsForPerson: true })];
  const r = await w.tick(tickCtx());
  assert.deepEqual(r.lines, ['Alpha round: 2 new_item']);
  assert.deepEqual((await w.tick(tickCtx())).lines, [], 'the fingerprint of what was sent is kept');
  assert.deepEqual(store.loadState().watcher.sent, ['k1:new_item:1', 'k2:new_item:1']);
  q.items = [item('k1', 'new_item', { v: '2' }), item('k2', 'new_item')];
  assert.deepEqual((await w.tick(tickCtx())).lines, ['Alpha round: 1 new_item'], 'a changed version wakes once');
  assert.equal(store.loadState().wakes.length, 2, 'each wake is logged');
});

test('claimed work does not wake, and a step that is still reading holds the wake until the round ends', async () => {
  let pending = true;
  const { q } = await setup({ steps: [{ name: 'read', run: () => ({ pending }) }], queue: [item('k1', 'new_item')] });
  lease.claimLease({ holder: 'h', pid: process.pid, now: NOW });
  assert.deepEqual((await w.tick(tickCtx())).lines, [], 'the round is open');
  pending = false;
  store.updateState((s) => work.claimItems(s, q.items, NOW));
  assert.deepEqual((await w.tick(tickCtx())).lines, [], 'handed out: in flight');
  assert.deepEqual((await w.tick(tickCtx({ now: NOW + 21 * 60000 }))).lines, ['Alpha round: 1 new_item'], 'the claim timed out on a still-open item: one more wake');
});

test('a code change restarts the watcher, a lease held elsewhere refuses a start, and unclaimed due work refuses it with its names', async () => {
  const { dir, q } = await setup();
  lease.claimLease({ holder: 'h', pid: process.pid, now: NOW });
  const startHash = w.codeHash();
  assert.deepEqual((await w.tick(tickCtx({ startHash }))).stop, false);
  fs.appendFileSync(path.join(dir, 'scripts', 'gate.mjs'), '// changed\n');
  assert.deepEqual(await w.tick(tickCtx({ startHash })), { lines: ['restart: the watcher code changed, start A watch again'], stop: true });
  const out = [];
  lease.claimLease({ holder: 'other', pid: process.pid, now: Date.now() });
  assert.deepEqual(await w.runWatcher({ holder: 'mine', write: (l) => out.push(l), maxTicks: 1 }), { exit: 0, reason: 'lease_held' });
  assert.deepEqual(out, ['another session holds the lease; work attended']);
  lease.releaseLease('other');
  q.items = [item('k1', 'new_item'), item('k2', 'other_kind')];
  out.length = 0;
  const r = await w.runWatcher({ holder: 'mine', write: (l) => out.push(l), maxTicks: 1 });
  assert.equal(r.reason, 'unclaimed');
  assert.equal(out[0], 'not started: 1 new_item, 1 other_kind due and not handed out; run A work, hand them out, then start A watch last');
});

test('the watcher exits when work is due and releases the lease; with nothing due it keeps ticking at the app\'s interval', async () => {
  const { q } = await setup({ queue: [] });
  const out = [];
  const sleeps = [];
  const r = await w.runWatcher({ holder: 'mine', write: (l) => out.push(l), sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 2) q.items = [item('k9', 'new_item')]; }, timer: () => () => {}, ctx: {} });
  assert.equal(r.reason, 'due');
  assert.deepEqual(out, ['watching; exits when work is due', 'Alpha round: 1 new_item']);
  assert.equal(store.loadState().lease, null, 'the lease is released for the session to restart it');
  assert.deepEqual(sleeps, [lease.TICK_MS, lease.TICK_MS]);
  assert.equal(store.loadState().watcherEver, true);
  process.env.ALPHA_TICK_MS = '1234';
  try { assert.equal(w.tickMsOf(), 1234); } finally { delete process.env.ALPHA_TICK_MS; }
  assert.equal(w.tickMsOf(), lease.TICK_MS);
});
