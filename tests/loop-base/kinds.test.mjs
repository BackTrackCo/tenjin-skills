import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_LIB, demoApp, tmpRoot } from './helpers/demo.mjs';

tmpRoot();
const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
const k = await import(path.join(BASE_LIB, 'kinds.mjs'));
const calls = [];
const outreach = {
  collection: 'outreach',
  statuses: ['new', 'drafted', 'sent'],
  transitions: { new: ['drafted'], drafted: ['sent'], sent: [] },
  terminal: ['sent'],
  onTransition: (c) => calls.push([c.kind, c.from, c.to, c.op.why || null]),
};
const signal = { collection: 'signals', statuses: ['seen', 'dropped'], transitions: { seen: ['dropped'], dropped: [] }, terminal: ['dropped'] };

test('an app that declared no kinds fails with a clear error, and an unknown kind is named', async () => {
  setApp(await demoApp('alpha'));
  assert.throws(() => k.kinds(), /has not declared its item kinds/);
  setApp(await demoApp('outreach', { kinds: { outreach } }));
  assert.throws(() => k.kindOf('nope'), /unknown item kind: nope/);
});

test('a declared transition lands, an illegal one and a move out of a final status are refused, and onTransition runs once per landing', async () => {
  setApp(await demoApp('outreach', { kinds: { outreach } }));
  calls.length = 0;
  const item = { status: 'new' };
  k.transition({}, 'outreach', item, 'drafted', { why: 'first' });
  assert.equal(item.status, 'drafted');
  assert.throws(() => k.transition({}, 'outreach', item, 'new'), /^Error: illegal transition drafted -> new$/, 'one kind: the message is the plain one');
  assert.throws(() => k.transition({}, 'outreach', item, 'bogus'), /illegal transition drafted -> bogus/);
  k.transition({}, 'outreach', item, 'sent');
  assert.throws(() => k.transition({}, 'outreach', item, 'drafted'), /illegal transition sent -> drafted/, 'a final status never moves on');
  assert.equal(item.status, 'sent');
  assert.deepEqual(calls, [['outreach', 'new', 'drafted', 'first'], ['outreach', 'drafted', 'sent', null]]);
  assert.equal(k.isTerminal('outreach', 'sent'), true);
  assert.equal(k.isTerminal('outreach', 'new'), false);
});

test('two kinds in one app keep separate collections, and a refusal names its kind', async () => {
  setApp(await demoApp('outreach', { kinds: { signal, outreach } }));
  assert.deepEqual([k.collectionOf('signal'), k.collectionOf('outreach')], ['signals', 'outreach']);
  const s = { status: 'seen' };
  let err;
  try { k.transition({}, 'signal', s, 'new'); } catch (e) { err = e; }
  assert.equal(err.kind, 'signal');
  assert.match(err.message, /^illegal transition seen -> new \(signal\)$/);
  k.transition({}, 'signal', s, 'dropped');
  assert.throws(() => k.transition({}, 'signal', s, 'seen'), /\(signal\)/);
  const o = { status: 'new' };
  assert.throws(() => k.transition({}, 'outreach', o, 'sent'), /illegal transition new -> sent \(outreach\)/);
});
