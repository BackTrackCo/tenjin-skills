#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { gatesHash } from './lib/release.mjs';
import { SKILL_DIR } from './lib/paths.mjs';
import { loadState, updateState, view, applyOps } from './lib/store.mjs';
import { addRule, loadOverlay, removeRule } from './lib/overlay.mjs';
import { readProfile, setProfile, validateProfile } from './lib/profile.mjs';
import { hintState } from './lib/tenjin.mjs';
import { isBatchDenied, batchMode, cleanupStale, isActive, touchBatch } from './lib/batch.mjs';
import { runWatcher } from './lib/watcher.mjs';
import { workList, leave } from './lib/work.mjs';
import { logRun } from './lib/runlog.mjs';

// G is this file. Every command prints one JSON object. State, rules and profile live in ~/.tenjin-skills/gtm-loop/.
export function parseArgs(argv) {
  const _ = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[k] = true;
      else { flags[k] = next; i++; }
    } else _.push(a);
  }
  return { _, flags };
}

const out = (o) => { process.stdout.write(`${JSON.stringify(o, null, 2)}\n`); };
export class CliError extends Error {}
const fail = (msg) => { throw new CliError(msg); };
export const readJsonFile = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    return fail(`cannot read ${f}: ${e.message}`);
  }
};

// Command handlers: name -> (ctx) => result. Each step of the build adds its commands with `register`.
export const commands = {};
export const register = (name, fn) => { commands[name] = fn; };

register('gates', () => ({ gatesHash: gatesHash(SKILL_DIR) }));
register('tenjin', () => {
  const h = hintState();
  updateState((s) => { s.tenjin = { ...s.tenjin, status: h.status, version: h.version || null, checkedAt: new Date().toISOString() }; });
  return h;
});
register('profile', ({ sub, flags }) => {
  if (!sub) return { profile: readProfile() };
  if (sub !== 'set') return fail('profile takes no sub-command or set');
  const patch = flags.json ? JSON.parse(flags.json) : flags.file ? readJsonFile(flags.file) : fail('profile set needs --json or --file');
  const bad = validateProfile(patch);
  if (bad.length) return fail(bad.join('; '));
  return { profile: setProfile(patch) };
});
register('rules', ({ sub, rest, flags }) => {
  if (!sub) return { rules: loadOverlay().rules };
  if (sub === 'add') {
    if (!flags.effect || !flags.words) return fail('rules add needs --effect and --words');
    return { rule: addRule({ effect: flags.effect, value: flags.value === undefined ? null : flags.value, words: flags.words }) };
  }
  if (sub === 'remove') return { removed: removeRule(rest[0]) };
  return fail('rules, rules add, rules remove <id>');
});
register('state', () => view(loadState()));
register('work', ({ flags }) => {
  cleanupStale();
  const wl = workList({ commit: Boolean(flags.commit) });
  updateState((s) => logRun(s, 'work', wl.items.length));
  return { items: wl.items, handed: wl.handed.map((i) => i.key), notify: wl.notify };
});
register('leave', ({ rest, flags }) => leave(rest[0], flags.reason));

export async function main(argv = process.argv.slice(2)) {
  const { _, flags } = parseArgs(argv);
  const [cmd, sub, ...rest] = _;
  const state = loadState();
  if (cmd && isActive(Date.now(), state) && isBatchDenied(cmd, sub, batchMode(state))) {
    out({ error: `refused: "${cmd}${sub ? ` ${sub}` : ''}" changes what a send may do, and a batch is open` });
    return 1;
  }
  if (!cmd || !commands[cmd]) {
    out({ error: `unknown command: ${cmd || ''}`, commands: Object.keys(commands) });
    return 2;
  }
  if (isActive(Date.now(), state)) touchBatch();
  try {
    const res = await commands[cmd]({ cmd, sub, rest, flags, args: _.slice(1) });
    out(res === undefined ? { ok: true } : res);
    return 0;
  } catch (e) {
    out({ error: e.message });
    return 1;
  }
}

register('watch', async () => {
  const r = await runWatcher({ fetchImpl: globalThis.fetch });
  return r;
});
register('ops', ({ flags }) => applyOps(flags.file ? readJsonFile(flags.file) : fail('ops needs --file')));

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().then((code) => { process.exitCode = code; });
}
