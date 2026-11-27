import fs from 'node:fs';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { getApp } from './app.mjs';
import * as batch from './batch.mjs';
import { leaseFresh, touchLease, watcherStatus } from './lease.mjs';
import { addRule, loadOverlay, removeRule } from './rules.mjs';
import { ensureDir, readJson, stateDir } from './paths.mjs';
import { applyUpdate, checkRelease, gatesHash, recordRelease } from './release.mjs';
import { revokeConsent } from './consent.mjs';
import { applyOps, loadState, readOldStateFields, oldStateError, updateState } from './store.mjs';
import { renderReport } from './report.mjs';
import { defaultRun, hintState } from './tenjin.mjs';
import { runWatcher } from './watcher.mjs';
import { markShown, roundOpen } from './work.mjs';

// The CLI frame. Every command prints JSON. The app declares its own table and what the frame needs:
//   cli: { order: [command names in the order the unknown-command error lists them], personCommands: [commands only a person runs],
//          isNews(cmd, pos) -> bool, preChecks(cmd, pos) -> error text | null, deriveLessons(state), beforeWork(), commands: { watch: 'J watch' } }
// The shared commands are here: rules, lessons, shown, gates, release, work, tenjin, batch, ops, arm, consent, report, rc, chrome, notify and
// watch. An app command of the same name replaces a base one. What is the app's own comes in through hooks in `cli`:
//   word: 'J' (what the app's commands are called in text), setupPeriod(), batchOpen(flags) -> { uploadPath } | { error }, batchNext,
//   opsGuard(ops) -> error | null, afterOps(ops), beforeOps(ops), armView(state), consentRecord: { [kind]: (state, flags) => result },
//   consentUsage, onFullReport(state), markReported(state, { all }), reportFooter() -> text | null, rcReminder(state, v),
//   rcAtPush(reason), chromeSet(state, v) -> { cleared, steps }, watchSub(sub, name, flags).
const decl = () => getApp().cli || {};

export function readJsonArg(arg) {
  return JSON.parse(arg === '-' ? fs.readFileSync(0, 'utf8') : fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8') : arg);
}
export function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return /^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : v;
}
export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[k] = true;
      else {
        flags[k] = next;
        i++;
      }
    } else pos.push(a);
  }
  return { pos, flags };
}

export function out(o, code = 0) {
  // After a start, every command says when the watcher is not running: it must be started again.
  if (o && typeof o === 'object' && !Array.isArray(o) && process.argv[2] !== 'watch' && process.argv[2] !== 'arm') {
    try {
      const st = loadState();
      if (st.watcherEver && !watcherStatus(st).running && !roundOpen(st)) o = { ...o, watcher: 'stopped' };
    } catch {}
  }
  process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
  process.exitCode = code;
}

// The commands every app has the same way.
export function sharedCommands() {
  return {
    async rules([sub, ...rest], flags) {
      if (sub === 'add') {
        // A rule asked as a question-tool call: the chosen option's label is the person's words, with the date.
        const words = flags['from-choice'] !== undefined ? flags['from-choice'] : flags.words;
        if (flags['from-choice'] !== undefined && (flags['from-choice'] === true || !String(flags['from-choice']).trim())) return out({ error: 'rules add --from-choice "<the option label the person chose>"' }, 2);
        return out(addRule({ effect: flags.effect, value: flags.value === undefined ? null : coerce(flags.value), words }));
      }
      if (sub === 'remove') return out({ removed: removeRule(rest[0]) });
      return out(loadOverlay().rules);
    },
    async lessons([sub]) {
      if (sub === 'derive') return out(decl().deriveLessons(loadState()));
      return out(loadOverlay().lessons);
    },
    async shown(keys, flags) {
      return out(updateState((s) => ({ shown: markShown(s, flags.all === true || !keys.length ? null : keys) })));
    },
    async gates(_, flags) {
      const h = gatesHash();
      if (flags.write) {
        const f = path.join(getApp().skillDir, 'manifest.json');
        const m = readJson(f, {});
        writeFileSync(f, `${JSON.stringify({ ...m, gatesHash: h }, null, 2)}\n`);
      }
      return out({ gatesHash: h });
    },
    async release([sub]) {
      const state = loadState();
      const runner = async (cmd, args) => defaultRun(cmd, args);
      if (sub === 'check') {
        const r = await checkRelease({ fetchImpl: globalThis.fetch, runner });
        recordRelease(r);
        return out(r);
      }
      if (sub === 'apply') {
        const w = state.update.waiting;
        if (!w) return out({ error: 'no update waits' }, 2);
        const m = readJson(path.join(getApp().skillDir, 'manifest.json'), {});
        const comps = getApp().release.companions || [];
        const r = await applyUpdate({ tag: w.tag, ...Object.fromEntries(comps.map((c) => [c.tagField, w[c.tagField]])), change: w.change, runner, previousTag: `${getApp().name}-v${m.version}`, ...Object.fromEntries(comps.map((c) => [c.previousField, m[c.manifestKey]])) });
        recordRelease(r);
        return out(r);
      }
      return out({ error: 'release check | apply (after the person says yes)' }, 2);
    },
    async tenjin([sub, answer]) {
      const d = decl();
      if (sub === 'ask-done') {
        // The ask is made at most once per session; a no is recorded with its date.
        return out(updateState((s) => {
          s.tenjin = { ...(s.tenjin || {}), askedAt: new Date().toISOString(), ...(answer === 'no' ? { declinedAt: new Date().toISOString() } : {}) };
          // A yes holds the moment as tenjin_setup for this period, until the check says ready; then it runs in code.
          if (answer === 'yes') {
            s.tenjinSetup = { at: new Date().toISOString(), period: d.setupPeriod() };
            if (!s.held.some((h) => h.reason === 'tenjin_setup')) s.held.push({ reason: 'tenjin_setup', detail: 'waiting for Tenjin to be ready' });
          }
          return { asked: true, answer: answer || null };
        }));
      }
      const r = hintState();
      updateState((s) => {
        s.held = s.held.filter((h) => h.reason !== 'tenjin_missing' && !(h.reason === 'tenjin_setup' && r.status === 'ready'));
        if (r.status === 'ready') s.tenjinSetup = null;
        if (r.status === 'missing') s.held.push({ reason: 'tenjin_missing', detail: 'missing' });
        s.tenjin = { ...(s.tenjin || {}), status: r.status, version: r.version || null, checkedAt: new Date().toISOString() };
      });
      return out(r);
    },
    async batch([sub], flags) {
      const d = decl();
      if (sub === 'open') {
        const o = typeof d.batchOpen === 'function' ? d.batchOpen(flags) : {};
        if (o.error) return out({ error: o.error }, 4);
        const p = batch.openBatch({ mode: flags.unattended ? 'unattended' : 'attended', uploadPath: o.uploadPath ?? null });
        return out({ mode: p.mode, next: d.batchNext });
      }
      if (sub === 'close') {
        batch.closeBatch();
        return out({ closed: true });
      }
      return out({ error: 'batch open [--unattended] [--upload path] | close' }, 2);
    },
    async ops([arg]) {
      const d = decl();
      const ops = readJsonArg(arg);
      if (typeof d.beforeOps === 'function') d.beforeOps(ops);
      const refused = typeof d.opsGuard === 'function' ? d.opsGuard(ops) : null;
      if (refused) return out({ error: refused }, 4);
      const r = applyOps(ops);
      if (typeof d.afterOps === 'function') d.afterOps(ops);
      return out(r);
    },
    // Arm: reclaim a stale lease and say what to start. The watcher itself is the app's watch command, started with the Bash tool's
    // run_in_background and started again after each round; its exit is what wakes the session.
    async arm() {
      const d = decl();
      const now = Date.now();
      const st = loadState();
      if (st.lease && leaseFresh(st.lease, now) && watcherStatus(st, now).running) return out({ armed: false, running: true, heldBy: st.lease.holder, note: 'a watcher is already running (this session after a compaction, or another session); if it is another, work attended' });
      updateState((s) => { if (s.lease) s.lease = null; s.watcherEver = true; });
      return out({ armed: true, watch: `start ${d.commands.watch} with the Bash tool, run_in_background true; start it again after each round and whenever a ${d.word} command reports watcher: stopped`, view: d.armView(loadState()) });
    },
    async consent([sub, which], flags) {
      const d = decl();
      const kinds = getApp().consents.kinds;
      if (sub === 'revoke') {
        return out(updateState((s) => {
          revokeConsent(s, which);
          (s.consentLog ||= []).push({ at: new Date().toISOString(), what: `${which} consent revoked` });
          return { revoked: which };
        }));
      }
      if (sub !== 'record' || !kinds.includes(which) || typeof (d.consentRecord || {})[which] !== 'function') return out({ error: d.consentUsage }, 2);
      return out(updateState((s) => d.consentRecord[which](s, flags)));
    },
    // The default report is short; `--all` shows everything. The full report is always saved to the reports folder.
    async report(_, flags) {
      const d = decl();
      const s = loadState();
      const all = flags.all === true;
      const opts = { since: s.lastReportAt, profile: d.readProfile() };
      const overlay = loadOverlay();
      const full = renderReport(s, overlay, opts);
      const text = all ? full : renderReport(s, overlay, { ...opts, short: true });
      const dir = ensureDir(path.join(stateDir(), 'reports'));
      fs.appendFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.md`), `${full}\n\n`, { mode: 0o600 });
      updateState((st) => {
        st.lastReportAt = new Date().toISOString();
        if (all) {
          st.updateLines = [];
          if (typeof d.onFullReport === 'function') d.onFullReport(st);
        }
        for (const c of st.consentLog || []) c.acked = true;
        markShown(st); // the person is shown the waiting items now: no push repeats them
        if (typeof d.markReported === 'function') d.markReported(st, { all });
        // the short report does not list the update lines, so they stay unshown for the full report and the push
        if (!all) for (const k of Object.keys(st.shown || {})) if (k.startsWith('update:')) delete st.shown[k];
      });
      process.stdout.write(`${text}\n`);
      const footer = typeof d.reportFooter === 'function' ? d.reportFooter() : null;
      if (footer) process.stdout.write(footer);
    },
    async rc([sub, v]) {
      if (sub !== 'set' || !['on', 'unknown'].includes(v)) return out({ error: 'rc set on|unknown' }, 2);
      return out(updateState((s) => { s.rc = v; return { rc: v, reminder: decl().rcReminder(s, v) }; }));
    },
    async chrome([sub, v]) {
      if (sub !== 'set' || !['on', 'off'].includes(v)) return out({ error: 'chrome set on|off' }, 2);
      return out(updateState((s) => {
        s.chrome = v;
        const extra = decl().chromeSet(s, v);
        return { chrome: v, ...extra };
      }));
    },
    async notify([sub, result], flags) {
      // The model records each push's answer. A "not sent" notify-only push stops further notify-only wakes until the person's
      // next turn; an answer that cannot tell sent from not sent allows them only for items that block work.
      if (sub !== 'result' || !['sent', 'not_sent', 'unknown'].includes(result)) return out({ error: 'notify result sent|not_sent|unknown [--reason off|present|none]' }, 2);
      const reason = flags.reason;
      if (reason !== undefined && (result !== 'not_sent' || !['off', 'present', 'none'].includes(reason))) return out({ error: '--reason off|present|none goes with not_sent' }, 2);
      return out(updateState((s) => {
        const w = (s.watcher ||= {});
        w.notifyResult = result;
        w.notifyAt = new Date().toISOString();
        if (result === 'sent') s.pushSent = true; // a sent push proves Remote Control and "Push when Claude decides" are both on
        // One reminder at a push result, once: off says the /config sentence, none says both, present says nothing.
        const say = result === 'not_sent' && !s.rcPushSaid ? decl().rcAtPush(reason) : null;
        if (say) s.rcPushSaid = true;
        return { recorded: result, ...(reason ? { reason } : {}), say };
      }));
    },
    // With no sub-command this is the watcher: a background command that exits when work is due. The app's own sub-commands (a watch
    // list, for example) come in through `watchSub`.
    async watch([sub, name], flags) {
      const d = decl();
      if (!sub) {
        const r = await runWatcher({ fetchImpl: globalThis.fetch, runner: async (cmd, args) => defaultRun(cmd, args) });
        process.exitCode = r.exit;
        return;
      }
      if (typeof d.watchSub === 'function') return d.watchSub(sub, name, flags);
      return out({ error: 'watch takes no sub-command' }, 2);
    },
    // Hands the work out. The app's `beforeWork` runs the code steps that come first; with --commit the list is marked as handed out.
    async work(_, flags) {
      const d = decl();
      if (typeof d.beforeWork === 'function') await d.beforeWork();
      const wl = getApp().work.list({ commit: flags.commit === true, unattended: flags.unattended === true });
      // An empty list is not an error: wl.empty says so (exit 0 for every list). A committed round ends by starting the watcher again.
      return out(flags.commit === true ? { ...wl, then: `start ${d.commands.watch} last, with run_in_background, after every item is handed out or done` } : wl);
    },
  };
}

// The merged table: the base's shared commands, replaced by the app's own of the same name, in the order the app declares.
export function commandTable(appCommands) {
  const merged = { ...sharedCommands(), ...appCommands };
  const order = decl().order || [];
  const table = {};
  for (const k of order) if (merged[k]) table[k] = merged[k];
  for (const k of Object.keys(merged)) if (!table[k]) table[k] = merged[k];
  return table;
}

export async function runCli(appCommands, argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const { pos, flags } = parseArgs(rest);
  const commands = commandTable(appCommands);
  const d = decl();
  if (!commands[cmd]) return out({ error: `unknown command: ${cmd}`, commands: Object.keys(commands) }, 2);
  // A profile that holds a field from an older version is refused with the field's name; the profile command itself still runs, to remove it.
  if (typeof d.preChecks === 'function') {
    const bad = d.preChecks(cmd, pos);
    if (bad) return out({ error: bad }, 2);
  }
  // A state that holds a field from an older version is refused with the field's name, never converted.
  const oldState = readOldStateFields();
  if (oldState.length) return out({ error: oldStateError(oldState) }, 2);
  // A command that changes what an action may do is refused while a batch is open, whoever calls it.
  if (batch.isBatchDenied(cmd, pos[0], batch.batchMode(loadState())) && batch.isActive(Date.now(), loadState())) return out({ error: `${cmd} ${pos[0] || ''} is refused while a batch is open; close it in an attended session first`.replace('  ', ' ') }, 4);
  try {
    await commands[cmd](pos, flags);
    if (cmd !== 'watch') touchLease();
    // The person's next turn lifts the "not sent" stop on notify-only wakes (only a person runs these).
    if ((d.personCommands || []).includes(cmd)) updateState((st) => { if (st.watcher && st.watcher.notifyResult === 'not_sent') st.watcher.notifyResult = null; });
    // The person's answer is news: items left alone come back for it.
    if (!process.exitCode && typeof d.isNews === 'function' && d.isNews(cmd, pos)) updateState((st) => { st.answerV = (st.answerV || 0) + 1; });
  } catch (e) {
    out({ error: e.message }, 2);
  }
}
