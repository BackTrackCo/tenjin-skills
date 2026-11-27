import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL, runGtm, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const store = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
const watcher = await import('../../skills/gtm-loop/scripts/lib/watcher.mjs');
const work = await import('../../skills/gtm-loop/scripts/lib/work.mjs');
const q = await import('../../skills/gtm-loop/scripts/lib/questions.mjs');

test('G gates prints the hash and it matches the manifest', () => {
  const r = runGtm(home, ['gates']);
  assert.equal(r.code, 0);
  assert.equal(r.json.gatesHash, JSON.parse(fs.readFileSync(path.join(SKILL, 'manifest.json'), 'utf8')).gatesHash);
});

test('an unknown command lists the known ones; rules and profile round trip through the CLI', () => {
  const bad = runGtm(home, ['nope']);
  assert.equal(bad.code, 2);
  assert.ok(bad.json.commands.includes('rules'));
  const add = runGtm(home, ['rules', 'add', '--effect', 'min_score', '--value', '55', '--words', 'only strong ones']);
  assert.equal(add.json.rule.effect, 'min_score');
  assert.equal(runGtm(home, ['rules']).json.rules.length, 1);
  const set = runGtm(home, ['profile', 'set', '--json', '{"offer":{"name":"Thing","what":"does a thing"}}']);
  assert.equal(set.json.profile.offer.name, 'Thing');
  assert.match(runGtm(home, ['profile', 'set', '--json', '{"sources":["x","bogus"]}']).json.error, /sources must/);
});

test('while a batch is open the commands that change what a send may do are refused', () => {
  store.updateState((s) => { s.batch = { mode: 'attended', openedAt: new Date().toISOString(), touchedAt: new Date().toISOString() }; });
  for (const args of [['rules', 'add', '--effect', 'note', '--value', 'x', '--words', 'y'], ['profile', 'set', '--json', '{}'], ['consent', 'record', 'email']]) {
    const r = runGtm(home, args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.json.error, /a batch is open/);
  }
  assert.equal(runGtm(home, ['rules']).code, 0, 'reads stay open');
  store.updateState((s) => { s.batch = null; });
});

test('the work list is empty with nothing due; an item is handed out once, and left items stay hidden until their version changes', () => {
  work.registerCollector(({ state }) => (state.signals.counts.demo ? [{ key: 'demo', reason: 'search_due', v: state.signals.counts.demo }] : []));
  assert.deepEqual(work.workList({ commit: true }).handed, []);
  store.applyOps([{ op: 'signal', kind: 'demo' }]);
  const a = work.workList({ commit: true });
  assert.deepEqual(a.handed.map((i) => i.key), ['demo']);
  assert.deepEqual(work.workList({ commit: true }).handed, [], 'claimed: not handed out again');
  work.leave('demo', 'no_web_search');
  assert.equal(work.workList().items.length, 0);
  store.applyOps([{ op: 'signal', kind: 'demo' }]);
  assert.equal(work.workList().items.length, 1, 'news on the item revives it');
  assert.throws(() => work.leave('demo', 'because'), /reason is one of/);
});

test('the watcher exits at once when another holds the lease, refuses while due work is unclaimed, and exits only for due work', async () => {
  store.updateState((s) => { s.claims = {}; s.left = {}; s.lease = null; s.signals.counts.demo = 0; });
  const lines = [];
  const write = (l) => lines.push(l);
  const lease = await import('../../skills/gtm-loop/scripts/lib/lease.mjs');
  await lease.claimLease({ holder: 'other', pid: process.pid });
  assert.equal((await watcher.runWatcher({ write, maxTicks: 1 })).reason, 'lease_held');
  lease.releaseLease('other');
  store.applyOps([{ op: 'signal', kind: 'demo' }]);
  const r1 = await watcher.runWatcher({ write, maxTicks: 1 });
  assert.equal(r1.reason, 'unclaimed');
  work.workList({ commit: true });
  const sleeps = [];
  const r2 = await watcher.runWatcher({ write, maxTicks: 3, tickMs: 1, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(r2.reason, 'max_ticks', 'claimed work is in flight: the watcher stays quiet');
  assert.equal(sleeps.length, 3);
  let bumped = false;
  const r3 = await watcher.runWatcher({ write, maxTicks: 5, tickMs: 1, sleep: async () => { if (!bumped) { bumped = true; store.applyOps([{ op: 'signal', kind: 'demo' }]); } } });
  assert.equal(r3.reason, 'due');
  assert.match(lines.at(-1), /GTM Loop round: run G work --commit --unattended/);
  assert.match(lines.at(-1), /1 search_due/);
  assert.equal(store.loadState().lease, null, 'the lease is released at the exit');
  const r4 = await watcher.runWatcher({ write, maxTicks: 1 });
  assert.equal(r4.reason, 'unclaimed');
});

test('a changed watcher code hash stops the watcher with a restart line', async () => {
  work.workList({ commit: true });
  await (await import('../../skills/gtm-loop/scripts/lib/lease.mjs')).claimLease({ holder: 'h', pid: process.pid });
  const r = await watcher.tick({ holder: 'h', startHash: 'old', now: Date.now() });
  assert.equal(r.stop, true);
  assert.match(r.lines[0], /watcher code changed/);
});

test('every question payload is checked against the question tool\'s limits', () => {
  assert.deepEqual(q.validateAsk(q.tenjinAsk({ line: 'Set up Tenjin?', status: 'missing' })), []);
  assert.ok(q.validateAsk({ questions: [q.q('Header', 'Q?', [{ label: 'One', description: 'd' }, { label: 'Two', description: 'd' }])] }).length, 'no default marker');
  assert.ok(q.validateAsk({ questions: [q.q('Header', 'Pick under Other', [{ label: 'One (Recommended)', description: 'd' }, { label: 'Two', description: 'd' }])] }).length, 'names the free-text option');
  assert.ok(q.validateAsk({ questions: [] }).length);
});
