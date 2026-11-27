import { getApp } from './app.mjs';
import { canonical, sha } from './hash.mjs';
import { ruleValue } from './rules.mjs';

// The work core: claims, item versions, the waiting set, what was shown, the wake fingerprint and the notify line. The app declares:
//   work: { waitingSetRaw(state), notifyParts(fresh, w, ctx) -> [phrase], notifyHint(state, ctx) -> { line } | null, clockFields: [fields] }
// A work item is { key, reason, v, waitsForPerson, ... }. The reserved rule effects `notify_off` and `notify_quiet_hours` ("22-7") are read here.
const decl = () => {
  const w = getApp().work;
  if (!w || typeof w.waitingSetRaw !== 'function' || typeof w.notifyParts !== 'function') throw new Error(`the app ${getApp().name} has not declared its work core`);
  return w;
};

// ---- claims: handed to the model, so the watcher does not wake it for them -------------------------------------------------------
// A claim ends when the item is handled, when it is left, when the item is no longer due, or at the time limit. The limit is 20 minutes:
// a little longer than the slowest claimed step, so a step that is still running keeps its claim, while an agent that died holds its
// item for at most 20 minutes. An item still open when its claim times out gets a version change, so it wakes the model once.
export const CLAIM_MS = 20 * 60000;
export const claimKey = (i) => `${i.key}|${i.reason}`;
export const claimActive = (state, item, now = Date.now()) => {
  const c = (state.claims || {})[claimKey(item)];
  return Boolean(c && now - Date.parse(c.at) < CLAIM_MS);
};
export function claimItems(state, items, now = Date.now()) {
  for (const i of items) if (!i.waitsForPerson) (state.claims ||= {})[claimKey(i)] = { at: new Date(now).toISOString() };
}
// Drop claims for items that are no longer due, and end claims past the limit: an item still due then wakes once.
export function settleClaims(state, items, now = Date.now()) {
  const due = new Set(items.map(claimKey));
  const base = Object.fromEntries(items.map((i) => [claimKey(i), String(i.v || '').replace(/~\d+$/, '')]));
  for (const [k, c] of Object.entries(state.claims || {})) {
    if (!due.has(k)) { delete state.claims[k]; delete (state.claimBase || {})[k]; }
    else if (now - Date.parse(c.at) >= CLAIM_MS) {
      delete state.claims[k];
      // An item still open wakes the model once when its claim times out. Timing out again with nothing new about the item wakes
      // nobody: an item the model cannot progress does not come back every twenty minutes.
      if ((state.claimBase || {})[k] !== base[k]) {
        (state.claimEpochs ||= {})[k] = (state.claimEpochs[k] || 0) + 1;
        (state.claimBase ||= {})[k] = base[k];
      }
    }
  }
}
// A timed-out claim on a still-open item: one more wake, through a changed version.
export const withClaimEpoch = (state, item) => { const ep = (state.claimEpochs || {})[claimKey(item)]; return ep ? `${item.v}~${ep}` : item.v; };
// A round is open while any claimed item has not been handled: the session starts the watcher last, after it.
export const roundOpen = (state, now = Date.now()) => Object.values(state.claims || {}).some((c) => now - Date.parse(c.at) < CLAIM_MS);
export function releaseClaims(state, match) {
  for (const k of Object.keys(state.claims || {})) if (match(k.split('|')[0], k.split('|')[1])) delete state.claims[k];
}
export function refreshClaims(state, reason, now = Date.now()) {
  for (const [k, c] of Object.entries(state.claims || {})) if (k.endsWith(`|${reason}`)) c.at = new Date(now).toISOString();
}
// The due items the model could act on now that nobody has been handed.
export const unclaimedDue = (state, items, now = Date.now()) => items.filter((i) => !i.waitsForPerson && !claimActive(state, i, now));

// ---- item versions ---------------------------------------------------------------------------------------------------------------
// Every write to an item raises its state version: the version is a hash of the item's own record, apart from the clock fields the app
// declares (clocks that a re-verify touches without any news).
export function itemVersion(item, clockFields = decl().clockFields || []) {
  const rest = { ...item };
  for (const f of clockFields) delete rest[f];
  return sha(canonical(rest)).slice(0, 10);
}

// ---- what waits on the person ----------------------------------------------------------------------------------------------------
// As key -> signature. A parked item that did not change keeps the same signature. An item shown to the person in an attended turn (the
// report, an approval question, a reply) is marked with its signature, and leaves the notify set until the item changes: a push never
// repeats what the person was just shown.
export function waitingSet(state) {
  const raw = decl().waitingSetRaw(state);
  const w = {};
  for (const [k, v] of Object.entries(raw)) if ((state.shown || {})[k] !== v) w[k] = v;
  return w;
}
export function markShown(state, keys = null) {
  const raw = decl().waitingSetRaw(state);
  const next = {};
  for (const [k, v] of Object.entries(state.shown || {})) if (raw[k] === v) next[k] = v; // a changed or gone item is not shown any more
  for (const [k, v] of Object.entries(raw)) if (!keys || keys.some((x) => k === x || k.endsWith(`:${x}`))) next[k] = v;
  state.shown = next;
  return Object.keys(next).length;
}

// ---- the wake fingerprint --------------------------------------------------------------------------------------------------------
// The tokens of the due items the model could act on now: stable under reordering, one per item and version. A wake comes when a token is
// new, never on a timer.
export const actionableTokens = (state, items, now = Date.now()) => items.filter((i) => !i.waitsForPerson && !claimActive(state, i, now)).map((i) => `${i.key}:${i.reason}:${i.v}`).sort();
export const fingerprint = (tokens) => [...tokens].sort().join('|');

// ---- the notify line -------------------------------------------------------------------------------------------------------------
// One line, under 200 characters, for what is new in the waiting set. The app's `notifyParts` give the phrases in order; a rule can turn
// the push off or keep it quiet in set hours (22-7), and a push held for quiet hours stays unnotified so it goes after them.
export function notifyLine(state, overlay, now = Date.now(), ctx = {}) {
  const d = decl();
  const w = waitingSet(state);
  const fresh = Object.keys(w).filter((k) => (state.notified || {})[k] !== w[k]);
  if (!fresh.length) return { line: null, next: w };
  if (ruleValue(overlay, 'notify_off') !== undefined) return { line: null, next: w };
  const q = ruleValue(overlay, 'notify_quiet_hours');
  if (typeof q === 'string' && /^\d{1,2}-\d{1,2}$/.test(q)) {
    const [a, b] = q.split('-').map(Number);
    const h = new Date(now).getHours();
    const inQuiet = a <= b ? h >= a && h < b : h >= a || h < b;
    if (inQuiet) return { line: null, quiet: true, next: state.notified };
  }
  const parts = d.notifyParts(fresh, w, { state, overlay, now, ...ctx });
  let line = parts.join(', ').replace(/[*_`#\[\]]/g, '');
  if (line.length > 190) line = `${line.slice(0, 187)}...`;
  // A hint rides on the notification when it fits.
  const hint = typeof d.notifyHint === 'function' ? d.notifyHint(state, { overlay, now, ...ctx }) : null;
  if (hint && line.length + 3 + hint.line.length < 200) line += ` | ${hint.line}`;
  return { line, next: w };
}

