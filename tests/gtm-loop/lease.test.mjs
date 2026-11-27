import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './helpers/env.mjs';

tmpHome();
const lease = await import('../../skills/gtm-loop/scripts/lib/lease.mjs');
const store = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
const NOW = Date.parse('2026-11-26T10:00:00Z');

test('a fresh lease blocks a second holder; a dead pid or a stale heartbeat is reclaimed', async () => {
  const a = await lease.claimLease({ holder: 'a', pid: process.pid, now: NOW });
  assert.equal(a.ok, true);
  const b = await lease.claimLease({ holder: 'b', pid: process.pid, now: NOW + 1000 });
  assert.equal(b.ok, false);
  assert.equal(b.heldBy, 'a');
  assert.equal(lease.watcherStatus(store.loadState(), NOW + 1000).running, true);
  const late = await lease.claimLease({ holder: 'b', pid: process.pid, now: NOW + lease.STALE_MS + 1000 });
  assert.equal(late.ok, true, 'stale liveness is reclaimed');
  const dead = await lease.claimLease({ holder: 'c', pid: 2 ** 22 + 77, now: NOW + lease.STALE_MS + 2000 });
  assert.equal(dead.ok, false, 'b is fresh and alive');
  lease.releaseLease('b');
  const c = await lease.claimLease({ holder: 'c', pid: 2 ** 22 + 77, now: NOW + lease.STALE_MS + 3000 });
  assert.equal(c.ok, true);
  assert.equal(lease.watcherStatus(store.loadState(), NOW + lease.STALE_MS + 3500).running, false, 'its process is gone');
});

test('only the holder heartbeats and a command touch never refreshes the liveness field', async () => {
  lease.releaseLease('c');
  await lease.claimLease({ holder: 'h', pid: process.pid, now: NOW });
  assert.equal(lease.heartbeat('other', NOW + 5), false);
  assert.equal(lease.heartbeat('h', NOW + 10), true);
  const alive = store.loadState().lease.alive;
  lease.touchLease(NOW + 99999);
  assert.equal(store.loadState().lease.alive, alive);
});
