import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ALIVE_MS, TICK_MS, beat, claimLease, heartbeat, leaseFresh, releaseLease } from './lease.mjs';
import { checkRelease, recordRelease } from './release.mjs';
import { SKILL_DIR, readJson, stateDir } from './paths.mjs';
import { loadState, updateState } from './store.mjs';
import { loadOverlay } from './overlay.mjs';
import { persist, runSweep, sweepDue } from './sweep.mjs';
import { claimActive, settleClaims, unclaimedDue, waitingSet, workList } from './work.mjs';
import { frequencyOf } from './schedule.mjs';
import { routedRounds } from './routed.mjs';
import { prepareInCode } from './prepare.mjs';
import { resolveBoardPosts } from './ingest.mjs';
import { logWake } from './runlog.mjs';
import { unattendedBatchOpen } from './work.mjs';
import { hnDue, runHn } from './hn.mjs';
import { ycDue, runYc } from './yc.mjs';

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
  if (startHash && startHash !== watcherCodeHash()) return { lines: [`restart: the watcher code changed, start J watch again`], stop: true };
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
  let ycPending = false;
  if (fetchImpl && ycDue(loadState(), profile, now)) {
    try {
      const r = await runYc({ fetch: fetchImpl, profile, state: loadState(), sleep: ctx.sleep, clock: ctx.clock, now });
      ycPending = r && r.remaining > 0;
    } catch (e) {
      updateState((st) => { st.held = [...st.held.filter((h) => !String(h.detail).startsWith('yc:')), { reason: 'source_empty', detail: `yc: ${e.message}` }]; st.yc = { ...(st.yc || {}), lastAt: new Date(now).toISOString() }; });
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
  // Claimed work is in flight: settle the claims (end the ones past their limit on a still-open item, drop the ones for items
  // no longer due), then read the list again, so a timed-out item carries its version change.
  { const before = workList({ now, commit: false }); updateState((st) => settleClaims(st, before.items, now)); }
  const wl = workList({ now, commit: false });
  const claimState = loadState();
  // Wake the model only for due work it can act on now. What waits for the person never wakes it (its one notification
  // is the notify line). The fingerprint of what was last sent is kept in state, so a restart or a re-arm repeats nothing,
  // and nothing repeats on a timer: it wakes when the due set gains an item or an item's version changes.
  const actionable = wl.items.filter((i) => !i.waitsForPerson && !claimActive(claimState, i, now));
  const tokens = actionable.map((i) => `${i.key}:${i.reason}:${i.v}`).sort();
  const st = loadState().watcher || { sent: [], fingerprint: null, notify: null };
  const fresh = tokens.filter((t) => !st.sent.includes(t));
  const newNotify = Boolean(wl.notify && wl.notify !== st.notify);
  // One wake per round, at its end. While code is still reading (Hacker News in chunks) the round is open: nothing is sent,
  // and the fingerprint stays as it was, so the same items wake the model when the round ends. A notify line rides an
  // actionable wake. A wake for the line alone comes at most once per round, only for a changed waiting set, and never
  // after a push that came back "not sent" (until the person's next turn): then the line waits for the next wake and the report.
  const s1 = loadState();
  const mark = `${s1.sweep.lastAt || ''}|${(s1.routed || {}).lastSearchAt || ''}|${(s1.hn || {}).lastAt || ''}|${(s1.yc || {}).lastAt || ''}`;
  const wsNow = waitingSet(s1);
  const wsPrev = st.waiting || {};
  // a set that only shrinks changes nothing, and an update line never wakes the session on its own (it rides on the next wake)
  const gained = Object.keys(wsNow).some((k) => !k.startsWith('update:') && wsPrev[k] !== wsNow[k]);
  // The push's own answer decides (J notify result): "not sent" stops notify-only wakes until the person's next turn; an
  // answer that cannot tell leaves them only for items that block work (a stop, a held item, a consent to give).
  const res = st.notifyResult || null;
  const blocking = Object.keys(wsNow).some((k) => wsPrev[k] !== wsNow[k] && /^(park|held|consent|facts):/.test(k));
  const notifyOnly = !fresh.length && newNotify && gained && res !== 'not_sent' && (res !== 'unknown' || blocking) && (st.notifyMark || null) !== mark;
  if (hnPending || ycPending) return { lines, stop: false };
  if (fresh.length || notifyOnly) {
    const counts = {};
    for (const i of actionable.filter((x) => fresh.includes(`${x.key}:${x.reason}:${x.v}`))) counts[i.reason] = (counts[i.reason] || 0) + 1;
    updateState((state) => logWake(state, counts, newNotify, now));
    lines.push(`job-search: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'waiting on you'}${newNotify ? `; notify: ${wl.notify}` : ''}. Run: jobs.mjs work`);
  }
  const sent = newNotify && (fresh.length || notifyOnly);
  updateState((state) => {
    state.watcher = { ...(state.watcher || {}), sent: tokens, fingerprint: tokens.join('|'), notify: wl.notify ? (sent ? wl.notify : st.notify || null) : null, notifyMark: sent ? mark : st.notifyMark || null, waiting: sent ? wsNow : wl.notifyQuiet ? wsPrev : !gained || !newNotify ? wsNow : wsPrev };
  });
  return { lines, stop: false };
}

// The watcher host: a background command that exits when work is due (v0). It ticks as before, prints one line naming the due
// work only when an actionable wake is due under the wake rules, and the exit is what wakes the session. It never exits
// because of time, and it keeps ticking with no output on a quiet state. A restarted watcher reads the stored fingerprint, so
// it does not exit again for the same due set. A second watcher exits at once when another holds the lease.
export async function runWatcher({ holder = Math.random().toString(36).slice(2, 10), pid = process.pid, fetchImpl, runner, write = (l) => process.stdout.write(`${l}\n`), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tickMs = Number(process.env.JOB_SEARCH_TICK_MS) || TICK_MS, maxTicks = Infinity, ctx = {}, clock = () => Date.now(), timer = (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return () => clearInterval(t); }, tickImpl = tick } = {}) {
  // Code holds the restart rule: the watcher starts only as the last step of the turn. While any actionable due item is
  // unclaimed, it refuses with one line naming them, so a watcher started in the middle of a round cannot see the round's
  // own new items as new work.
  { const cur = loadState().lease;
    if (cur && leaseFresh(cur, clock()) && cur.holder !== holder) {
      write('another session holds the lease; work attended');
      return { exit: 0, reason: 'lease_held' };
    }
    const st = loadState(); const wl = workList({ now: clock(), commit: false }); const open = unclaimedDue(st, wl.items, clock());
    if (open.length) {
      const names = {};
      for (const i of open) names[i.reason] = (names[i.reason] || 0) + 1;
      write(`not started: ${Object.entries(names).map(([k, n]) => `${n} ${k}`).join(', ')} due and not handed out; run J work --commit, hand them out, then start J watch last`);
      return { exit: 0, reason: 'unclaimed', open: open.map((i) => i.key) };
    } }
  const claim = await claimLease({ holder, pid, now: clock() });
  if (!claim.ok) {
    write('another session holds the lease; work attended');
    return { exit: 0, reason: 'lease_held' };
  }
  updateState((s) => { s.watcherEver = true; });
  write('watching; exits when work is due');
  // The liveness field is refreshed from a timer that keeps running through a long tick: the work is async, so the timer
  // fires while a tick waits on slow providers, and the watcher never looks stopped (and is never started twice).
  const stopTimer = timer(() => { try { beat(holder, clock()); } catch {} }, ALIVE_MS);
  try {
    const startHash = watcherCodeHash();
    for (let i = 0, first = true; i < maxTicks; i++, first = false) {
      const r = await tickImpl({ holder, fetchImpl, runner, firstTick: first, seen: { sig: null }, startHash, now: clock(), ...ctx });
      for (const l of r.lines) write(l);
      if (r.stop) return { exit: 0, reason: 'stop', lines: r.lines };
      if (r.lines.length) {
        releaseLease(holder); // the session restarts it after the round
        return { exit: 0, reason: 'due', lines: r.lines };
      }
      await sleep(tickMs);
    }
    releaseLease(holder);
    return { exit: 0, reason: 'max_ticks' };
  } finally {
    stopTimer();
  }
}
