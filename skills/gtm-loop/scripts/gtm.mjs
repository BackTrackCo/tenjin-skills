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
import './lib/steps.mjs';
import { checkPostFile, ingestPostFile, reviewHandout, checkReview, applyReview } from './lib/ingest.mjs';
import { searchPlan, searchDone } from './lib/search.mjs';
import { runHn } from './lib/hn.mjs';
import { runPostRound, runIdentityReads } from './lib/routed.mjs';
import { report } from './lib/report.mjs';
import { startQuestions, validateAsk, EMAIL_MODE_OF, SOURCES_OF } from './lib/questions.mjs';
import { pushSettings } from './lib/pushsettings.mjs';
import { hintLines, outdatedLine } from './lib/prices.mjs';
import { buildRoundRequest, parseRoundResult, applyWriteResult } from './lib/writing.mjs';
import { pickQuestions, pickLead, openPlan, markSentSocial } from './lib/outreach.mjs';
import { openPage, copyToClipboard } from './lib/open.mjs';
import { runFitRound, addCompanies, unprocessed } from './lib/fit.mjs';

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
register('leave', ({ args, flags }) => leave(args[0], flags.reason));

register('phrases', ({ sub, rest, flags }) => {
  if (sub !== 'set') return { phrases: readProfile().phrases || [] };
  const list = (flags.json ? JSON.parse(flags.json) : rest.join(' ').split('|')).map((x) => String(x).trim()).filter(Boolean);
  if (!list.length) return fail('phrases set needs phrases: G phrases set "first phrase|second phrase" or --json \'["a","b"]\'');
  return { profile: setProfile({ phrases: list }) };
});

register('start', ({ sub, flags }) => {
  const profile = readProfile();
  if (sub === 'record') {
    const patch = {};
    if (flags['email-mode']) patch.emailMode = flags['email-mode'];
    if (flags.frequency) patch.frequency = flags.frequency;
    if (flags.sources) patch.sources = flags.sources === 'all' ? ['x', 'reddit', 'linkedin', 'hn', 'web'] : flags.sources === 'social' ? ['x', 'reddit', 'linkedin'] : flags.sources === 'free' ? ['hn', 'web'] : fail('sources is all, social or free');
    if (!Object.keys(patch).length) return fail('start record needs --email-mode, --frequency or --sources');
    const next = setProfile(patch);
    updateState((s) => { s.start = { at: new Date().toISOString(), emailMode: next.emailMode || null, frequency: next.frequency || null, sources: next.sources || null }; });
    return { recorded: loadState().start };
  }
  const missing = [];
  if (!profile.offer) missing.push('what you sell (G profile set --json \'{"offer": {"name", "what", "who", "link"}}\')');
  if (!(profile.phrases || []).length) missing.push('the phrases a buyer would write (G phrases set)');
  if (!loadState().start) missing.push('the start question (G ask start, then G start record)');
  return { done: missing.length === 0, missing, next: missing.length ? 'Ask the person, in their own words: what they sell, who it helps, the link, and if they like who buys it (role, company type, place). Propose three to six phrases a buyer would write, let them edit, then save them. Then ask the start question.' : null };
});
register('ask', ({ sub }) => {
  if (sub === 'start') {
    const st = loadState();
    const ask = startQuestions({ rc: st.rc, pushSent: st.pushSent, settings: pushSettings() });
    const bad = validateAsk(ask);
    if (bad.length) return fail(bad.join('; '));
    return ask;
  }
  if (sub === 'pick') {
    const groups = pickQuestions(loadState());
    if (!groups.length) return { groups: [], note: 'no drafts wait for a pick' };
    for (const g of groups) { const bad = validateAsk(g); if (bad.length) return fail(bad.join('; ')); }
    return { groups, note: 'Make one AskUserQuestion call per group, in order. Record each answer with G pick <key> <channel|skip>: the channel is labels[key][<the label without (Recommended)>].' };
  }
  return fail(`unknown ask: ${sub}`);
});

register('write-prompt', () => {
  const { request, keys, dropped } = buildRoundRequest({ state: loadState(), profile: readProfile(), overlay: loadOverlay() });
  if (!request) return { request: null, dropped, note: 'nothing to write this round' };
  updateState((s) => { s.writeHand = keys; for (const d of dropped) if (s.leads[d.key] && d.reason.startsWith('suppressed')) s.leads[d.key].status = 'suppressed'; logRun(s, 'writer', keys.length); });
  return { ...request, keys, dropped, note: 'Run this as one Agent call with the model and prompt given, save its reply text to a file, then run G write-result --file <file>.' };
});
register('write-result', ({ flags }) => {
  if (!flags.file) return fail('write-result needs --file');
  const parsed = parseRoundResult(fs.readFileSync(flags.file, 'utf8'));
  if (!parsed.ok) return fail(`the result was refused: ${parsed.problem}`);
  return updateState((s) => applyWriteResult(s, parsed, { keys: s.writeHand || [], profile: readProfile() }));
});
register('pick', ({ args }) => {
  const [key, channel] = args;
  if (!key || !channel) return fail('pick <key> <channel|skip>');
  return updateState((s) => pickLead(s, key, channel));
});
register('open', ({ args }) => {
  const key = args[0];
  if (!key) return fail('open <key>');
  const plan = openPlan(loadState(), key);
  const clip = copyToClipboard(plan.text);
  const r = openPage(plan.url);
  if (!r.ok) return { opened: false, why: r.why, text: plan.text, clipboard: clip, say: 'The page did not open. Show the person the text and the link.', link: plan.url };
  return { opened: true, browser: r.browser, line: r.line || null, clipboard: clip, link: plan.url, text: plan.text, say: `The page is open in your Chrome${clip ? ' and the text is on your clipboard' : ''}. Press send yourself, then tell me: G sent ${key}.` };
});
register('sent', ({ args }) => {
  if (!args[0]) return fail('sent <key>');
  return updateState((s) => markSentSocial(s, args[0]));
});

register('search', async ({ sub, flags }) => {
  const profile = readProfile();
  if (sub === 'plan') return searchPlan(profile, loadOverlay());
  if (sub === 'done') return searchDone();
  if (sub === 'route') {
    if (loadState().tenjin.status !== 'ready') return fail('Tenjin is not ready: run G tenjin first');
    const r = await runPostRound({ profile, overlay: loadOverlay() });
    const reads = flags['no-reads'] ? null : await runIdentityReads({});
    return { ...r, reads };
  }
  return fail('search plan, search route, search done');
});
register('fit', async ({ sub }) => {
  if (sub !== 'route') return fail('fit route');
  if (loadState().tenjin.status !== 'ready') return fail('Tenjin is not ready: run G tenjin first');
  return runFitRound({ profile: readProfile(), overlay: loadOverlay() });
});
register('companies', ({ sub, args }) => {
  if (sub === 'add') {
    if (args.length < 2) return fail('companies add <domain...>');
    return { added: updateState((s) => addCompanies(s, args.slice(1))) };
  }
  const list = Object.values(loadState().companies);
  return { companies: list.map((c) => ({ domain: c.domain, name: c.name, source: c.source, peopleDone: Boolean(c.peopleDoneAt) })), waiting: unprocessed(loadState()).length };
});
register('hn', async () => runHn({ fetch: globalThis.fetch, profile: readProfile(), overlay: loadOverlay() }));
register('reads', async () => runIdentityReads({}));
register('ingest', ({ flags }) => {
  if (!flags.file) return fail('ingest needs --file');
  const obj = readJsonFile(flags.file);
  const profile = readProfile();
  const bad = checkPostFile(obj, profile);
  if (bad.length) return fail(`the file was refused, rewrite it: ${bad.slice(0, 8).join('; ')}`);
  return updateState((s) => {
    const r = ingestPostFile(s, obj, { profile, overlay: loadOverlay() });
    return { added: r.added.length, repeated: r.repeated, dropped: r.dropped };
  });
});
register('review', ({ sub, flags }) => {
  if (sub === 'next') return { leads: updateState((s) => reviewHandout(s)), note: 'Review each lead: fit, intent and timing 0 to 100, a quote that appears in the post, one line, the channel, keep or not. Write {"reviews": [...]} and run G review ingest --file <file>.' };
  if (sub === 'ingest') {
    if (!flags.file) return fail('review ingest needs --file');
    const obj = readJsonFile(flags.file);
    const bad = checkReview(obj, loadState());
    if (bad.length) return fail(`the review was refused, rewrite it: ${bad.slice(0, 8).join('; ')}`);
    return updateState((s) => applyReview(s, obj, { overlay: loadOverlay() }));
  }
  return fail('review next, review ingest --file <file>');
});
register('report', ({ flags }) => {
  const r = report(loadState(), readProfile());
  return flags.all ? { ...r, held: loadState().held } : r;
});
register('hints', () => ({ ...hintLines(readProfile()), outdated: outdatedLine(loadState().tenjin.version) }));

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
