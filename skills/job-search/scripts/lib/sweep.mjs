import { graph } from './graph.mjs';
import { fetchBoard } from './boards.mjs';
import { mergeJobs, normalizeUrl } from './dedupe.mjs';
import { effectiveProfile } from './overlay.mjs';
import { lookupEmployer } from './registry.mjs';
import { screenJob } from './verify.mjs';
import { updateState } from './store.mjs';

const HOUR = 3600000;

// When is a sweep due? The first tick after a gap catches up; after that it runs once a day at the chosen hour.
export function sweepDue(state, now, { hour = graph().sweep.defaultHour, firstTick = false } = {}) {
  const last = state.sweep.lastAt ? Date.parse(state.sweep.lastAt) : null;
  if (last === null) return true;
  const elapsed = now - last;
  if (firstTick && elapsed > graph().sweep.catchUpAfterHours * HOUR) return true;
  if (elapsed >= 26 * HOUR) return true;
  return elapsed >= graph().sweep.catchUpAfterHours * HOUR && new Date(now).getHours() >= hour;
}

// Sources reach back 7 to 14 days; a missed day loses nothing. Capped at 14 days.
export function catchUpDays(state, now, fallback = 14) {
  if (!state.sweep.lastAt) return fallback;
  const days = Math.ceil((now - Date.parse(state.sweep.lastAt)) / (24 * HOUR)) + 1;
  return Math.min(Math.max(days, 2), graph().sweep.maxCatchUpDays);
}

export function resolveWatchList(profile, { registryFile } = {}) {
  const out = [];
  const unresolved = [];
  for (const w of profile.watch || []) {
    if (w.token && w.ats) {
      out.push({ name: w.name, ats: w.ats, token: w.token, region: w.region || 'us' });
      continue;
    }
    const hits = lookupEmployer(w.name, { file: registryFile }).filter((h) => graph().hosts.includes(h.ats));
    if (!hits.length) unresolved.push(w.name);
    for (const h of hits) out.push({ name: h.name, ats: h.ats, token: h.token, region: h.region });
  }
  return { entries: out.slice(0, graph().sweep.maxBoards), unresolved };
}

// Reads the free boards in turn. Pure with respect to state: returns a payload for persist.
export async function runSweep({ state, profile, overlay, fetch, now = Date.now(), registryFile }) {
  const eff = effectiveProfile(profile, overlay);
  eff.windowDays = catchUpDays(state, now, profile.windowDays || 14);
  const { entries, unresolved } = resolveWatchList(profile, { registryFile });
  const jobs = [];
  const dropped = [];
  const held = [];
  const closedKeys = [];
  const sources = {};
  for (const name of unresolved) held.push({ reason: 'source_empty', detail: `${name}: no board token found, add one` });
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
    for (const j of Object.values(state.jobs)) if (j.board === id && !present.has(j.key)) closedKeys.push(j.key);
    for (const j of res.jobs) {
      const screen = screenJob(j, eff, overlay, now);
      if (screen.drop.length) {
        dropped.push({ url: j.url, reasons: screen.drop });
        continue;
      }
      jobs.push({ ...j, warnings: screen.warnings });
    }
  }
  return { at: new Date(now).toISOString(), jobs, dropped, held, closedKeys, sources };
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
        j.statusAt = payload.at;
        closed.push(k);
      } else j.warnings = [...new Set([...(j.warnings || []), 'closed on its board'])];
    }
    state.sources = { ...state.sources, ...payload.sources };
    state.held = [...state.held.filter((h) => h.reason !== 'source_empty'), ...(payload.held || [])];
    state.sweep.lastAt = payload.at;
    for (const [q, n] of Object.entries(payload.queries || {})) {
      const y = (state.queryYield[q] ||= { dry: 0 });
      y.dry = n > 0 ? 0 : y.dry + 1;
    }
    return { added: added.length, closed: closed.length };
  });
}
