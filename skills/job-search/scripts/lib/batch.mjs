import { graph } from './graph.mjs';
import { loadState, updateState } from './store.mjs';

// The batch: a record in state.json, under the store's lock. There is no hook. What stays in code:
//  - an apply batch must be open for `apply next` to hand out a job;
//  - while a batch is open the CLI refuses every command that changes what a submit may do (BATCH_DENIED);
//  - an unattended batch closes in code at the end of its round (see jobs.mjs apply next and stop);
//  - a batch with two hours of no activity counts as closed, and the next `work` call cleans it up.
// The rest is a rule in the browser subagent's task (references/apply.md); nothing in code sees its clicks.

// A batch that saw no call for two hours is abandoned. One application takes minutes and a round of 20 about two hours
// of work in total, and every `apply next` and every batch-aware command refreshes the record, so only a batch with no
// activity at all goes stale.
export const STALE_MS = 2 * 60 * 60 * 1000;

// Commands refused while a batch is open, whoever calls them: [command, sub-command or null for any].
export const BATCH_DENIED = [
  ['rules', 'add'], ['rules', 'remove'], ['lessons', 'add'], ['lessons', 'remove'],
  ['consent', 'record'], ['writing', 'approve'], ['answer', 'add'], ['fact', 'set'],
  ['profile', 'set'], ['frequency', 'set'], ['start', 'record'], ['watch', 'remove'],
  ['setup', 'resume'], ['setup', 'careerops'], ['dryrun', 'confirm'], ['batch', 'open'],
  ['pipeline', 'add'], ['release', 'apply'], ['intros', 'save'], ['contacts', 'count'], ['leads', 'save'], ['leads', 'mark'],
];
export const isBatchDenied = (cmd, sub) => BATCH_DENIED.some(([c, s]) => c === cmd && (s === null || s === sub));

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

// Hosts only from graph.json, so a page cannot widen them.
export function openBatch({ mode = 'attended', uploadPath = null, now = Date.now() } = {}) {
  const g = graph();
  const batch = { mode, uploadPath, hosts: g.hosts.flatMap((h) => g.applyHostNames[h] || []), openedAt: new Date(now).toISOString(), touchedAt: new Date(now).toISOString() };
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
