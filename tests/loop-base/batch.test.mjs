import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_LIB, demoApp, tmpRoot } from './helpers/demo.mjs';

tmpRoot();
const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
const batch = await import(path.join(BASE_LIB, 'batch.mjs'));
const store = await import(path.join(BASE_LIB, 'store.mjs'));
const NOW = Date.parse('2026-11-26T12:00:00Z');
const decl = { denied: [['rules', 'add'], ['consent', 'record'], ['batch', 'open']], unattendedDenied: [['approve', null], ['chrome', 'set']], openExtras: () => ({ denied: ['x.test'] }) };
const use = async (name = 'alpha', b = decl) => setApp(await demoApp(name, { batch: b }));

test('an app that declared no batch lists fails with a clear error', async () => {
  setApp(await demoApp('alpha'));
  assert.throws(() => batch.isBatchDenied('rules', 'add'), /has not declared its batch lists/);
});

test('a batch opens with the app\'s extras, closes, and is read back; nothing is open at the start', async () => {
  await use();
  assert.equal(batch.batchOf(), null);
  assert.equal(batch.isActive(NOW, store.loadState()), false);
  const b = batch.openBatch({ mode: 'unattended', uploadPath: '/tmp/x', now: NOW });
  assert.deepEqual(Object.keys(b), ['mode', 'uploadPath', 'denied', 'openedAt', 'touchedAt']);
  assert.deepEqual(b.denied, ['x.test']);
  assert.equal(batch.batchMode(store.loadState()), 'unattended');
  assert.equal(batch.isActive(NOW + 1000, store.loadState()), true);
  batch.closeBatch();
  assert.equal(batch.batchOf(), null);
  assert.equal(batch.batchMode(store.loadState()), null);
  await use('outreach', { denied: [], unattendedDenied: [] });
  assert.deepEqual(Object.keys(batch.openBatch({ now: NOW })), ['mode', 'uploadPath', 'openedAt', 'touchedAt']);
});

test('a batch with two hours of no activity counts as closed and the next cleanup closes it; any touch keeps it alive', async () => {
  await use();
  batch.openBatch({ now: NOW });
  assert.equal(batch.isStale(NOW + batch.STALE_MS - 1, store.loadState()), false);
  assert.equal(batch.isStale(NOW + batch.STALE_MS, store.loadState()), true);
  assert.equal(batch.cleanupStale(NOW + batch.STALE_MS - 1), false);
  batch.touchBatch(NOW + batch.STALE_MS - 1);
  assert.equal(batch.cleanupStale(NOW + batch.STALE_MS + 1000), false, 'touched, so not stale');
  assert.equal(batch.cleanupStale(NOW + 3 * batch.STALE_MS), true);
  assert.equal(batch.batchOf(), null);
  assert.equal(batch.cleanupStale(NOW + 9 * batch.STALE_MS), false, 'nothing to clean');
});

test('a command on the app\'s denied list is refused while a batch is open; an unattended batch also refuses its extra list; each app has its own', async () => {
  await use();
  assert.equal(batch.isBatchDenied('rules', 'add'), true);
  assert.equal(batch.isBatchDenied('rules', 'list'), false);
  assert.equal(batch.isBatchDenied('approve', 'x'), false);
  assert.equal(batch.isBatchDenied('approve', 'x', 'attended'), false);
  assert.equal(batch.isBatchDenied('approve', 'x', 'unattended'), true, 'any sub-command of a null entry');
  assert.equal(batch.isBatchDenied('chrome', 'set', 'unattended'), true);
  assert.equal(batch.isBatchDenied('chrome', 'get', 'unattended'), false);
  await use('outreach', { denied: [['send', 'now']], unattendedDenied: [] });
  assert.equal(batch.isBatchDenied('rules', 'add'), false);
  assert.equal(batch.isBatchDenied('send', 'now'), true);
});
