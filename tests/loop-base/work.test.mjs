import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_LIB, demoApp, tmpRoot } from './helpers/demo.mjs';

tmpRoot();
const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
const work = await import(path.join(BASE_LIB, 'work.mjs'));
const NOW = Date.parse('2026-11-26T12:00:00Z');
const MIN = 60000;
const rulesDecl = { effects: () => ['notify_off', 'notify_quiet_hours'], lessonEffects: () => [], lessonDays: () => [1], lessonTemplates: {}, exempt: [] };
const raw = (state) => ({ ...Object.fromEntries((state.waiting || []).map((n) => [`sig:${n.id}`, n.sig])) });
const decl = { waitingSetRaw: raw, clockFields: ['seenAt', 'checkedAt'], notifyParts: (fresh) => fresh.map((k) => `${k.slice(4)} waits`), notifyHint: (s) => (s.hint ? { line: 'a hint' } : null) };
const use = async (extra = {}) => setApp(await demoApp('alpha', { rules: rulesDecl, work: { ...decl, ...extra } }));
const item = (key, reason, over = {}) => ({ key, reason, v: '1', waitsForPerson: false, ...over });

test('an app that declared no work core fails with a clear error', async () => {
  setApp(await demoApp('alpha', { rules: rulesDecl }));
  assert.throws(() => work.waitingSet({}), /has not declared its work core/);
});

test('a claim holds an item for its time limit, then an item still open wakes once more; timing out again with nothing new wakes nobody', async () => {
  await use();
  const s = { claims: {} };
  const a = item('k1', 'new_item');
  const waiting = item('k2', 'ask', { waitsForPerson: true });
  work.claimItems(s, [a, waiting], NOW);
  assert.deepEqual(Object.keys(s.claims), ['k1|new_item'], 'what waits for the person is never claimed');
  assert.equal(work.claimActive(s, a, NOW + 19 * MIN), true);
  assert.equal(work.claimActive(s, a, NOW + 20 * MIN), false);
  assert.equal(work.roundOpen(s, NOW + 5 * MIN), true);
  assert.equal(work.roundOpen(s, NOW + 25 * MIN), false);
  assert.deepEqual(work.unclaimedDue(s, [a, waiting], NOW + 1000), []);
  assert.deepEqual(work.unclaimedDue(s, [a, waiting], NOW + 30 * MIN), [a]);
  work.settleClaims(s, [a], NOW + 21 * MIN);
  assert.equal(s.claims['k1|new_item'], undefined);
  assert.equal(s.claimEpochs['k1|new_item'], 1);
  assert.equal(work.withClaimEpoch(s, a), '1~1', 'a changed version wakes the model once');
  work.claimItems(s, [a], NOW + 22 * MIN);
  work.settleClaims(s, [{ ...a, v: '1~1' }], NOW + 43 * MIN);
  assert.equal(s.claimEpochs['k1|new_item'], 1, 'nothing new about the item: no second epoch');
  work.claimItems(s, [a], NOW + 44 * MIN);
  work.settleClaims(s, [], NOW + 45 * MIN);
  assert.deepEqual(s.claims, {}, 'a claim for an item no longer due is dropped');
});

test('claims can be released by match and refreshed by reason', async () => {
  await use();
  const s = { claims: {} };
  work.claimItems(s, [item('a', 'r1'), item('b', 'r2')], NOW);
  work.refreshClaims(s, 'r2', NOW + 10 * MIN);
  assert.equal(s.claims['b|r2'].at, new Date(NOW + 10 * MIN).toISOString());
  assert.equal(s.claims['a|r1'].at, new Date(NOW).toISOString());
  work.releaseClaims(s, (key) => key === 'a');
  assert.deepEqual(Object.keys(s.claims), ['b|r2']);
});

test('an item version follows the record and ignores the clock fields the app declares', async () => {
  await use();
  const j = { key: 'k', status: 'new', seenAt: 1, checkedAt: 2 };
  const v = work.itemVersion(j);
  assert.equal(work.itemVersion({ ...j, seenAt: 99, checkedAt: 98 }), v);
  assert.notEqual(work.itemVersion({ ...j, status: 'done' }), v);
  assert.equal(work.itemVersion({ ...j, extra: 1 }, ['extra', 'seenAt', 'checkedAt']), work.itemVersion(j, ['seenAt', 'checkedAt']));
  assert.match(v, /^[0-9a-f]{10}$/);
});

test('the waiting set hides what was shown until it changes, and markShown forgets a changed or gone item', async () => {
  await use();
  const s = { waiting: [{ id: 'a', sig: 's1' }, { id: 'b', sig: 's1' }], shown: {} };
  assert.deepEqual(work.waitingSet(s), { 'sig:a': 's1', 'sig:b': 's1' });
  assert.equal(work.markShown(s, ['a']), 1);
  assert.deepEqual(work.waitingSet(s), { 'sig:b': 's1' });
  s.waiting[0].sig = 's2';
  assert.deepEqual(work.waitingSet(s), { 'sig:a': 's2', 'sig:b': 's1' }, 'a changed item comes back');
  work.markShown(s);
  assert.deepEqual(work.waitingSet(s), {}, 'all shown');
  s.waiting = [s.waiting[1]];
  work.markShown(s, ['nothing']);
  assert.deepEqual(Object.keys(s.shown), ['sig:b'], 'a gone item is not kept');
});

test('the wake fingerprint is stable under reordering and counts only what the model could act on', async () => {
  await use();
  const items = [item('b', 'x', { v: '2' }), item('a', 'x'), item('c', 'y', { waitsForPerson: true }), item('d', 'z')];
  const s = { claims: {} };
  work.claimItems(s, [items[3]], NOW);
  const t = work.actionableTokens(s, items, NOW + 1000);
  assert.deepEqual(t, ['a:x:1', 'b:x:2']);
  assert.equal(work.fingerprint(t), work.fingerprint([...t].reverse()));
  assert.equal(work.fingerprint(t), 'a:x:1|b:x:2');
});

test('notify parts join in order, the line is cleaned and cut under 200 characters, and a hint rides along when it fits', async () => {
  await use();
  const s = { waiting: [{ id: 'one', sig: '1' }, { id: 'two', sig: '1' }], shown: {}, notified: {}, hint: false };
  const o = { rules: [] };
  assert.deepEqual(work.notifyLine({ ...s, waiting: [] }, o, NOW), { line: null, next: {} });
  const r = work.notifyLine(s, o, NOW);
  assert.equal(r.line, 'one waits, two waits');
  assert.deepEqual(r.next, { 'sig:one': '1', 'sig:two': '1' });
  assert.equal(work.notifyLine({ ...s, notified: r.next }, o, NOW).line, null, 'told once');
  assert.equal(work.notifyLine({ ...s, hint: true }, o, NOW).line, 'one waits, two waits | a hint');
  await use({ notifyParts: () => ['*x_`#[y]*'] });
  assert.equal(work.notifyLine(s, o, NOW).line, 'xy', 'markdown characters are dropped');
  await use({ notifyParts: () => ['a'.repeat(300)], notifyHint: () => null });
  const long = work.notifyLine(s, o, NOW).line;
  assert.equal(long.length, 190);
  assert.ok(long.endsWith('...'));
  await use({ notifyParts: () => ['a'.repeat(300)], notifyHint: () => ({ line: 'x'.repeat(10) }) });
  assert.equal(work.notifyLine(s, o, NOW).line.length, 190, 'a hint that does not fit under 200 characters is left out');
});

test('notify_off holds every push, and quiet hours hold one until they end, leaving it unnotified', async () => {
  await use();
  const s = { waiting: [{ id: 'one', sig: '1' }], shown: {}, notified: { old: 'x' } };
  assert.equal(work.notifyLine(s, { rules: [{ effect: 'notify_off', value: true }] }, NOW).line, null);
  const noon = new Date(2026, 10, 26, 12, 0).getTime();
  const night = new Date(2026, 10, 26, 23, 0).getTime();
  const early = new Date(2026, 10, 26, 3, 0).getTime();
  const q = { rules: [{ effect: 'notify_quiet_hours', value: '22-7' }] };
  assert.equal(work.notifyLine(s, q, noon).line, 'one waits');
  for (const at of [night, early]) {
    const r = work.notifyLine(s, q, at);
    assert.deepEqual([r.line, r.quiet, r.next], [null, true, s.notified], 'held, and still unnotified');
  }
  assert.equal(work.notifyLine(s, { rules: [{ effect: 'notify_quiet_hours', value: '9-17' }] }, noon).quiet, true, 'a daytime window too');
});
