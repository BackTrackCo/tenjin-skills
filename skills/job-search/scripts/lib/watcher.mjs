import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { heartbeat } from './lease.mjs';
import { checkRelease, recordRelease } from './release.mjs';
import { SKILL_DIR, readJson, stateDir } from './paths.mjs';
import { loadState, updateState } from './store.mjs';
import { loadOverlay } from './overlay.mjs';
import { persist, runSweep, sweepDue } from './sweep.mjs';
import { workList } from './work.mjs';
import { hnDue, runHn } from './hn.mjs';

const DAY = 86400000;

export const readProfile = () => readJson(path.join(stateDir(), 'profile.json'), {});

export function watcherCodeHash() {
  const h = crypto.createHash('sha256');
  for (const f of ['scripts/jobs.mjs', 'scripts/lib/watcher.mjs', 'scripts/lib/sweep.mjs', 'scripts/lib/work.mjs']) h.update(fs.readFileSync(path.join(SKILL_DIR, f)));
  return h.digest('hex');
}

// One tick: heartbeat, sweep when due, release check once a day, then say something only if work is due.
// Returns the lines to print. A quiet tick returns none.
export async function tick(ctx) {
  const { holder, now = Date.now(), fetchImpl, runner, firstTick = false, seen = { sig: null }, startHash } = ctx;
  const lines = [];
  if (!heartbeat(holder, now)) return { lines: ['lease lost: run /job-search again to re-arm'], stop: true };
  if (startHash && startHash !== watcherCodeHash()) return { lines: [`re-armed: the watcher code changed, run the Monitor command from jobs.mjs arm again`], stop: true };
  const profile = readProfile();
  const state = loadState();
  if ((profile.watch || []).length && sweepDue(state, now, { hour: profile.sweepHour, firstTick })) {
    const payload = await runSweep({ state, profile, overlay: loadOverlay(), fetch: fetchImpl, now });
    persist(payload);
  }
  if (fetchImpl && hnDue(loadState(), profile, now)) {
    try {
      await runHn({ fetch: fetchImpl, profile, state: loadState(), budgetMs: ctx.hnBudgetMs || 60_000, sleep: ctx.sleep, clock: ctx.clock, now });
    } catch (e) {
      updateState((st) => { st.held = [...st.held.filter((h) => !String(h.detail).startsWith('hn:')), { reason: 'source_empty', detail: `hn: ${e.message}` }]; st.hn = { ...(st.hn || {}), lastAt: new Date(now).toISOString() }; });
    }
  }
  const s2 = loadState();
  if (profile.updates !== false && fetchImpl && (!s2.update.lastCheckAt || now - Date.parse(s2.update.lastCheckAt) >= DAY)) {
    const result = await checkRelease({ fetchImpl, runner, now });
    recordRelease(result, now);
    if (result.line) lines.push(result.line);
  }
  const wl = workList({ now, commit: false });
  const sig = JSON.stringify([wl.items.map((i) => `${i.key}:${i.reason}`), wl.notify]);
  if ((wl.items.length || wl.notify) && sig !== seen.sig) {
    seen.sig = sig;
    const counts = {};
    for (const i of wl.items) counts[i.reason] = (counts[i.reason] || 0) + 1;
    lines.push(`job-search: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'waiting on you'}${wl.notify ? `; notify: ${wl.notify}` : ''}. Run: jobs.mjs work`);
  } else if (!wl.items.length && !wl.notify) seen.sig = null;
  return { lines, stop: false };
}
