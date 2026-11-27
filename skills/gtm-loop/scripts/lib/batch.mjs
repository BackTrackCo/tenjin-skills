import { loadState, updateState } from './store.mjs';

// The batch: a record in state.json, under the store's lock. There is no hook. What stays in code:
//  - while a batch is open the CLI refuses every command that changes what a send may do (BATCH_DENIED);
//  - an unattended batch also refuses every command that needs a person's yes (UNATTENDED_DENIED);
//  - a batch with two hours of no activity counts as closed, and the next `work` call cleans it up.
export const STALE_MS = 2 * 60 * 60 * 1000;

// Refused while a batch is open, whoever calls them: [command, sub-command or null for any]. A consent is recorded only in an
// attended turn.
export const BATCH_DENIED = [
  ['rules', 'add'], ['rules', 'remove'], ['consent', 'record'], ['consent', 'revoke'], ['profile', 'set'], ['phrases', 'set'],
  ['dryrun', 'confirm'], ['batch', 'open'], ['email', 'connector'], ['email', 'approve'], ['release', 'apply'],
  ['suppress', 'remove'], ['reply', 'unknown'], ['queries', 'set'], ['queries', 'decline'], ['queries', 'remove'], ['queries', 'pin'], ['queries', 'unpin'], ['query', 'test'],
];
// Also refused while an unattended batch is open: nobody is there to say yes.
export const UNATTENDED_DENIED = [['query', null], ['pick', null], ['approve', null], ['ask', null], ['open', null], ['sent', null], ['follow-up', null], ['replied', null], ['email', 'unknown']];
export const isBatchDenied = (cmd, sub, mode = null) => BATCH_DENIED.some(([c, s]) => c === cmd && (s === null || s === sub)) || (mode === 'unattended' && UNATTENDED_DENIED.some(([c, s]) => c === cmd && (s === null || s === sub)));

export const batchOf = (state = loadState()) => state.batch || null;
export const batchExists = (state) => Boolean(batchOf(state));
export const isStale = (now = Date.now(), state) => {
  const b = batchOf(state);
  return Boolean(b && now - Date.parse(b.touchedAt) >= STALE_MS);
};
export const isActive = (now = Date.now(), state = loadState()) => batchExists(state) && !isStale(now, state);
export const batchMode = (state = loadState()) => (batchOf(state) || {}).mode || null;

export function openBatch({ mode = 'attended', now = Date.now() } = {}) {
  const batch = { mode, openedAt: new Date(now).toISOString(), touchedAt: new Date(now).toISOString() };
  updateState((s) => { s.batch = batch; });
  return batch;
}
export const closeBatch = () => updateState((s) => { s.batch = null; });
export const touchBatch = (now = Date.now()) => updateState((s) => { if (s.batch) s.batch.touchedAt = new Date(now).toISOString(); });
// Called by `work`: a stale batch is closed in code.
export function cleanupStale(now = Date.now()) {
  const s = loadState();
  if (batchExists(s) && isStale(now, s)) {
    closeBatch();
    return true;
  }
  return false;
}
