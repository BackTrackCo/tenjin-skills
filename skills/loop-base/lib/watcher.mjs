import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getApp } from './app.mjs';
import { ALIVE_MS, TICK_MS, beat, claimLease, heartbeat, leaseFresh, releaseLease } from './lease.mjs';
import { logWake } from './runlog.mjs';
import { loadState, updateState } from './store.mjs';
import { actionableTokens, fingerprint, settleClaims, unclaimedDue, waitingSet } from './work.mjs';

// The watcher: a background command that exits when work is due. The app declares its steps and what the frame needs to read:
//   steps: [{ name, due(ctx), run(ctx), catch, onError(error, ctx) }]       run in this order every tick
//   watcher: { codeFiles: [paths from the skill folder], readProfile(), blocking: /^(park|held):/, wakeLine({ counts, notify, newNotify }),
//              rearm: 'text after "lease lost: "', commands: { work: 'the command that hands work out', watch: 'the command that starts the watcher' } }
//   work: { list({ now, commit }) -> { items, notify, notifyQuiet }, roundMark(state) }
// A step's `run` may return { pending: true }: the round is not over (code is still reading), so no wake is sent yet. A step with
// `catch: true` that throws goes to its `onError` and the tick goes on; with `catch: false` the error ends the tick. It never exits
// because of time, and it keeps ticking with no output on a quiet state. A restarted watcher reads the stored fingerprint, so it does
// not exit again for the same due set. A second watcher exits at once when another holds the lease.
const decl = () => {
  const a = getApp();
  if (!Array.isArray(a.steps) || !a.watcher || !a.work || typeof a.work.list !== 'function') throw new Error(`the app ${a.name} has not declared its watcher steps`);
  return { steps: a.steps, watcher: a.watcher, work: a.work };
};

export const tickMsOf = () => Number(process.env[`${getApp().envPrefix}_TICK_MS`]) || TICK_MS;

// A change to any of the app's watcher code files restarts the watcher: the hash is read at start and at every tick.
export function codeHash() {
  const h = crypto.createHash('sha256');
  for (const f of decl().watcher.codeFiles) h.update(fs.readFileSync(path.join(getApp().skillDir, f)));
  return h.digest('hex');
}

// One tick: heartbeat, the code check, the app's steps in order, then say something only if work is due.
// Returns the lines to print. A quiet tick returns none.
export async function tick(ctx) {
  const { steps, watcher, work } = decl();
  const { holder, now = Date.now(), startHash } = ctx;
  const lines = [];
  if (!heartbeat(holder, now)) return { lines: [`lease lost: ${watcher.rearm}`], stop: true };
  if (startHash && startHash !== codeHash()) return { lines: [`restart: the watcher code changed, start ${watcher.commands.watch} again`], stop: true };
  const sc = { ...ctx, now, profile: watcher.readProfile() };
  let pending = false;
  for (const step of steps) {
    if (typeof step.due === 'function' && !step.due(sc)) continue;
    try {
      const r = await step.run(sc);
      if (r && r.pending) pending = true;
    } catch (e) {
      if (step.catch !== true) throw e;
      if (typeof step.onError === 'function') step.onError(e, sc);
    }
  }
  // Claimed work is in flight: settle the claims (end the ones past their limit on a still-open item, drop the ones for items
  // no longer due), then read the list again, so a timed-out item carries its version change.
  { const before = work.list({ now, commit: false }); updateState((st) => settleClaims(st, before.items, now)); }
  const wl = work.list({ now, commit: false });
  const claimState = loadState();
  // Wake the model only for due work it can act on now. What waits for the person never wakes it (its one notification is the notify
  // line). The fingerprint of what was last sent is kept in state, so a restart or a re-arm repeats nothing, and nothing repeats on a
  // timer: it wakes when the due set gains an item or an item's version changes.
  const tokens = actionableTokens(claimState, wl.items, now);
  const st = loadState().watcher || { sent: [], fingerprint: null, notify: null };
  const fresh = tokens.filter((t) => !st.sent.includes(t));
  const newNotify = Boolean(wl.notify && wl.notify !== st.notify);
  // One wake per round, at its end. While code is still reading (in chunks) the round is open: nothing is sent, and the fingerprint
  // stays as it was, so the same items wake the model when the round ends. A notify line rides an actionable wake. A wake for the line
  // alone comes at most once per round, only for a changed waiting set, and never after a push that came back "not sent" (until the
  // person's next turn): then the line waits for the next wake and the report.
  const s1 = loadState();
  const mark = work.roundMark(s1);
  const wsNow = waitingSet(s1);
  const wsPrev = st.waiting || {};
  // a set that only shrinks changes nothing, and an update line never wakes the session on its own (it rides on the next wake)
  const gained = Object.keys(wsNow).some((k) => !k.startsWith('update:') && wsPrev[k] !== wsNow[k]);
  // The push's own answer decides (J notify result): "not sent" stops notify-only wakes until the person's next turn; an
  // answer that cannot tell leaves them only for items that block work (a stop, a held item, a consent to give).
  const res = st.notifyResult || null;
  const blocking = Object.keys(wsNow).some((k) => wsPrev[k] !== wsNow[k] && watcher.blocking.test(k));
  const notifyOnly = !fresh.length && newNotify && gained && res !== 'not_sent' && (res !== 'unknown' || blocking) && (st.notifyMark || null) !== mark;
  if (pending) return { lines, stop: false };
  if (fresh.length || notifyOnly) {
    const counts = {};
    for (const i of wl.items.filter((x) => !x.waitsForPerson && fresh.includes(`${x.key}:${x.reason}:${x.v}`))) counts[i.reason] = (counts[i.reason] || 0) + 1;
    updateState((state) => logWake(state, counts, newNotify, now));
    // One line: the round's steps first (so a woken model that has only this line knows the last one), then what is due.
    lines.push(watcher.wakeLine({ counts, notify: wl.notify, newNotify }));
  }
  const sent = newNotify && (fresh.length || notifyOnly);
  updateState((state) => {
    state.watcher = { ...(state.watcher || {}), sent: tokens, fingerprint: fingerprint(tokens), notify: wl.notify ? (sent ? wl.notify : st.notify || null) : null, notifyMark: sent ? mark : st.notifyMark || null, waiting: sent ? wsNow : wl.notifyQuiet ? wsPrev : !gained || !newNotify ? wsNow : wsPrev };
  });
  return { lines, stop: false };
}

export async function runWatcher({ holder = Math.random().toString(36).slice(2, 10), pid = process.pid, fetchImpl, runner, write = (l) => process.stdout.write(`${l}\n`), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tickMs = tickMsOf(), maxTicks = Infinity, ctx = {}, clock = () => Date.now(), timer = (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return () => clearInterval(t); }, tickImpl = tick } = {}) {
  const { watcher, work } = decl();
  // Code holds the restart rule: the watcher starts only as the last step of the turn. While any actionable due item is
  // unclaimed, it refuses with one line naming them, so a watcher started in the middle of a round cannot see the round's
  // own new items as new work.
  { const cur = loadState().lease;
    if (cur && leaseFresh(cur, clock()) && cur.holder !== holder) {
      write('another session holds the lease; work attended');
      return { exit: 0, reason: 'lease_held' };
    }
    const st = loadState(); const wl = work.list({ now: clock(), commit: false }); const open = unclaimedDue(st, wl.items, clock());
    if (open.length) {
      const names = {};
      for (const i of open) names[i.reason] = (names[i.reason] || 0) + 1;
      write(`not started: ${Object.entries(names).map(([k, n]) => `${n} ${k}`).join(', ')} due and not handed out; run ${watcher.commands.work}, hand them out, then start ${watcher.commands.watch} last`);
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
    const startHash = codeHash();
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
