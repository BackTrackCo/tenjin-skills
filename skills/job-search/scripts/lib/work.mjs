import { graph } from './graph.mjs';
import { updateState, loadState } from './store.mjs';
import { loadOverlay, activeLessons, ruleValue } from './overlay.mjs';
import { readJson, stateDir } from './paths.mjs';
import { cleanupStale, isActive, policyFile } from './guard.mjs';
import path from 'node:path';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const GATES = {
  search_due: 'Run the routed search (references/search.md): Haiku subagent, state the needs to Tenjin, write the ingest file, run ingest.',
  post_review: 'An X hiring post: find the employer, the role and an apply link on Greenhouse, Lever or Ashby, then ingest it as a posting; otherwise `J posts drop <url>`.',
  new_job: 'Review: does the work match the title. Warn, never drop except on a mismatch. Score 0 to 100.',
  review_due: 'The posting changed. Review again.',
  reverify_due: 'Verify the job is still open before it goes further.',
  contacts_requested: 'Find a contact with a source link, or say none was found.',
  prepare_due: 'Build the sheet, then have the writer draft the prose. Facts only from the profile.',
  apply_ready: 'Attended: show the sheet, wait for a yes. Never submit without it.',
  follow_up_due: 'Ask the person for the status. Do not contact the employer.',
};
const PERSON_HELD = ['guard_missing', 'chrome_disconnected', 'deepseek_on', 'update_waiting', 'update_failed', 'tenjin_missing', 'stopped'];

export function park(job, reasons) {
  const key = `${job.key}@${job.hash}`;
  const sorted = [...reasons].sort();
  if (job.parked && job.parked.key === key && JSON.stringify(job.parked.reasons) === JSON.stringify(sorted)) return false;
  job.parked = { key, reasons: sorted };
  return true;
}
export function unpark(job) {
  job.parked = null;
}

// The guard denies every MCP tool in an unattended batch, the request tool included, so the search waits.
export function unattendedBatchOpen() {
  const p = readJson(policyFile(), null);
  return Boolean(p && p.mode === 'unattended' && isActive());
}

export function searchDue(state, profile, now, { unattendedOpen = false } = {}) {
  if (unattendedOpen) return false;
  if (!profile.search || !profile.search.role) return false;
  if (state.held.some((h) => h.reason === 'tenjin_missing')) return false;
  const last = state.routed && state.routed.lastSearchAt ? Date.parse(state.routed.lastSearchAt) : null;
  if (last === null) return true;
  const elapsed = now - last;
  return elapsed >= 26 * HOUR || (elapsed >= 20 * HOUR && new Date(now).getHours() >= (profile.sweepHour ?? graph().sweep.defaultHour));
}

export function buildWorkList(state, overlay, now = Date.now(), profile = {}, opts = {}) {
  const items = [];
  if (searchDue(state, profile, now, opts)) {
    const last = state.routed.lastSearchAt;
    const since = last ? new Date(Math.max(Date.parse(last) - 86400000, now - 14 * 86400000)) : new Date(now - 14 * 86400000);
    items.push({ key: 'search', reason: 'search_due', title: 'Daily routed search', company: '', gate: GATES.search_due, query: { role: profile.search.role, place: profile.search.place || '', remote: profile.search.remote === true, since: since.toISOString().slice(0, 10) } });
  }
  for (const p of state.posts || []) if (p.status === 'new') items.push({ key: p.url, reason: 'post_review', title: p.text.slice(0, 80), company: p.author, gate: GATES.post_review });
  const inventory = [];
  const add = (j, reason) => items.push({ key: j.key, reason, title: j.title, company: j.company, gate: GATES[reason] });
  for (const j of Object.values(state.jobs)) {
    if (graph().terminal.includes(j.status)) continue;
    if (j.parked) {
      inventory.push({ key: j.key, title: j.title, company: j.company, parked: j.parked.reasons });
      continue;
    }
    if (j.status === 'new') {
      if (!(j.reviewedHash && j.reviewedHash === j.hash)) add(j, j.reviewedHash ? 'review_due' : 'new_job');
    }
    else if (j.status === 'shortlisted') add(j, 'prepare_due');
    else if (j.status === 'apply_ready') add(j, 'apply_ready');
    else if (j.status === 'submitted' && !j.followUpAsked && now - Date.parse(j.statusAt) > graph().followUpDays * DAY) add(j, 'follow_up_due');
    if (['reviewed', 'shortlisted', 'prepared', 'apply_ready'].includes(j.status) && now - Date.parse(j.verifiedAt) > graph().unattendedWindow.verifiedHours * HOUR) add(j, 'reverify_due');
  }
  for (const key of state.contactsRequested || []) if (state.jobs[key] && !(state.contacts[key] || []).length) add(state.jobs[key], 'contacts_requested');
  return {
    items,
    held: state.held,
    inventory,
    rules: (overlay.rules || []).map((r) => ({ id: r.id, effect: r.effect, value: r.value, words: r.words, date: r.date })),
    lessons: activeLessons(overlay, now).map((l) => ({ id: l.id, text: l.text, expires: l.expires })),
  };
}

// What waits on the person, as key -> signature. A parked item that did not change keeps the same signature.
export function waitingSet(state) {
  const w = {};
  for (const j of Object.values(state.jobs)) {
    if (graph().terminal.includes(j.status)) continue;
    if (j.parked) w[`park:${j.key}`] = `${j.parked.key}|${j.parked.reasons.join(',')}|${j.company}`;
    else if (j.status === 'apply_ready' && !state.approvals[j.key]) w[`yes:${j.key}`] = `${j.hash}|${j.company}`;
  }
  for (const h of state.held) if (PERSON_HELD.includes(h.reason)) w[`held:${h.reason}:${h.detail || ''}`] = h.reason;
  return w;
}

export function notifyLine(state, overlay, now = Date.now()) {
  const w = waitingSet(state);
  const fresh = Object.keys(w).filter((k) => state.notified[k] !== w[k]);
  if (!fresh.length) return { line: null, next: w };
  if (ruleValue(overlay, 'notify_off') !== undefined) return { line: null, next: w };
  const q = ruleValue(overlay, 'notify_quiet_hours');
  if (typeof q === 'string' && /^\d{1,2}-\d{1,2}$/.test(q)) {
    const [a, b] = q.split('-').map(Number);
    const h = new Date(now).getHours();
    const inQuiet = a <= b ? h >= a && h < b : h >= a || h < b;
    if (inQuiet) return { line: null, next: state.notified }; // keep unnotified, so it pushes after quiet hours
  }
  const yes = fresh.filter((k) => k.startsWith('yes:')).length;
  const stops = fresh.filter((k) => k.startsWith('park:'));
  const held = fresh.filter((k) => k.startsWith('held:')).map((k) => k.split(':')[1]);
  const parts = [];
  if (yes) parts.push(`${yes} application${yes > 1 ? 's' : ''} wait for your yes`);
  if (stops.length) {
    const j = state.jobs[stops[0].slice(5)];
    parts.push(`${stops.length} stop${stops.length > 1 ? 's' : ''} need you${stops.length === 1 && j ? ` at ${j.company}` : ''} (${j && j.parked ? j.parked.reasons[0].replace(/_/g, ' ') : 'parked'})`);
  }
  if (held.length) parts.push(`needs you: ${[...new Set(held)].join(', ').replace(/_/g, ' ')}`);
  let line = parts.join(', ').replace(/[*_`#\[\]]/g, '');
  if (line.length > 190) line = line.slice(0, 187) + '...';
  return { line, next: w };
}

// The work-list command. With commit, the notify line is marked as sent (at most once).
export function workList({ now = Date.now(), commit = false } = {}) {
  const staleBatchClosed = cleanupStale(now);
  const overlay = loadOverlay();
  let res;
  const compute = (state) => {
    const wl = buildWorkList(state, overlay, now, readJson(path.join(stateDir(), 'profile.json'), {}), { unattendedOpen: unattendedBatchOpen() });
    const n = notifyLine(state, overlay, now);
    wl.notify = n.line;
    if (commit) state.notified = n.next;
    return wl;
  };
  res = commit ? updateState(compute) : compute(loadState());
  res.exit = res.items.length ? 0 : 3;
  if (staleBatchClosed) res.staleBatchClosed = true;
  return res;
}
