import crypto from 'node:crypto';
import { updateState } from './store.mjs';

export const STALE_MS = 3 * 60 * 1000;

export const leaseFresh = (lease, now) => Boolean(lease && now - Date.parse(lease.heartbeat) < STALE_MS);

export function claimLease({ holder = crypto.randomBytes(6).toString('hex'), now = Date.now() } = {}) {
  return updateState((state) => {
    if (leaseFresh(state.lease, now) && state.lease.holder !== holder) return { ok: false, heldBy: state.lease.holder, since: state.lease.heartbeat };
    state.lease = { holder, heartbeat: new Date(now).toISOString() };
    return { ok: true, holder };
  });
}

export function heartbeat(holder, now = Date.now()) {
  return updateState((state) => {
    if (!state.lease || state.lease.holder !== holder) return false;
    state.lease.heartbeat = new Date(now).toISOString();
    return true;
  });
}

export function releaseLease(holder) {
  return updateState((state) => {
    if (state.lease && state.lease.holder === holder) state.lease = null;
  });
}
