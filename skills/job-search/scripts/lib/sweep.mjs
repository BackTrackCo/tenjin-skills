import { graph } from './graph.mjs';
import { fetchBoard, parseCareersUrl } from './boards.mjs';
import { mergeJobs, normalizeUrl } from './dedupe.mjs';
import { effectiveProfile } from './overlay.mjs';
import { screenJob, titleMatchesRole } from './verify.mjs';
import { frequencyOf, searchIsDue } from './schedule.mjs';
import { bump, updateState } from './store.mjs';

const HOUR = 3600000;

// When is a sweep due? The first tick after a gap catches up; after that it follows the person's search frequency.
export function sweepDue(state, now, { hour = graph().sweep.defaultHour, firstTick = false, frequency = 'daily' } = {}) {
  const last = state.sweep.lastAt ? Date.parse(state.sweep.lastAt) : null;
  if (last === null) return true;
  if (firstTick && frequency === 'daily' && now - last > graph().sweep.catchUpAfterHours * HOUR) return true;
  return searchIsDue({ lastAt: last, now, frequency, hour });
}

// Sources reach back 7 to 14 days; a missed day loses nothing. Capped at 14 days.
export function catchUpDays(state, now, fallback = 14) {
  if (!state.sweep.lastAt) return fallback;
  const days = Math.ceil((now - Date.parse(state.sweep.lastAt)) / (24 * HOUR)) + 1;
  return Math.min(Math.max(days, 2), graph().sweep.maxCatchUpDays);
}

// Watched companies are careers URLs the person pastes: [{url, name?}]. No cap.
export function resolveWatchList(profile, state = null) {
  const entries = [];
  const unresolved = [];
  const seen = new Set();
  for (const w of profile.watch || []) {
    const p = w.url ? parseCareersUrl(w.url) : w.ats && w.token ? { ats: w.ats, token: w.token, region: w.region || 'us' } : null;
    if (!p || p.needsBoard || !graph().hosts.includes(p.ats)) {
      unresolved.push(w.name || w.url || 'a watched company');
      continue;
    }
    const id = `${p.ats}:${p.region}:${p.token}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ name: w.name || p.token, ats: p.ats, token: p.token, region: p.region || 'us' });
  }
  // Boards the skill found itself (a job passed review with an exact or confirmed posting) join the list, no cap.
  for (const b of (state && state.found) || []) {
    const id = `${b.ats}:${b.region || 'us'}:${b.token}`;
    if (seen.has(id) || (state.removedBoards || []).includes(b.board)) continue;
    seen.add(id);
    entries.push({ name: b.name, ats: b.ats, token: b.token, region: b.region || 'us', found: true });
  }
  return { entries, unresolved };
}

// Reads the free boards in turn. Pure with respect to state: returns a payload for persist.
export async function runSweep({ state, profile, overlay, fetch, now = Date.now() }) {
  const eff = effectiveProfile(profile, overlay);
  eff.windowDays = catchUpDays(state, now, profile.windowDays || 14);
  const { entries, unresolved } = resolveWatchList(profile, state);
  const jobs = [];
  const dropped = [];
  const held = [];
  const closedKeys = [];
  const sources = {};
  const foundSeen = [];
  for (const name of unresolved) held.push({ reason: 'source_empty', detail: `${name}: no board link found, paste the board link (Greenhouse, Lever or Ashby careers page)` });
  for (const e of entries) {
    const id = `${e.ats}:${e.token}`;
    const res = await fetchBoard(e, fetch);
    if (!res.ok) {
      held.push({ reason: 'source_empty', detail: `${e.name} (${id}): ${res.reason}` });
      sources[id] = { ok: false, reason: res.reason, at: new Date(now).toISOString() };
      continue;
    }
    sources[id] = { ok: true, count: res.jobs.length, at: new Date(now).toISOString() };
    const present = new Set(res.jobs.map((j) => normalizeUrl(j.url)));
    if (e.found && res.jobs.some((j) => titleMatchesRole(j.title, eff))) foundSeen.push(`${e.ats}:${e.token}`);
    for (const j of Object.values(state.jobs)) if (j.board === id && !present.has(j.key)) closedKeys.push(j.key);
    for (const j of res.jobs) {
      const screen = screenJob(j, eff, overlay, now, { source: 'watched' });
      if (screen.drop.length) {
        dropped.push({ url: j.url, reasons: screen.drop });
        continue;
      }
      jobs.push({ ...j, warnings: screen.warnings });
    }
  }
  const dropCounts = {};
  for (const d of dropped) for (const r of d.reasons) dropCounts[r.replace(/:.*/, '')] = (dropCounts[r.replace(/:.*/, '')] || 0) + 1;
  return { at: new Date(now).toISOString(), jobs, dropped, held, closedKeys, sources, dropCounts, foundSeen };
}

// Writes a sweep's output. Closed means absent from the board's list.
export function persist(payload) {
  return updateState((state) => {
    const added = mergeJobs(state, payload.jobs, payload.at);
    const closed = [];
    for (const k of payload.closedKeys || []) {
      const j = state.jobs[k];
      if (!j) continue;
      if (graph().transitions[j.status] && graph().transitions[j.status].includes('closed')) {
        j.status = 'closed';
        bump(j);
        j.statusAt = payload.at;
        closed.push(k);
      } else j.warnings = [...new Set([...(j.warnings || []), 'closed on its board'])];
    }
    state.sources = { ...state.sources, ...payload.sources };
    // A found board with no job in the role for 90 days drops off, with a line in the report. A pasted board never does.
    for (const b of state.found || []) if ((payload.foundSeen || []).includes(b.board)) b.lastRoleJobAt = payload.at;
    const keep = [];
    for (const b of state.found || []) {
      if (Date.parse(payload.at) - Date.parse(b.lastRoleJobAt || b.date) > 90 * 86400000) (state.dropLines ||= []).push(`Dropped ${b.name} (${b.board}) from the watch list: no job in your role for 90 days.`);
      else keep.push(b);
    }
    state.found = keep;
    state.lastSweep = { at: payload.at, kept: (payload.jobs || []).length, dropCounts: payload.dropCounts || {} };
    state.watched = { checked: Object.keys(payload.sources || {}).length, ok: Object.values(payload.sources || {}).filter((x) => x.ok).length, at: payload.at };
    state.held = [...state.held.filter((h) => !(h.reason === 'source_empty' && !String(h.detail).startsWith('routed:'))), ...(payload.held || [])];
    state.sweep.lastAt = payload.at;
    for (const [q, n] of Object.entries(payload.queries || {})) {
      const y = (state.queryYield[q] ||= { dry: 0 });
      y.dry = n > 0 ? 0 : y.dry + 1;
    }
    return { added: added.length, closed: closed.length };
  });
}
