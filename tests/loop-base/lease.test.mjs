import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_LIB, demoApp, tmpRoot } from './helpers/demo.mjs';

tmpRoot();
const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
const store = await import(path.join(BASE_LIB, 'store.mjs'));
const lease = await import(path.join(BASE_LIB, 'lease.mjs'));
setApp(await demoApp('alpha'));
const NOW = Date.parse('2026-11-26T12:00:00Z');

test('a fresh lease held by someone else refuses a claim, and a stale one or a dead pid is reclaimed', () => {
  assert.equal(lease.claimLease({ holder: 'a', pid: process.pid, now: NOW }).ok, true);
  assert.deepEqual(lease.claimLease({ holder: 'b', now: NOW + 1000 }), { ok: false, heldBy: 'a', since: new Date(NOW).toISOString() });
  assert.equal(lease.claimLease({ holder: 'a', pid: process.pid, now: NOW + 1000 }).ok, true, 'the holder renews');
  assert.equal(lease.claimLease({ holder: 'b', now: NOW + lease.STALE_MS + 5000 }).ok, true, 'a stale lease is reclaimed');
  const later = NOW + 10 * lease.STALE_MS;
  assert.equal(lease.claimLease({ holder: 'c', pid: 2147483646, now: later }).ok, true);
  assert.equal(lease.claimLease({ holder: 'd', now: later + 1000 }).ok, true, 'a dead pid is reclaimed');
});

test('only the watcher writes liveness; a command only notes its own use', () => {
  lease.releaseLease('d');
  lease.claimLease({ holder: 'w', pid: process.pid, now: NOW });
  const before = store.loadState().lease.alive;
  lease.touchLease(NOW + 5000);
  assert.equal(store.loadState().lease.alive, before);
  assert.equal(store.loadState().lease.commandAt, new Date(NOW + 5000).toISOString());
  assert.equal(lease.beat('other', NOW + 9000), false);
  assert.equal(lease.beat('w', NOW + 9000), true);
  assert.equal(store.loadState().lease.alive, new Date(NOW + 9000).toISOString());
  assert.equal(lease.heartbeat('w', NOW + 10000), true);
  lease.releaseLease('w');
  assert.equal(store.loadState().lease, null);
});

test('watcherStatus says running only for a live pid and a fresh liveness field', () => {
  assert.deepEqual(lease.watcherStatus({ lease: null }, NOW), { running: false, why: 'no watcher' });
  const mk = (over) => ({ lease: { holder: 'w', pid: process.pid, alive: new Date(NOW).toISOString(), heartbeat: new Date(NOW).toISOString(), ...over } });
  assert.deepEqual(lease.watcherStatus(mk({}), NOW + 1000), { running: true, pid: process.pid });
  assert.equal(lease.watcherStatus(mk({ pid: 2147483646 }), NOW).why, 'its process is gone');
  assert.equal(lease.watcherStatus(mk({}), NOW + lease.STALE_MS + 1).why, 'its liveness field is stale');
  assert.equal(lease.STALE_MS, 2 * lease.TICK_MS);
  assert.equal(lease.leaseFresh(null, NOW), false);
});
