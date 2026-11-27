import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ALIVE_MS, TICK_MS, beat, claimLease, heartbeat, leaseFresh, releaseLease } from './lease.mjs';
import { checkRelease, recordRelease } from './release.mjs';
import { SKILL_DIR } from './paths.mjs';
import { loadState, updateState } from './store.mjs';
import { readProfile } from './profile.mjs';
import { claimActive, notifyLine, settleClaims, unclaimedDue, waitingSet, workList } from './work.mjs';
import { logWake } from './runlog.mjs';

const DAY = 86400000;

// The files whose change makes a running watcher stop, so a session never keeps old code ticking.
export const WATCH_FILES = ['scripts/gtm.mjs', 'scripts/lib/watcher.mjs', 'scripts/lib/work.mjs', 'scripts/lib/routed.mjs', 'scripts/lib/ingest.mjs', 'scripts/lib/email.mjs'];
export function watcherCodeHash() {
  const h = crypto.createHash('sha256');
  for (const f of WATCH_FILES) {
    try {
      h.update(fs.readFileSync(path.join(SKILL_DIR, f)));
    } catch {}
  }
  return h.digest('hex');
}

// Step functions the watcher runs each tick, in order, before the work list is read. Each takes the tick context and may change
// state; a step that throws holds its own detail and never ends the watcher.
const steps = [];
export const registerStep = (name, fn) => steps.push({ name, fn });

// One tick: heartbeat, the steps, a release check once a day, then say something only if work is due.
export async function tick(ctx) {
  const { holder, now = Date.now(), fetchImpl, runner, startHash } = ctx;
  const lines = [];
  if (!heartbeat(holder, now)) return { lines: ['lease lost: run /gtm-loop again to re-arm'], stop: true };
  if (startHash && startHash !== watcherCodeHash()) return { lines: ['restart: the watcher code changed, start G watch again'], stop: true };
  const profile = readProfile();
  for (const s of steps) {
    try {
      await s.fn({ ...ctx, profile, now, fetchImpl });
    } catch (e) {
      updateState((st) => { st.held = [...st.held.filter((h) => !String(h.detail).startsWith(`${s.name}:`)), { reason: 'source_empty', detail: `${s.name}: ${e.message}` }]; });
    }
  }
  const s2 = loadState();
  if (profile.updates !== false && fetchImpl && (!s2.update.lastCheckAt || now - Date.parse(s2.update.lastCheckAt) >= DAY)) {
    recordRelease(await checkRelease({ fetchImpl, runner, now }), now);
  }
  { const before = workList({ now, commit: false }); updateState((st) => settleClaims(st, before.items, now)); }
  const wl = workList({ now, commit: false });
  const claimState = loadState();
  // Wake the model only for due work it can act on now. What waits for the person never wakes it (its one notification is the
  // notify line). The fingerprint of what was last sent is kept in state, so a restart or a re-arm repeats nothing, and nothing
  // repeats on a timer: it wakes when the due set gains an item or an item's version changes.
  const act = wl.items.filter((i) => !i.waitsForPerson && !claimActive(claimState, i, now));
  const tokens = act.map((i) => `${i.key}:${i.reason}:${i.v}`).sort();
  const st = loadState().watcher || { sent: [], fingerprint: null, notify: null };
  const fresh = tokens.filter((t) => !st.sent.includes(t));
  const notify = notifyLine(wl.items);
  const newNotify = Boolean(notify && notify !== st.notify);
  const wsNow = waitingSet(loadState(), now);
  const wsPrev = st.waiting || {};
  const gained = Object.keys(wsNow).some((k) => !k.startsWith('update_waiting:') && wsPrev[k] !== wsNow[k]);
  const res = st.notifyResult || null;
  const notifyOnly = !fresh.length && newNotify && gained && res !== 'not_sent';
  if (fresh.length || notifyOnly) {
    const counts = {};
    for (const i of act.filter((x) => fresh.includes(`${x.key}:${x.reason}:${x.v}`))) counts[i.reason] = (counts[i.reason] || 0) + (i.count || 1);
    updateState((state) => logWake(state, counts, newNotify, now));
    lines.push(`GTM Loop round: run G work --commit --unattended (G is node ${path.join(SKILL_DIR, 'scripts', 'gtm.mjs')}), handle each item, then start G watch last with run_in_background. Due: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'waiting on you'}${newNotify ? `; notify: ${notify}` : ''}.`);
  }
  const sent = newNotify && (fresh.length || notifyOnly);
  updateState((state) => {
    state.watcher = { ...(state.watcher || {}), sent: tokens, fingerprint: tokens.join('|'), notify: notify ? (sent ? notify : st.notify || null) : null, waiting: sent ? wsNow : !gained || !newNotify ? wsNow : wsPrev };
  });
  return { lines, stop: false };
}

// The watcher host: a background command that exits when work is due. It ticks, prints one line naming the due work only when an
// actionable wake is due, and the exit is what wakes the session. It never exits because of time. A restarted watcher reads the
// stored fingerprint, so it does not exit again for the same due set. A second watcher exits at once when another holds the lease.
export async function runWatcher({ holder = Math.random().toString(36).slice(2, 10), pid = process.pid, fetchImpl, runner, write = (l) => process.stdout.write(`${l}\n`), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tickMs = Number(process.env.GTM_LOOP_TICK_MS) || TICK_MS, maxTicks = Infinity, ctx = {}, clock = () => Date.now(), timer = (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return () => clearInterval(t); }, tickImpl = tick } = {}) {
  // The watcher starts only as the last step of the turn. While any actionable due item is unclaimed it refuses with one line.
  { const cur = loadState().lease;
    if (cur && leaseFresh(cur, clock()) && cur.holder !== holder) {
      write('another session holds the lease; work attended');
      return { exit: 0, reason: 'lease_held' };
    }
    const st = loadState();
    const wl = workList({ now: clock(), commit: false });
    const open = unclaimedDue(st, wl.items, clock());
    if (open.length) {
      const names = {};
      for (const i of open) names[i.reason] = (names[i.reason] || 0) + 1;
      write(`not started: ${Object.entries(names).map(([k, n]) => `${n} ${k}`).join(', ')} due and not handed out; run G work --commit, hand them out, then start G watch last`);
      return { exit: 0, reason: 'unclaimed', open: open.map((i) => i.key) };
    } }
  const claim = await claimLease({ holder, pid, now: clock() });
  if (!claim.ok) {
    write('another session holds the lease; work attended');
    return { exit: 0, reason: 'lease_held' };
  }
  updateState((s) => { s.watcherEver = true; });
  write('watching; exits when work is due');
  // The liveness field is refreshed from a timer that keeps running through a long tick, so the watcher never looks stopped.
  const stopTimer = timer(() => { try { beat(holder, clock()); } catch {} }, ALIVE_MS);
  try {
    const startHash = watcherCodeHash();
    for (let i = 0, first = true; i < maxTicks; i++, first = false) {
      const r = await tickImpl({ holder, fetchImpl, runner, firstTick: first, startHash, now: clock(), ...ctx });
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
