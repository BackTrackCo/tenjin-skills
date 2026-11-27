import { getApp } from './app.mjs';
import { loadState, updateState } from './store.mjs';

// The batch: a record in the app's state, under the store's lock. There is no hook. What stays in code:
//  - a batch must be open for the app to hand out work that acts for the person;
//  - while a batch is open the CLI refuses every command that changes what an action may do (the app's `denied` list);
//  - an unattended batch closes in code at the end of its round;
//  - a batch with two hours of no activity counts as closed, and the next `work` call cleans it up.
// The app declares: batch: { denied: [[command, sub-command or null]], unattendedDenied: [...], openExtras() }. This file is a gate file for
// every app that uses it.
const decl = () => {
  const b = getApp().batch;
  if (!b || !Array.isArray(b.denied) || !Array.isArray(b.unattendedDenied)) throw new Error(`the app ${getApp().name} has not declared its batch lists`);
  return b;
};

// A batch that saw no call for two hours is abandoned. One application takes minutes and a round of 20 about two hours
// of work in total, and every hand-out and every batch-aware command refreshes the record, so only a batch with no
// activity at all goes stale.
export const STALE_MS = 2 * 60 * 60 * 1000;

const match = (list, cmd, sub) => list.some(([c, s]) => c === cmd && (s === null || s === sub));
// Also refused while an unattended batch is open: nobody is there to say yes, so nothing may record one or loosen a stop.
export const isBatchDenied = (cmd, sub, mode = null) => match(decl().denied, cmd, sub) || (mode === 'unattended' && match(decl().unattendedDenied, cmd, sub));

export const batchOf = (state = loadState()) => state.batch || null;
export const batchExists = (state) => Boolean(batchOf(state));
export function isStale(now = Date.now(), state) {
  const b = batchOf(state);
  return Boolean(b && now - Date.parse(b.touchedAt) >= STALE_MS);
}
export function isActive(now = Date.now(), state) {
  return batchExists(state) && !isStale(now, state);
}
export const batchMode = (state) => (batchOf(state) || {}).mode || null;

// What a batch records beyond its mode and times comes from the app's declaration, never from a page.
export function openBatch({ mode = 'attended', uploadPath = null, now = Date.now() } = {}) {
  const extras = typeof decl().openExtras === 'function' ? decl().openExtras() : {};
  const batch = { mode, uploadPath, ...extras, openedAt: new Date(now).toISOString(), touchedAt: new Date(now).toISOString() };
  updateState((s) => { s.batch = batch; });
  return batch;
}
export function closeBatch() {
  updateState((s) => { s.batch = null; });
}
export function touchBatch(now = Date.now()) {
  updateState((s) => { if (s.batch) s.batch.touchedAt = new Date(now).toISOString(); });
}
// Called by `work`: a stale batch is closed in code.
export function cleanupStale(now = Date.now()) {
  if (batchExists(loadState()) && isStale(now, loadState())) {
    closeBatch();
    return true;
  }
  return false;
}
