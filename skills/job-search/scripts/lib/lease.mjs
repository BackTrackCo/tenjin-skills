import crypto from 'node:crypto';
import { updateState, loadState } from './store.mjs';

// The lease belongs to the session. The watcher refreshes it on every tick and records its process id and last tick; every
// J command refreshes it while that process lives. A lease is stale after twice the tick interval, or when its process is
// gone, and the next `J arm` or watcher reclaims it.
export const TICK_MS = 60_000;
export const STALE_MS = 2 * TICK_MS;

export const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
// A lease with no recorded pid (the older shape) counts as alive while its heartbeat is fresh.
export const leaseFresh = (lease, now) => Boolean(lease && now - Date.parse(lease.heartbeat) < STALE_MS && (lease.pid === undefined || lease.pid === null || pidAlive(lease.pid)));

export function claimLease({ holder = crypto.randomBytes(6).toString('hex'), pid = null, now = Date.now() } = {}) {
  return updateState((state) => {
    if (leaseFresh(state.lease, now) && state.lease.holder !== holder) return { ok: false, heldBy: state.lease.holder, since: state.lease.heartbeat };
    state.lease = { holder, heartbeat: new Date(now).toISOString(), pid, lastTick: new Date(now).toISOString() };
    return { ok: true, holder };
  });
}

export function heartbeat(holder, now = Date.now()) {
  return updateState((state) => {
    if (!state.lease || state.lease.holder !== holder) return false;
    state.lease.heartbeat = new Date(now).toISOString();
    state.lease.lastTick = state.lease.heartbeat;
    return true;
  });
}

export function releaseLease(holder) {
  return updateState((state) => {
    if (state.lease && state.lease.holder === holder) state.lease = null;
  });
}

// Is a watcher running? Its process lives and its last tick is recent.
export function watcherStatus(state, now = Date.now()) {
  const l = state.lease;
  if (!l) return { running: false, why: 'no watcher' };
  if (l.pid !== undefined && l.pid !== null && !pidAlive(l.pid)) return { running: false, why: 'its process is gone' };
  if (now - Date.parse(l.lastTick || l.heartbeat) > STALE_MS) return { running: false, why: 'its last tick is stale' };
  return { running: true, pid: l.pid || null };
}

// Every J command from the session refreshes the lease while the watcher's process lives.
export function touchLease(now = Date.now()) {
  const l = loadState().lease;
  if (!l || !watcherStatus({ lease: l }, now).running) return;
  updateState((s) => { if (s.lease && s.lease.holder === l.holder) s.lease.heartbeat = new Date(now).toISOString(); });
}
