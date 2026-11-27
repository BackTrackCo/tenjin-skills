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
import { buildCandidate, approveEmail, nextEmail, markSent, resolveUnknown, repliesDue, recordReply, unknownList, MODES, viaOf, emailState } from './lib/email.mjs';
import { resolveAddress } from './lib/lookup.mjs';
import { recordEmailConsent, revokeConsent, confirmDryRun, consentStatus } from './lib/consent.mjs';
import { suppressPerson, suppressDomain, resolvePerson } from './lib/dedupe.mjs';
import { emailQuestion, rcAtPush } from './lib/questions.mjs';
import { followUpCandidates, startFollowUp, skipFollowUp, followUpQuestions, recordSocialReply } from './lib/followup.mjs';
import { prepUnattended } from './lib/email-prep.mjs';
import { checkRelease, applyUpdate, recordRelease } from './lib/release.mjs';
import { openBatch, closeBatch } from './lib/batch.mjs';
import { spawn } from 'node:child_process';

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
  // A turn the watcher woke is unattended: nobody can say yes in it, so code refuses every command that needs a person's yes.
  if (flags.unattended) openBatch({ mode: 'unattended' });
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
register('ask', ({ sub, args }) => {
  if (sub === 'start') {
    const st = loadState();
    const ask = startQuestions({ rc: st.rc, pushSent: st.pushSent, settings: pushSettings() });
    const bad = validateAsk(ask);
    if (bad.length) return fail(bad.join('; '));
    return ask;
  }
  if (sub === 'email') {
    const st = loadState();
    const lead = st.leads[args[1]];
    if (!lead) return fail('ask email <lead key>');
    const cand = buildCandidate(st, lead, readProfile());
    const ask = emailQuestion({ cand, via: viaOf(st, cand) });
    const bad = validateAsk(ask);
    if (bad.length) return fail(bad.join('; '));
    return { ...ask, id: cand.id, exact: { to: cand.to, subject: cand.subject, text: cand.text }, note: 'Show the exact text to the person in the question. On yes: G email approve <lead key> --id <id>. On no: G pick is unchanged; run G leave or skip it.' };
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
register('email', async ({ sub, args, flags }) => {
  const profile = readProfile();
  const overlay = loadOverlay();
  if (sub === 'connector') {
    if (!MODES.includes(args[1])) return fail(`connector is one of ${MODES.join(', ')}`);
    return updateState((s) => { emailState(s).connector = args[1]; return { connector: args[1] }; });
  }
  if (sub === 'resolve') {
    if (!args[1]) return fail('email resolve <key>');
    const lead = loadState().leads[args[1]];
    if (!lead) return fail(`unknown lead: ${args[1]}`);
    if (lead.status !== 'picked' || !lead.pick || lead.pick.channel !== 'email') return fail('pick Email for this lead first (G pick <key> email)');
    if (loadState().tenjin.status !== 'ready' && !lead.emailFromPost) return fail('the address needs a lookup and Tenjin is not ready: say the send is the person\'s, with the lead\'s own contact');
    const r = lead.emailFromPost ? { lookups: 0 } : await resolveAddress({ leadKey: args[1] });
    const st = loadState();
    let cand;
    try {
      cand = buildCandidate(st, st.leads[args[1]], profile);
    } catch (e) {
      return { ...r, ready: false, why: e.message };
    }
    return { ...r, ready: true, id: cand.id, to: cand.to, subject: cand.subject, text: cand.text, source: cand.source, country: cand.country, notice: cand.notice, via: viaOf(st, cand), mustDraft: cand.mustDraft };
  }
  if (sub === 'approve') {
    if (!args[1] || !flags.id) return fail('email approve <lead key> --id <the id email resolve printed>');
    return updateState((s) => approveEmail(s, s.leads[args[1]] || fail(`unknown lead: ${args[1]}`), profile, { expectId: flags.id }));
  }
  if (sub === 'next') {
    const r = updateState((s) => nextEmail(s, { profile, overlay, unattended: Boolean(flags.unattended) }));
    return r;
  }
  if (sub === 'sent') {
    if (!args[1]) return fail('email sent <id> [message id] [--thread <id>] [--how sent|drafted|shown]');
    return updateState((s) => markSent(s, args[1], { messageId: args[2] || null, threadId: flags.thread || null, how: flags.how || 'sent' }));
  }
  if (sub === 'unknown') {
    if (!args[1] || !args[2]) return fail('email unknown <id> sent|not_sent');
    return updateState((s) => resolveUnknown(s, args[1], args[2]));
  }
  if (sub === 'prep') return prepUnattended({ profile, overlay });
  if (sub === 'status') {
    const e = emailState(loadState());
    return { connector: e.connector, drafts: Object.values(e.drafts).map((d) => ({ id: d.id, to: d.to, status: d.status })), unknown: unknownList(loadState()).map((d) => d.id) };
  }
  return fail('email connector|resolve|approve|next|prep|sent|unknown|status');
});
register('replies', ({ sub }) => {
  if (sub !== 'due') return fail('replies due');
  return { threads: repliesDue(loadState()), note: 'Read only these threads, with the Gmail tool\'s thread read. For each, G reply <id> replied|opt_out|bounce|not_interested [--text "<the reply>"] [--company].' };
});
register('reply', ({ args, flags }) => {
  if (!args[0] || !args[1]) return fail('reply <email id> replied|opt_out|bounce|not_interested [--text <reply>] [--company]');
  return updateState((s) => recordReply(s, args[0], args[1], { text: typeof flags.text === 'string' ? flags.text : '', company: Boolean(flags.company) }));
});
register('consent', ({ sub, args }) => {
  if (sub === 'status') return consentStatus(loadState(), readProfile(), loadOverlay());
  if (sub === 'record') {
    if (args[1] !== 'email') return fail('consent record email');
    return updateState((s) => recordEmailConsent(s, readProfile(), loadOverlay()));
  }
  if (sub === 'revoke') return updateState((s) => revokeConsent(s, args[1] || 'email'));
  return fail('consent status|record email|revoke email');
});
register('dryrun', ({ sub }) => {
  if (sub !== 'confirm') return fail('dryrun confirm');
  return updateState((s) => confirmDryRun(s, readProfile(), loadOverlay()));
});
register('suppress', ({ sub, flags }) => {
  if (sub !== 'add') return fail('suppress add --id <identity or email:addr> --reason <reason> | --domain <domain> --reason <reason>');
  const reason = typeof flags.reason === 'string' ? flags.reason : 'person_said_so';
  return updateState((s) => {
    if (flags.domain) return suppressDomain(s, String(flags.domain), reason);
    if (!flags.id) throw new Error('suppress add needs --id or --domain');
    const id = String(flags.id).toLowerCase();
    const p = resolvePerson(s, [id]);
    return suppressPerson(s, p.key, reason);
  });
});
register('follow-up', ({ sub, args }) => {
  const overlay = loadOverlay();
  if (sub === 'list' || !sub) return { due: followUpCandidates(loadState(), overlay).map((l) => ({ key: l.key, author: l.author, channel: l.pick && l.pick.channel })) };
  if (sub === 'ask') {
    const groups = followUpQuestions(loadState(), overlay);
    for (const g of groups) { const bad = validateAsk(g); if (bad.length) return fail(bad.join('; ')); }
    return { groups, note: 'One AskUserQuestion call per group. Yes: G follow-up start <key>. No: G follow-up skip <key>.' };
  }
  if (sub === 'start') return updateState((s) => startFollowUp(s, args[1] || fail('follow-up start <key>'), overlay));
  if (sub === 'skip') return updateState((s) => skipFollowUp(s, args[1] || fail('follow-up skip <key>')));
  return fail('follow-up list|ask|start <key>|skip <key>');
});
register('replied', ({ args, flags }) => {
  if (!args[0]) return fail('replied <lead key> [--opt-out]');
  return updateState((s) => {
    const r = recordSocialReply(s, args[0], { optOut: Boolean(flags['opt-out']) });
    if (flags['opt-out']) suppressPerson(s, s.leads[args[0]].personKey, 'opt_out');
    return r;
  });
});
register('notify', ({ sub, args, flags }) => {
  if (sub !== 'result' || !['sent', 'not_sent', 'unknown'].includes(args[1])) return fail('notify result sent|not_sent|unknown [--reason off|present|none]');
  const say = args[1] === 'not_sent' ? rcAtPush(flags.reason, pushSettings()) : null;
  updateState((s) => {
    s.watcher = { ...(s.watcher || {}), notifyResult: args[1] };
    if (args[1] === 'sent') s.pushSent = true;
  });
  return { recorded: args[1], say };
});
register('rc', ({ sub, args }) => {
  if (sub !== 'set' || !['on', 'unknown'].includes(args[1])) return fail('rc set on|unknown');
  return updateState((s) => { s.rc = args[1]; return { rc: args[1] }; });
});
register('release', async ({ sub, flags }) => {
  if (sub === 'check') {
    const r = await checkRelease({ fetchImpl: globalThis.fetch, runner, autoInstall: !flags['no-install'] });
    recordRelease(r);
    return r;
  }
  if (sub === 'apply') {
    const w = loadState().update.waiting;
    if (!w) return fail('no update is waiting');
    const m = readJsonFile(path.join(SKILL_DIR, 'manifest.json'));
    const r = await applyUpdate({ tag: w.tag, writingTag: w.writingTag, change: w.change, runner, previousTag: `gtm-loop-v${m.version}`, previousWriting: m.writing, version: w.tag.replace('gtm-loop-v', '') });
    recordRelease(r);
    return r;
  }
  return fail('release check|apply');
});
register('batch', ({ sub, flags }) => {
  if (sub === 'open') return openBatch({ mode: flags.mode === 'unattended' ? 'unattended' : 'attended' });
  if (sub === 'close') { closeBatch(); return { closed: true }; }
  return fail('batch open [--mode unattended]|close');
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

// Runs a command for the release check (npx skills add), never through a shell.
const runner = (cmd, args) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: 'ignore' });
  p.on('exit', (code) => resolve({ code: code === null ? 1 : code }));
  p.on('error', () => resolve({ code: 1 }));
});
register('watch', async () => {
  closeBatch(); // the round is over; the next woken turn opens its own
  return runWatcher({ fetchImpl: globalThis.fetch, runner });
});
register('ops', ({ flags }) => applyOps(flags.file ? readJsonFile(flags.file) : fail('ops needs --file')));

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().then((code) => { process.exitCode = code; });
}
