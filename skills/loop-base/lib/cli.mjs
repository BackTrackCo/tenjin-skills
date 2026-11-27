import fs from 'node:fs';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { getApp } from './app.mjs';
import * as batch from './batch.mjs';
import { touchLease, watcherStatus } from './lease.mjs';
import { addRule, loadOverlay, removeRule } from './rules.mjs';
import { readJson } from './paths.mjs';
import { applyUpdate, checkRelease, gatesHash, recordRelease } from './release.mjs';
import { loadState, readOldStateFields, oldStateError, updateState } from './store.mjs';
import { defaultRun } from './tenjin.mjs';
import { markShown, roundOpen } from './work.mjs';

// The CLI frame. Every command prints JSON. The app declares its own table and what the frame needs:
//   cli: { order: [command names in the order the unknown-command error lists them], personCommands: [commands only a person runs],
//          isNews(cmd, pos) -> bool, preChecks(cmd, pos) -> error text | null, deriveLessons(state), beforeWork(), commands: { watch: 'J watch' } }
// The shared commands (rules, lessons, shown, gates, release, work) are here; an app command of the same name replaces a base one.
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
