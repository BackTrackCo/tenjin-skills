import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { heartbeat } from './lease.mjs';
import { checkRelease, recordRelease } from './release.mjs';
import { SKILL_DIR, readJson, stateDir } from './paths.mjs';
import { loadState, updateState } from './store.mjs';
import { loadOverlay } from './overlay.mjs';
import { persist, runSweep, sweepDue } from './sweep.mjs';
import { waitingSet, workList } from './work.mjs';
import { frequencyOf } from './schedule.mjs';
import { routedRounds } from './routed.mjs';
import { prepareInCode } from './prepare.mjs';
import { resolveBoardPosts } from './ingest.mjs';
import { logWake } from './runlog.mjs';
import { unattendedBatchOpen } from './work.mjs';
import { hnDue, runHn } from './hn.mjs';

const DAY = 86400000;

export const readProfile = () => readJson(path.join(stateDir(), 'profile.json'), {});

export function watcherCodeHash() {
  const h = crypto.createHash('sha256');
  for (const f of ['scripts/jobs.mjs', 'scripts/lib/watcher.mjs', 'scripts/lib/sweep.mjs', 'scripts/lib/work.mjs', 'scripts/lib/routed.mjs', 'scripts/lib/prepare.mjs', 'scripts/lib/ingest.mjs']) h.update(fs.readFileSync(path.join(SKILL_DIR, f)));
  return h.digest('hex');
}

// One tick: heartbeat, sweep when due, release check once a day, then say something only if work is due.
// Returns the lines to print. A quiet tick returns none.
export async function tick(ctx) {
  const { holder, now = Date.now(), fetchImpl, runner, firstTick = false, seen = { sig: null }, startHash } = ctx;
  void ctx.routerClient;
  const lines = [];
  if (!heartbeat(holder, now)) return { lines: ['lease lost: run /job-search again to re-arm'], stop: true };
  if (startHash && startHash !== watcherCodeHash()) return { lines: [`re-armed: the watcher code changed, run the Monitor command from jobs.mjs arm again`], stop: true };
  const profile = readProfile();
  const state = loadState();
  if ((profile.watch || []).length && sweepDue(state, now, { hour: profile.sweepHour, firstTick, frequency: frequencyOf(profile) })) {
    const payload = await runSweep({ state, profile, overlay: loadOverlay(), fetch: fetchImpl, now });
    persist(payload);
  }
  let hnPending = false;
  if (fetchImpl && hnDue(loadState(), profile, now)) {
    try {
      const r = await runHn({ fetch: fetchImpl, profile, state: loadState(), budgetMs: ctx.hnBudgetMs || 60_000, sleep: ctx.sleep, clock: ctx.clock, now });
      hnPending = r && r.remaining > 0; // the round is not over: code is still reading
    } catch (e) {
      updateState((st) => { st.held = [...st.held.filter((h) => !String(h.detail).startsWith('hn:')), { reason: 'source_empty', detail: `hn: ${e.message}` }]; st.hn = { ...(st.hn || {}), lastAt: new Date(now).toISOString() }; });
    }
  }
  // With Tenjin ready, the search rounds run in code, never inside an open unattended batch.
  if (fetchImpl && profile.search && profile.search.role && (loadState().tenjin || {}).status === 'ready' && !unattendedBatchOpen()) {
    try {
      await routedRounds({ profile, fetch: fetchImpl, now, client: ctx.routerClient });
    } catch (e) {
      updateState((st) => { st.held = [...st.held.filter((h) => !String(h.detail).startsWith('routed:run')), { reason: 'source_empty', detail: `routed:run: ${e.message}` }]; });
    }
  }
  const s2 = loadState();
  if (profile.updates !== false && fetchImpl && (!s2.update.lastCheckAt || now - Date.parse(s2.update.lastCheckAt) >= DAY)) {
    const result = await checkRelease({ fetchImpl, runner, now });
    recordRelease(result, now); // the line goes to the report and the notify set, with no wake of its own
  }
  // Mechanics in code before the work list is read: a post with a board link becomes a posting, and a sheet with no new
  // writing goes straight to apply_ready. Only what is left needs a model.
  if (fetchImpl) {
    try {
      await resolveBoardPosts({ profile, overlay: loadOverlay(), fetch: fetchImpl, now });
      await prepareInCode({ fetch: fetchImpl, profile });
    } catch (e) {
      updateState((st) => { st.held = [...st.held.filter((h) => !String(h.detail).startsWith('code:')), { reason: 'source_empty', detail: `code: ${e.message}` }]; });
    }
  }
  const wl = workList({ now, commit: false });
  // Wake the model only for due work it can act on now. What waits for the person never wakes it (its one notification
  // is the notify line). The fingerprint of what was last sent is kept in state, so a restart or a re-arm repeats nothing,
  // and nothing repeats on a timer: it wakes when the due set gains an item or an item's version changes.
  const actionable = wl.items.filter((i) => !i.waitsForPerson);
  const tokens = actionable.map((i) => `${i.key}:${i.reason}:${i.v}`).sort();
  const st = loadState().watcher || { sent: [], fingerprint: null, notify: null };
  const fresh = tokens.filter((t) => !st.sent.includes(t));
  const newNotify = Boolean(wl.notify && wl.notify !== st.notify);
  // One wake per round, at its end. While code is still reading (Hacker News in chunks) the round is open: nothing is sent,
  // and the fingerprint stays as it was, so the same items wake the model when the round ends. A notify line rides an
  // actionable wake. A wake for the line alone comes at most once per round, only for a changed waiting set, and never
  // after "Not now" to Remote Control at the start: then the line waits for the next wake and the report.
  const s1 = loadState();
  const mark = `${s1.sweep.lastAt || ''}|${(s1.routed || {}).lastSearchAt || ''}|${(s1.hn || {}).lastAt || ''}`;
  const notRemote = ((s1.start || {}).remoteControl || '') === 'later';
  const wsNow = waitingSet(s1);
  const wsPrev = st.waiting || {};
  const gained = Object.keys(wsNow).some((k) => wsPrev[k] !== wsNow[k]); // a set that only shrinks changes nothing
  const notifyOnly = !fresh.length && newNotify && gained && !notRemote && (st.notifyMark || null) !== mark;
  if (hnPending) return { lines, stop: false };
  if (fresh.length || notifyOnly) {
    const counts = {};
    for (const i of actionable.filter((x) => fresh.includes(`${x.key}:${x.reason}:${x.v}`))) counts[i.reason] = (counts[i.reason] || 0) + 1;
    updateState((state) => logWake(state, counts, newNotify, now));
    lines.push(`job-search: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'waiting on you'}${newNotify ? `; notify: ${wl.notify}` : ''}. Run: jobs.mjs work`);
  }
  const sent = newNotify && (fresh.length || notifyOnly);
  updateState((state) => {
    state.watcher = { sent: tokens, fingerprint: tokens.join('|'), notify: wl.notify ? (sent ? wl.notify : st.notify || null) : null, notifyMark: sent ? mark : st.notifyMark || null, waiting: sent || !gained || !newNotify ? wsNow : wsPrev };
  });
  return { lines, stop: false };
}
