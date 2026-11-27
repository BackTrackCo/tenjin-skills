// A day's record of what ran: wakes (the watcher) and subagent runs (each model step, logged where its result is recorded).
const KEEP = 300;
export function logRun(state, kind, items = 1, now = Date.now()) {
  (state.runs ||= []).push({ at: new Date(now).toISOString(), kind, items });
  if (state.runs.length > KEEP) state.runs.splice(0, state.runs.length - KEEP);
}
export function logWake(state, counts, notify, now = Date.now()) {
  (state.wakes ||= []).push({ at: new Date(now).toISOString(), counts, notify: Boolean(notify) });
  if (state.wakes.length > KEEP) state.wakes.splice(0, state.wakes.length - KEEP);
}
