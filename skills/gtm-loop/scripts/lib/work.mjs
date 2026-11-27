import { graph } from './graph.mjs';
import { loadState, updateState } from './store.mjs';
import { loadOverlay } from './overlay.mjs';
import { readProfile } from './profile.mjs';

// The work list: what is due now, as items `{key, reason, v, waitsForPerson}`. An item's version `v` changes only on real news,
// so the watcher wakes for a new item or a new version, never on a clock. `commit` claims the actionable items (hands them to
// the model); a claimed item is in flight for CLAIM_MS. Items that wait for the person never wake the model: they feed one
// notify line.
export const CLAIM_MS = 30 * 60000;
const MIN = 60000;
void MIN;

// Each step module adds its collector here, so work.mjs needs no knowledge of their state. A collector gets
// {state, profile, overlay, now} and returns items.
const collectors = [];
export const registerCollector = (fn) => collectors.push(fn);

export function itemsOf(state, profile, overlay, now) {
  const items = [];
  if (state.update && state.update.waiting) items.push({ key: 'update', reason: 'update_waiting', v: 1, waitsForPerson: true, detail: state.update.waiting.tag });
  for (const c of collectors) items.push(...c({ state, profile, overlay, now }));
  const g = graph();
  return items.filter((i) => g.workReasons.includes(i.reason)).filter((i) => !leftAt(state, i));
}

const leftAt = (state, item) => Boolean(state.left && state.left[item.key] && state.left[item.key].v === item.v);

export function claimActive(state, item, now = Date.now()) {
  const c = (state.claims || {})[item.key];
  return Boolean(c && c.v === item.v && now - Date.parse(c.at) < CLAIM_MS);
}
export const actionable = (items) => items.filter((i) => !i.waitsForPerson);
export const unclaimedDue = (state, items, now = Date.now()) => actionable(items).filter((i) => !claimActive(state, i, now));

// Ends the claims for items no longer due or past their limit.
export function settleClaims(state, items, now = Date.now()) {
  const live = new Map(items.map((i) => [i.key, i]));
  for (const [k, c] of Object.entries(state.claims || {})) {
    const it = live.get(k);
    if (!it || it.v !== c.v || now - Date.parse(c.at) >= CLAIM_MS) delete state.claims[k];
  }
}

// What waits for the person, one line, and the set the watcher compares between ticks.
export function waitingSet(state, now = Date.now()) {
  const items = itemsOf(state, readProfile(), loadOverlay(), now).filter((i) => i.waitsForPerson);
  return Object.fromEntries(items.map((i) => [`${i.reason}:${i.key}`, i.v]));
}
export function notifyLine(items) {
  const waiting = items.filter((i) => i.waitsForPerson);
  if (!waiting.length) return null;
  const n = {};
  for (const i of waiting) n[i.reason] = (n[i.reason] || 0) + (i.count || 1);
  const words = { approve_due: 'drafts waiting for your pick', follow_up_due: 'follow-ups waiting for your yes', update_waiting: 'update waiting for your yes' };
  return Object.entries(n).map(([k, c]) => `${c} ${words[k] || k}`).join(', ');
}

export function workList({ now = Date.now(), commit = false } = {}) {
  const profile = readProfile();
  const overlay = loadOverlay();
  const run = (state) => {
    const items = itemsOf(state, profile, overlay, now);
    const out = commit ? unclaimedDue(state, items, now) : [];
    if (commit) for (const i of out) state.claims[i.key] = { v: i.v, at: new Date(now).toISOString() };
    return { items, handed: out, notify: notifyLine(items) };
  };
  return commit ? updateState(run) : run(loadState());
}

// "Leave it": the model decided to leave an item as it is. Hidden until its version changes.
export const LEAVE_REASONS = ['low_score', 'no_match', 'not_a_lead', 'duplicate', 'no_web_search', 'not_sending', 'other'];
export function leave(key, reason, now = Date.now()) {
  if (!LEAVE_REASONS.includes(reason)) throw new Error(`the reason is one of ${LEAVE_REASONS.join(', ')}`);
  return updateState((state) => {
    const item = itemsOf(state, readProfile(), loadOverlay(), now).find((i) => i.key === key);
    if (!item) throw new Error(`no due item: ${key}`);
    state.left[key] = { v: item.v, reason, at: new Date(now).toISOString() };
    delete state.claims[key];
    return { left: key, reason };
  });
}
