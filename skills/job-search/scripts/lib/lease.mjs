import crypto from 'node:crypto';
import { updateState, loadState } from './store.mjs';

// The lease belongs to the session. The watcher records its process id and refreshes one liveness field, `alive`, from a
// timer that runs through long ticks (a tick can last minutes: slow providers, timeouts), so a working watcher never looks
// stopped. Only the watcher writes `alive`; J commands never do. A watcher is running when its pid lives and `alive` is
// fresh; the lease is reclaimed only when the pid is dead or `alive` is older than twice the tick interval (a reused pid
// with a stale field counts as dead).
export const TICK_MS = 60_000;
export const ALIVE_MS = 30_000; // the liveness timer
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
// A lease with no recorded pid counts as alive while its heartbeat is fresh.
const aliveAt = (l) => Date.parse(l.alive || l.heartbeat);
export const leaseFresh = (lease, now) => Boolean(lease && now - aliveAt(lease) < STALE_MS && (lease.pid === undefined || lease.pid === null || pidAlive(lease.pid)));

export function claimLease({ holder = crypto.randomBytes(6).toString('hex'), pid = null, now = Date.now() } = {}) {
  return updateState((state) => {
    if (leaseFresh(state.lease, now) && state.lease.holder !== holder) return { ok: false, heldBy: state.lease.holder, since: state.lease.heartbeat };
    state.lease = { holder, heartbeat: new Date(now).toISOString(), pid, alive: new Date(now).toISOString(), lastTick: new Date(now).toISOString() };
    return { ok: true, holder };
  });
}

export function heartbeat(holder, now = Date.now()) {
  return updateState((state) => {
    if (!state.lease || state.lease.holder !== holder) return false;
    state.lease.heartbeat = new Date(now).toISOString();
    state.lease.alive = state.lease.heartbeat;
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
  if (now - aliveAt(l) > STALE_MS) return { running: false, why: 'its liveness field is stale' };
  return { running: true, pid: l.pid || null };
}

// The liveness timer's write: the watcher only.
export function beat(holder, now = Date.now()) {
  return updateState((state) => {
    if (!state.lease || state.lease.holder !== holder) return false;
    state.lease.alive = new Date(now).toISOString();
    return true;
  });
}

// A J command notes its own use of the lease and never touches the liveness field.
export function touchLease(now = Date.now()) {
  const l = loadState().lease;
  if (!l) return;
  updateState((s) => { if (s.lease && s.lease.holder === l.holder) s.lease.commandAt = new Date(now).toISOString(); });
}
