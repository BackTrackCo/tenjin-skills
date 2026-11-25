#!/usr/bin/env node
// Job Search runtime. Every command prints JSON. Exit 0 ok (an empty work-list too: the JSON says empty), 2 error, 4 refused.
import fs, { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { graph } from './lib/graph.mjs';
import { SKILL_DIR, ensureDir, readJson, stateDir, writeJsonAtomic } from './lib/paths.mjs';
import { applyOp, applyOps, bump, companyTitleKey, compact, loadState, updateState, view } from './lib/store.mjs';

import { addLesson, addRule, deriveLessons, loadOverlay, removeRule } from './lib/overlay.mjs';
import { persist, runSweep } from './lib/sweep.mjs';
import { markShown, refreshClaims, releaseClaims, itemVersion, LEAVE_REASONS, ITEM_LEAVE_REASONS, advanceSearch, askFirst, itemKind, leaveItem, leaveRecord, park, unpark, workList } from './lib/work.mjs';
import { applyRoundDrafts, checkJobSheet, prepareInCode, writableFields } from './lib/prepare.mjs';
import { logRun } from './lib/runlog.mjs';
import * as em from './lib/email.mjs';
import * as rs from './lib/resume.mjs';
import { buildRoundRequest, parseRoundResult } from './lib/writing.mjs';
import { webPlan } from './lib/websearch.mjs';
import { claimLease, leaseFresh, touchLease, watcherStatus } from './lib/lease.mjs';
import { readProfile, runWatcher, tick, watcherCodeHash } from './lib/watcher.mjs';
import { applyUpdate, checkRelease, gatesHash, recordRelease } from './lib/release.mjs';
import { applyNext, applyPathOf, inFlight, confirmDryRun, recordConsent, recordDryRun, recordWritingConsent, revokeConsent } from './lib/apply.mjs';
import { addAnswer, approveWriting, loadAnswers } from './lib/answers.mjs';
import * as batch from './lib/batch.mjs';
import { hintState, defaultRun, findTenjin } from './lib/tenjin.mjs';
import { buildSheet, checkReadBack, checkSheet, completeFromLive, parseGreenhouseQuestions } from './lib/sheet.mjs';
import { normLabel as normLabelFn } from './lib/store.mjs';
import { buildContactMessageRequest, buildIntroRequest, buildLeadIntroRequest, buildWritingRequest, parseIntroResult, parseWritingResult, readWritingRules } from './lib/writing.mjs';
import { firstApplicationHosts, renderReport } from './lib/report.mjs';
import { CHROME_STEPS, maySubmit, stateLine } from './lib/approval.mjs';
import { openPage, checkOpenUrl, openUrlOf } from './lib/open.mjs';
import { pushSettings } from './lib/pushsettings.mjs';
import { copyToUploads, migrateResume, uploadBlockedStep, uploadsDir, uploadsGranted, uploadsLine } from './lib/uploads.mjs';
import * as qs from './lib/questions.mjs';
import { FREQUENCIES, frequencyOf, periodStart } from './lib/schedule.mjs';
import { observations } from './lib/signals.mjs';
import { ingest, joinLeads, leadKey } from './lib/ingest.mjs';
import { validateProfile } from './lib/profile.mjs';
import { routeContacts, routedRounds } from './lib/routed.mjs';
import { resumeHeld } from './lib/held.mjs';
import { DEFAULT_BUDGET_MS, runHn } from './lib/hn.mjs';
import { isFillOnly, markFillReady, markSubmitted } from './lib/fillonly.mjs';

// The sheets waiting for the person's yes, best fit first: the report lists them one line each.
export function readySheets(st) {
  return Object.values(st.jobs).filter((j) => ((j.status === 'apply_ready' && j.sheet) || (j.status === 'prepared' && j.awaitingApproval && j.sheet)) && j.employerPosting && !st.approvals[j.key]).sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1)).map((j) => ({ key: j.key, company: j.company, title: j.title, fitLine: j.fitLine || '', missingFacts: j.awaitingApproval ? j.missingFacts || [] : [], newAnswers: (j.sheet.fields || []).filter((f) => f.tag === 'new_writing').map((f) => ({ label: f.label, value: f.value })) }));
}
const out = (o, code = 0) => {
  // After a start, every J command says when the watcher is not running: it must be started again (SKILL.md).
  if (o && typeof o === 'object' && !Array.isArray(o) && process.argv[2] !== 'watch' && process.argv[2] !== 'arm') {
    try {
      const st = loadState();
      if (st.watcherEver && !watcherStatus(st).running) o = { ...o, watcher: 'stopped' };
    } catch {}
  }
  process.stdout.write(JSON.stringify(o, null, 2) + '\n');
  process.exitCode = code;
};
const readJsonArg = (arg) => JSON.parse(arg === '-' ? fs.readFileSync(0, 'utf8') : fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8') : arg);
const profileFile = () => path.join(stateDir(), 'profile.json');
const asyncRun = async (cmd, args) => defaultRun(cmd, args);

function parseArgs(argv) {
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

function loadQuestions(file) {
  const j = readJsonArg(file);
  return Array.isArray(j) ? j : parseGreenhouseQuestions(j);
}

const commands = {
  // Only sets the hint state the hint moments read. It never stops the start and asks nothing.
  async tenjin([sub, answer]) {
    if (sub === 'ask-done') {
      // The ask is made at most once per session; a no is recorded with its date.
      return out(updateState((s) => {
        s.tenjin = { ...(s.tenjin || {}), askedHolder: s.lease ? s.lease.holder : 'none', ...(answer === 'no' ? { declinedAt: new Date().toISOString() } : {}) };
        // A yes holds the moment as tenjin_setup for this period, until `J tenjin` says ready; then it runs in code.
        if (answer === 'yes') {
          s.tenjinSetup = { at: new Date().toISOString(), period: periodStart(Date.now(), frequencyOf(readProfile())) };
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

  async setup([sub, ...rest], flags) {
    if (sub === 'check') {
      return out({ tenjin: loadState().tenjin || null, profile: fs.existsSync(profileFile()), setup: loadState().setup });
    }
    if (sub === 'resume') {
      const p = rest[0] || '';
      if (!p || /\[PATH TO/i.test(p) || !fs.existsSync(p)) return out({ ask: 'Which file is your resume? Give its path.', read: false }, 4);
      const text = fs.readFileSync(p, 'utf8');
      const prof = readProfile();
      writeJsonAtomic(profileFile(), { ...prof, resumePath: path.resolve(p), resumeText: text });
      return out({ read: true, chars: text.length });
    }
    if (sub === 'stage') {
      updateState((s) => {
        s.setup = { ...s.setup, stage: rest[0] || null, next: rest[1] || null };
      });
      return out({ saved: true });
    }
    return out({ error: 'setup check | resume <path> | stage <stage> <next>' }, 2);
  },

  async profile([sub, arg]) {
    if (sub === 'get') return out(readProfile());
    if (sub === 'set') {
      ensureDir(stateDir());
      const given = readJsonArg(arg);
      // The compatibility feature for an external tool is gone: the field is refused from now on. An old profile that still has it loads, and the field is ignored.
      if (given && typeof given === 'object' && 'careerOps' in given) return out({ error: 'the profile was not saved: careerOps is no longer a profile field (that feature was removed)' }, 2);
      const next = { ...readProfile(), ...given };
      const bad = validateProfile(next);
      if (bad.length) return out({ error: `the profile was not saved: ${bad.join('; ')}` }, 2);
      writeJsonAtomic(profileFile(), next);
      return out({ saved: Object.keys(next), resumed: resumeHeld(next) });
    }
    return out({ error: 'profile get | set <json>' }, 2);
  },

  async batch([sub], flags) {
    if (sub === 'open') {
      const profile = readProfile();
      const p = batch.openBatch({ mode: flags.unattended ? 'unattended' : 'attended', uploadPath: flags.upload || profile.resumeUploadPath || profile.resumePath });
      return out({ mode: p.mode, next: 'run apply next' });
    }
    if (sub === 'close') {
      batch.closeBatch();
      return out({ closed: true });
    }
    return out({ error: 'batch open [--unattended] [--upload path] | close' }, 2);
  },

  async sweep() {
    const state = loadState();
    const payload = await runSweep({ state, profile: readProfile(), overlay: loadOverlay(), fetch: globalThis.fetch });
    const r = persist(payload);
    return out({ ...r, dropped: payload.dropped.length, held: payload.held });
  },

  async view(_, flags) {
    return out(view(loadState(), { keys: flags.keys ? String(flags.keys).split(',') : undefined, limit: Number(flags.limit) || 30 }));
  },
  async ops([arg]) {
    const ops = readJsonArg(arg);
    const r = applyOps(ops);
    const ranked = (Array.isArray(ops) ? ops : []).filter((o) => o.op === 'rank').length;
    if (ranked) updateState((s) => logRun(s, 'review', ranked));
    return out(r);
  },
  async persist([arg]) {
    return out(persist(readJsonArg(arg)));
  },
  async compact() {
    return out({ archived: updateState((s) => compact(s)) });
  },

  async rules([sub, ...rest], flags) {
    if (sub === 'add') {
      // A rule asked as a question-tool call: the chosen option's label is the person's words, with the date.
      const words = flags['from-choice'] !== undefined ? flags['from-choice'] : flags.words;
      if (flags['from-choice'] !== undefined && (flags['from-choice'] === true || !String(flags['from-choice']).trim())) return out({ error: 'rules add --from-choice "<the option label the person chose>" --effect e --value v' }, 2);
      return out(addRule({ effect: flags.effect, value: flags.value === undefined ? null : coerce(flags.value), words }));
    }
    if (sub === 'remove') return out({ removed: removeRule(rest[0]) });
    return out(loadOverlay().rules);
  },
  async lessons([sub, ...rest], flags) {
    if (sub === 'derive') return out(deriveLessons(loadState()));
    if (sub === 'remove') return out({ removed: removeRule(rest[0]) });
    if (sub === 'add') return out(addLesson({ effect: flags.effect, subject: flags.subject, evidence: String(flags.evidence || '').split(',').filter(Boolean) }));
    return out(loadOverlay().lessons);
  },

  // Arm: reclaim a stale lease and say what to start. The watcher itself is `J watch`, started with the Bash tool's
  // run_in_background and started again after each round; its exit is what wakes the session.
  async arm() {
    const now = Date.now();
    const st = loadState();
    if (st.lease && leaseFresh(st.lease, now) && watcherStatus(st, now).running) return out({ armed: false, running: true, heldBy: st.lease.holder, note: 'a watcher is already running (this session after a compaction, or another session); if it is another, work attended' });
    updateState((s) => { if (s.lease) s.lease = null; s.watcherEver = true; });
    return out({ armed: true, watch: 'start J watch with the Bash tool, run_in_background true; start it again after each round and whenever a J command reports watcher: stopped', view: view(loadState(), { limit: 10 }) });
  },
  async work(_, flags) {
    await prepareInCode({ fetch: globalThis.fetch, profile: readProfile() });
    const wl = workList({ commit: flags.commit === true, unattended: flags.unattended === true });
    return out(wl); // an empty list is not an error: wl.empty says so (exit 0 for every list)
  },

  async sheet([sub, key], flags) {
    const profile = readProfile();
    if (sub === 'build') {
      const questions = loadQuestions(flags.questions);
      return out(updateState((s) => {
        const job = s.jobs[key];
        if (!job) throw new Error(`unknown job: ${key}`);
        const sheet = buildSheet({ job, questions, profile, answers: loadAnswers().entries, drafts: job.drafts || {} });
        job.questions = questions;
        job.sheet = { ...sheet, passed: false };
        return sheet;
      }));
    }
    if (sub === 'check') {
      const live = flags.live ? readJsonArg(flags.live) : null;
      const unattendedTurn = flags.unattended === true || (batch.isActive() && batch.batchMode() === 'unattended');
      const res = updateState((s) => {
        const job = s.jobs[key];
        if (!job || !job.sheet) throw new Error('build the sheet first');
        // A complete sheet before any fill: every required field on the live form has an answer on the sheet (facts, profile, records,
        // saved answers, the resume or drafted writing). One without is asked in the session first, and the job waits as needs_facts
        // with no fill; in a turn the watcher wakes nobody is asked: the job holds with one notification. The person may be on the
        // phone and cannot fill anything in Chrome.
        const missing = completeFromLive(job, live, profile);
        const open = new Set((job.sheet.unanswered || []).map((u) => normLabelFn(u.label)));
        const r = checkJobSheet(job, live ? live.filter((f) => !open.has(normLabelFn(f.label))) : live, profile);
        if (!r.ok && (job.sheet.unanswered || []).some((u) => u.live || u.ack)) {
          // needs_facts, never a fill; an unattended turn is never asked
          park(job, ['needs_facts']);
          job.awaitingApproval = false;
          const asks = unattendedTurn ? null : qs.approvalQuestions(job, 'employer', { chromeOff: s.chrome === 'off' });
          return { ...r, held: 'needs_facts', ...(asks ? { ask: asks, next: 'ask these first, save the answers (J answer add, J agree), rebuild the sheet from the live form (J sheet build <key> --questions <live file>) and check it again; nothing is filled before the sheet is complete' } : { next: 'nobody is asked in this turn: the job holds with one notification' }) };
        }
        return r;
      });
      return out(res, res.ok ? 0 : 4);
    }
    if (sub === 'readback') {
      const job = loadState().jobs[key];
      // The read-back compares the form's own values (read_page or the form state), never a screenshot alone. A field that does not
      // confirm is filled again once; if it still fails the job holds as fill_problem and the session shows the field and its value.
      const r = checkReadBack(job.sheet, readJsonArg(flags.read));
      return out(updateState((s) => {
        const j = s.jobs[key];
        if (r.ok) { j.readbackTries = 0; return r; }
        j.readbackTries = (j.readbackTries || 0) + 1;
        if (j.readbackTries < 2) return { ...r, refill: r.fields, next: 'fill those fields again once, then read the form\'s values back again' };
        j.readbackTries = 0;
        park(j, ['fill_problem']);
        return { ...r, held: 'fill_problem', show: r.fields, next: 'the job holds as fill_problem with one notification: show the person each field and the value the form has' };
      }), r.ok ? 0 : 4);
    }
    return out({ error: 'sheet build <key> --questions f | check <key> [--live f] | readback <key> --read f' }, 2);
  },

  async apply([sub], flags) {
    if (sub !== 'next') return out({ error: 'apply next [--unattended] [--all]' }, 2);
    const mode = flags.unattended ? 'unattended' : 'attended';
    batch.touchBatch();
    const state = loadState();
    const res = applyNext({ state, profile: readProfile(), overlay: loadOverlay(), mode, batchOpen: batch.isActive(Date.now(), state), writingRulesText: readWritingRules(), all: flags.all === true });
    let batchClosed = false;
    updateState((s) => {
      for (const q of res.queue) if (s.jobs[q.key] && !['sheet_not_checked', 'no_recorded_yes', 'no_chrome_tools', 'host_busy'].includes(q.reason)) park(s.jobs[q.key], [q.reason]);
      for (const h of res.handouts) {
        logRun(s, 'browser', 1);
        (s.handouts ||= []).push({ key: h.key, at: new Date().toISOString(), counted: Boolean(h.submit || h.fillOnly) });
        s.jobs[h.key].inFlight = { at: new Date().toISOString(), host: h.host };
      }
      if (res.handouts.length) refreshClaims(s, 'apply_ready');
      // An unattended round ends in code: nothing left to submit (empty, held, parked or refused) closes the batch, but never
      // while handed-out jobs are still running in parallel.
      const running = Object.values(s.jobs).some((j) => ['prepared', 'apply_ready'].includes(j.status) && !j.fillReady && !j.parked && inFlight(j));
      if (mode === 'unattended' && !res.handouts.length && !running && s.batch && s.batch.mode === 'unattended') {
        s.batch = null;
        batchClosed = true;
      }
    });
    return out({ ...res, batchClosed }, res.handouts.length ? 0 : 4);
  },

  // The person's yes, recorded per job and exact sheet hash. Many at once: `--all` (every listed sheet) or `--no-new` (only
  // those with no new answer); or the keys they ticked.
  async approve(keys, flags) {
    let st = loadState();
    let list = keys;
    // Withdraw: the first step whenever the person says stop or don't apply. The yes goes back to waiting for its approval.
    if (flags.withdraw === true) {
      const gone = flags.all === true ? Object.keys(st.approvals) : keys;
      if (!gone.length) return out({ error: 'approve <key> --withdraw | --withdraw --all' }, 2);
      updateState((s) => { for (const k of gone) { delete s.approvals[k]; if (s.jobs[k]) { s.jobs[k].fillOnly = false; s.jobs[k].inFlight = null; bump(s.jobs[k]); } } });
      return out({ withdrawn: gone.length, state: 'Submitted: none. Every yes you took back is waiting for a new approval; nothing will be submitted for it.' });
    }
    // "Ask me each job": the choice joins the approval. LinkedIn means the person applies there; nothing is approved.
    if (flags.via !== undefined) {
      if (keys.length !== 1 || !['employer', 'linkedin'].includes(flags.via)) return out({ error: 'approve <key> --via employer|linkedin takes one job' }, 2);
      const job = st.jobs[keys[0]];
      if (!job) return out({ error: `unknown job: ${keys[0]}` }, 2);
      if (flags.via === 'linkedin' && !job.linkedinUrl) return out({ error: 'that job has no LinkedIn link' }, 2);
      updateState((s) => { s.jobs[keys[0]].applyVia = flags.via; bump(s.jobs[keys[0]]); });
      if (flags.via === 'linkedin') return out({ key: keys[0], via: 'linkedin', next: 'J linkedin show <key>, then show the link and the answers; you never open LinkedIn' });
      st = loadState();
    }
    // A fact the form needed and the profile lacked is answered in the approval itself: `--facts '{"name":"value"}'` saves it,
    // completes the sheet, and the yes covers the completed sheet.
    if (flags.facts !== undefined) {
      if (keys.length !== 1) return out({ error: 'approve <key> --facts <json> takes one job' }, 2);
      const given = readJsonArg(String(flags.facts));
      const profile = readProfile();
      const next = { ...profile, facts: { ...(profile.facts || {}), ...given } };
      const bad = validateProfile(next);
      if (bad.length) return out({ error: bad.join('; ') }, 2);
      writeJsonAtomic(profileFile(), next);
      const r = updateState((s) => {
        const job = s.jobs[keys[0]];
        if (!job || !job.questions) throw new Error('no prepared sheet for that job');
        const sheet = buildSheet({ job, questions: job.questions, profile: next, answers: loadAnswers().entries, drafts: job.drafts || {} });
        job.sheet = { ...sheet, passed: false };
        return checkJobSheet(job, null, next);
      });
      if (!r.ok) return out({ error: `the sheet is still not complete: ${r.problems.join('; ')}` }, 4);
      // The facts are saved and the sheet is complete. The approval comes in its own call after them, with the completed sheet:
      // one click never both answers a fact and approves.
      return out({ saved: Object.keys(given), sheetComplete: true, next: `ask the approval now: J ask approval --key ${keys[0]}` });
    }
    if (flags.all === true || flags['no-new'] === true) list = readySheets(st).filter((r) => !r.missingFacts.length && (flags.all === true || !r.newAnswers.length)).map((r) => r.key);
    if (!list.length) return out({ error: 'approve <key...> | --all | --no-new (nothing to approve)' }, 2);
    for (const k of list) if (st.jobs[k] && applyPathOf(st.jobs[k], readProfile()) === 'ask') {
      if (flags.all === true || flags['no-new'] === true) { list = list.filter((x) => applyPathOf(st.jobs[x], readProfile()) !== 'ask'); break; }
      return out({ error: `${k} is on LinkedIn and on an employer site: ask which with J ask approval --key ${k}, then J approve ${k} --via employer|linkedin` }, 4);
    }
    if (!list.length) return out({ error: 'every listed job waits for its where choice (J ask approval --key <job>)' }, 4);
    for (const k of list) if (!st.jobs[k] || !st.jobs[k].sheet || !st.jobs[k].sheet.passed) return out({ error: `${k} has no complete sheet yet: answer its missing facts (J ask approval <key>)` }, 4);
    const res = applyOps(list.map((key) => ({ op: 'approve', key, sheetHash: st.jobs[key].sheet.hash })));
    // "Submit it now" on a filled form: the yes for the unchanged sheet hash lifts fill-only for that job; `J may-submit` checks it and
    // the browser subagent presses submit, filling again first (in one pass) when the tab was closed or the form lost its values.
    if (flags['submit-now'] === true) {
      for (const k of list) if (!st.jobs[k] || !st.jobs[k].fillReady) return out({ error: `${k} is not filled and waiting` }, 4);
      updateState((s) => { for (const k of list) { s.approvals[k] = { sheetHash: s.jobs[k].sheet.hash, at: new Date().toISOString() }; s.jobs[k].submitNow = { sheetHash: s.jobs[k].sheet.hash, at: new Date().toISOString() }; s.jobs[k].fillOnly = false; bump(s.jobs[k]); } });
      const fin = loadState();
      return out({ submitNow: list.length, state: `Submitted: none yet. Submitting after one last check: ${[...new Set(list.map((k) => fin.jobs[k].company))].join(', ')}.${fin.chrome === 'off' ? ` Waiting: Claude in Chrome is off in this session. ${CHROME_STEPS}` : ''}`, next: 'start the browser subagent with J apply next --all (fromFilled): it runs J may-submit, then presses submit, or fills again and submits when the tab is gone' });
    }
    // "Fill it, I submit": the yes for that sheet hash, with fill-only on for these jobs only (the existing fill-only path).
    if (flags['fill-only'] === true) updateState((s) => { for (const k of list) { s.jobs[k].fillOnly = true; bump(s.jobs[k]); } });
    const fin = loadState();
    return out({ ...res, approved: list.length, fillOnly: flags['fill-only'] === true, state: stateLine(fin, readProfile(), loadOverlay(), list) });
  },

  // Consent is recorded or revoked only by the person's yes, in an attended session. Recording is refused while a batch is open.
  async consent([sub, which], flags) {
    if (sub === 'revoke') {
      return out(updateState((s) => {
        revokeConsent(s, which);
        (s.consentLog ||= []).push({ at: new Date().toISOString(), what: `${which} consent revoked` });
        return { revoked: which };
      }));
    }
    if (sub !== 'record' || !['unattended', 'writing', 'email'].includes(which)) return out({ error: 'consent record unattended --optional-writing skip|wait | record writing | record email | revoke unattended|writing|email' }, 2);
    return out(updateState((s) => {
      if (which === 'email') {
        const c = em.recordEmailConsent(s, readProfile(), loadOverlay());
        em.emailState(s).modeAsked = c.at;
        (s.consentLog ||= []).push({ at: c.at, what: 'email consent recorded (sends to published addresses without a yes each batch)' });
        return c;
      }
      if (which === 'unattended') {
        const c = recordConsent(s, readProfile(), loadOverlay(), Date.now(), flags['optional-writing']);
        (s.consentLog ||= []).push({ at: new Date().toISOString(), what: `unattended consent recorded (optional writing: ${flags['optional-writing']})` });
        return c;
      }
      const c = recordWritingConsent(s, readWritingRules());
      (s.consentLog ||= []).push({ at: new Date().toISOString(), what: 'writing consent recorded' });
      // jobs that only waited for this consent go back to the queue
      for (const j of Object.values(s.jobs)) if (j.parked && j.parked.reasons.length === 1 && j.parked.reasons[0] === 'writing_needs_yes') unpark(j);
      return c;
    }));
  },
  // The person read the draft: approve it as it is or edited. Each new-writing field becomes an earlier answer.
  async writing([sub, key], flags) {
    if (sub !== 'approve') return out({ error: 'writing approve <key> [--edits file.json]' }, 2);
    const profile = readProfile();
    const job = loadState().jobs[key];
    if (!job || !job.sheet) throw new Error('build the sheet first');
    const approved = approveWriting(job, profile, flags.edits ? readJsonArg(flags.edits) : {});
    return out(updateState((s) => {
      (s.consentLog ||= []).push({ at: new Date().toISOString(), what: `writing approved for ${job.company} (${approved.length} answer${approved.length === 1 ? '' : 's'})` });
      const j = s.jobs[key];
      const sheet = buildSheet({ job: j, questions: j.questions, profile, answers: loadAnswers().entries, drafts: j.drafts || {} });
      j.sheet = { ...sheet, passed: checkSheet(sheet).ok };
      if (j.parked && j.parked.reasons.includes('writing_needs_yes')) unpark(j);
      return { approved: approved.length, tags: sheet.fields.filter((f) => f.tag === 'new_writing').length, passed: j.sheet.passed };
    }));
  },
  async answer([sub], flags) {
    if (sub !== 'add') return out({ error: 'answer add --label L --value V [--key jobkey]' }, 2);
    const job = flags.key ? loadState().jobs[flags.key] : null;
    const q = ((job && job.questions) || []).find((x) => x.label === flags.label) || {};
    return out(addAnswer({ question: flags.label, answer: flags.value, how: 'typed', source: flags.key || null, type: q.type || 'input_text', options: q.options && q.options.length ? q.options : null }));
  },
  async dryrun([sub, key, json]) {
    return out(updateState((s) => {
      if (sub === 'record') return recordDryRun(s, { key, ...readJsonArg(json) });
      if (sub === 'confirm') return confirmDryRun(s, readProfile(), loadOverlay());
      throw new Error('dryrun record <key> <json> | confirm');
    }) || { ok: true });
  },

  async stop([key], flags) {
    const kind = flags.kind || 'unknown_field';
    let closed = false;
    const r = updateState((s) => {
      const job = s.jobs[key];
      if (!job) throw new Error(`unknown job: ${key}`);
      s.stops.push({ key, kind, at: new Date().toISOString(), host: job.ats, company: job.company });
      job.inFlight = null; // a stop on one job frees its host and leaves the others handed out
      if (kind === 'chrome_disconnected') s.held.push({ reason: 'chrome_disconnected', detail: job.company });
      else if (kind === 'no_chrome_tools') {
        // The browser result reported no Chrome tools. One reason, one notification, nothing submitted, not applied.
        job.noChromeTools = true;
        if (!s.held.some((h) => h.reason === 'no_chrome_tools' && h.detail === job.company)) s.held.push({ reason: 'no_chrome_tools', detail: job.company });
      } else {
        if (kind === 'injection_suspected') job.warnings = [...new Set([...(job.warnings || []), 'injection_suspected'])];
        park(job, [kind]);
      }
      // a stop that ends the round also closes an unattended batch, in code
      if (['captcha', 'chrome_disconnected', 'no_chrome_tools'].includes(kind) && s.batch && s.batch.mode === 'unattended') {
        s.batch = null;
        closed = true;
      }
      return { parked: kind, ...(kind === 'upload_blocked' && flags.unattended !== true && !(s.batch && s.batch.mode === 'unattended') ? { say: uploadBlockedStep() } : {}) };
    });
    return out({ ...r, batchClosed: closed });
  },
  async park([key, ...reasons]) {
    return out(updateState((s) => ({ changed: park(s.jobs[key], reasons) })));
  },
  async unpark([key]) {
    return out(updateState((s) => {
      unpark(s.jobs[key]);
      if (s.jobs[key].noChromeTools) {
        s.jobs[key].noChromeTools = false;
        s.held = s.held.filter((h) => !(h.reason === 'no_chrome_tools' && h.detail === s.jobs[key].company));
      }
    }) || { ok: true });
  },
  async contacts([sub, ...keys], flags) {
    if (sub === 'count') {
      // The person's answer, kept as their contact_count rule with their words and the date. 'all' is every job that passed review.
      const v = keys[0] === 'all' ? 'all' : Number(keys[0]);
      if (v !== 'all' && !(Number.isInteger(v) && v > 0)) return out({ error: 'contacts count <number>|all [--words text]' }, 2);
      return out(addRule({ effect: 'contact_count', value: v, words: String(flags.words || `contacts for ${v} jobs`) }));
    }
    if (sub === 'route') {
      // The router's people search, in code, for the jobs asked (or every requested job). Held, never retried.
      const st = loadState();
      const log = await routeContacts({ keys: keys.length ? keys : st.contactsRequested || [], profile: readProfile(), fetch: globalThis.fetch });
      return out({ routed: log, notSearched: log.filter((l) => l.status === 'not_searched').map((l) => ({ job: l.job, reason: l.reason })) });
    }
    if (sub !== 'request') return out({ error: 'contacts request [key...] | count <n|all> | route [key...]' }, 2);
    if (!keys.length) {
      const rule = loadOverlay().rules.filter((r) => r.effect === 'contact_count').pop();
      // The first request asks how many (J ask contacts); no answer means 5, and the answer is stored once.
      if (!rule && flags.count === undefined) return out({ ask: 'contacts', next: 'J ask contacts, then J contacts count <n|all>; no answer means 5', default: 5 }, 4);
      if (!rule) addRule({ effect: 'contact_count', value: flags.count === 'default' ? 5 : Number(flags.count), words: String(flags.words || 'contacts for 5 jobs (no answer, the default)') });
      const cur = loadOverlay().rules.filter((r) => r.effect === 'contact_count').pop();
      const n = cur.value === 'all' ? Infinity : Number(cur.value) || 5;
      keys = Object.values(loadState().jobs).filter((j) => ['reviewed', 'shortlisted', 'prepared', 'apply_ready'].includes(j.status)).sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1)).slice(0, n).map((j) => j.key);
    }
    return out(updateState((s) => {
      s.contactsRequested = [...new Set([...(s.contactsRequested || []), ...keys])];
      return { requested: s.contactsRequested.length };
    }));
  },

  async 'write-prompt'([key], flags) {
    if (flags.round) {
      // One writer call per round: the sheets that need writing, the new leads and the contacts that can be messaged.
      const st = loadState();
      const sheets = Object.values(st.jobs).filter((j) => j.status === 'shortlisted' && j.needsWriting && j.sheet && j.questions).map((j) => {
        const want = new Set(writableFields(j.sheet).map((u) => u.label));
        return { job: j, fields: j.questions.filter((q) => want.has(q.label)) };
      }).filter((x) => x.fields.length);
      const leads = (st.leads || []).filter((l) => l.status === 'new' && !l.intro);
      const intros = Object.values(st.jobs).map((j) => ({ job: j, contacts: (st.contacts[j.key] || []).filter((c) => c.channel && !c.intro) })).filter((x) => x.contacts.length);
      try {
        return out(buildRoundRequest({ sheets, leads, intros, profile: readProfile() }));
      } catch (e) {
        return out({ nothing: true, note: e.message });
      }
    }
    if (flags.leads) {
      return out(buildLeadIntroRequest({ leads: (loadState().leads || []).filter((l) => l.status === 'new' && !l.intro), profile: readProfile() }));
    }
    if (flags.intros) {
      const st = loadState();
      const j = st.jobs[flags.intros];
      return out(buildIntroRequest({ job: j, profile: readProfile(), contacts: st.contacts[j.key] || [] }));
    }
    const s = loadState();
    const profile = readProfile();
    if (flags.contacts) {
      const jobs = String(flags.contacts).split(',').map((k) => s.jobs[k]).filter(Boolean);
      return out(buildContactMessageRequest({ jobs, profile, contacts: jobs.flatMap((j) => s.contacts[j.key] || []) }));
    }
    return out(buildWritingRequest({ job: s.jobs[key], profile, questions: loadQuestions(flags.questions) }));
  },
  async 'write-result'([key], flags) {
    if (flags.round) {
      const profile = readProfile();
      const r = parseRoundResult(fs.readFileSync(flags.result, 'utf8'));
      return out(updateState((s) => {
        const sheets = applyRoundDrafts(s, r.answers, profile);
        const leads = saveLeadIntros(s, r.leads);
        let intros = 0;
        let refused = 0;
        for (const [jk, byName] of Object.entries(r.intros)) {
          for (const [name, v] of Object.entries(byName)) {
            try {
              applyOp(s, { op: 'intro', key: jk, name, subject: v.subject, text: v.text });
              intros++;
            } catch {
              refused++;
            }
          }
        }
        logRun(s, 'writer', sheets.written + sheets.stopped + leads + intros);
        return { ...sheets, leads, intros, refused };
      }));
    }
    const profile = readProfile();
    const r = parseWritingResult(fs.readFileSync(flags.result, 'utf8'), loadQuestions(flags.questions), profile);
    updateState((s) => {
      logRun(s, 'writer', 1);
      const job = s.jobs[key];
      job.drafts = { ...(job.drafts || {}), ...r.drafts };
      if (!r.ok) {
        job.status === 'shortlisted' && (job.status = 'stopped');
        s.held.push({ reason: 'stopped', detail: `${job.company}: writing failed` });
      }
    });
    return out(r, r.ok ? 0 : 4);
  },

  // The default report is short: one count line, the jobs planned, and what needs the person now. `--all` is the full report.
  // The full report is always saved to the reports folder.
  async report(_, flags) {
    const s = loadState();
    const all = flags.all === true;
    const base = { since: s.lastReportAt, profile: readProfile() };
    const full = renderReport(s, loadOverlay(), base);
    const text = all ? full : renderReport(s, loadOverlay(), { ...base, short: true });
    const dir = ensureDir(path.join(stateDir(), 'reports'));
    fs.appendFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.md`), `${full}\n\n`, { mode: 0o600 });
    updateState((st) => {
      st.lastReportAt = new Date().toISOString();
      if (all) {
        st.updateLines = [];
        st.dropLines = [];
        st.hostsReported = [...new Set([...(st.hostsReported || []), ...firstApplicationHosts(st).map((h) => h.host)])];
        if ((st.found || []).length) st.watchTipShown = true;
      }
      for (const c of st.consentLog || []) c.acked = true;
      markShown(st); // the person is shown the waiting items now: no push repeats them
    });
    process.stdout.write(text + '\n');
    // The reply ends with one line on what Tenjin adds. It is not part of the report file. No price.
    if (!findTenjin()) process.stdout.write('\nTenjin is not installed. With it I can also search X live, add more job-board listings and find people to write to. Ask me to set it up.\n');
  },

  async release([sub], flags) {
    const state = loadState();
    if (sub === 'check') {
      const r = await checkRelease({ fetchImpl: globalThis.fetch, runner: asyncRun });
      recordRelease(r);
      return out(r);
    }
    if (sub === 'apply') {
      const w = state.update.waiting;
      if (!w) return out({ error: 'no update waits' }, 2);
      const m = readJson(path.join(SKILL_DIR, 'manifest.json'), {});
      const r = await applyUpdate({ tag: w.tag, writingTag: w.writingTag, change: w.change, runner: asyncRun, previousTag: `job-search-v${m.version}`, previousWriting: m.writing });
      recordRelease(r);
      return out(r);
    }
    return out({ error: 'release check | apply (after the person says yes)' }, 2);
  },

  async ingest([file]) {
    if (!file) return out({ error: 'ingest <file>' }, 2);
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      obj = null;
    }
    const state = loadState();
    const r = await ingest({ obj, state, profile: readProfile(), overlay: loadOverlay(), fetch: globalThis.fetch });
    if (obj) updateState((s) => releaseClaims(s, (key) => key === obj.jobKey || (Array.isArray(obj.batch) && key.startsWith('posts:')) || key === `need:${obj.need}` || (obj.need === 'web_search' && (key === 'web' || key === 'search'))));
    if (obj && !r.held.length) updateState((s) => logRun(s, obj.need === 'web_search' ? 'web_search' : obj.need === 'careers_page' ? 'careers' : Array.isArray(obj.batch) ? 'post_review' : obj.need === 'people_search' ? 'contacts' : 'search', 1));
    return out(r, r.held.length && !r.added && !r.applyYourself && !r.posts ? 4 : 0);
  },
  // The routed search did not run: no Tenjin, or no request tool before the next session.
  async routed([sub, ...reason]) {
    if (sub !== 'skip') return out({ error: 'routed skip <reason>' }, 2);
    return out(updateState((s) => {
      s.routed = { ...s.routed, skipReason: reason.join(' ') || 'not run', lastSearchAt: new Date().toISOString() };
      return s.routed;
    }));
  },
  // Reach-out leads: hiring posts with no job posting. The intro is a draft the person sends themselves.
  async leads([sub, ...rest], flags) {
    if (sub === 'save') {
      const r = parseIntroResult(fs.readFileSync(flags.result, 'utf8'));
      return out(updateState((s) => {
        const n = saveLeadIntros(s, r);
        logRun(s, 'writer', n);
        return { saved: n };
      }));
    }
    if (sub === 'mark') {
      const [url, state] = rest;
      if (!['done', 'not_interested'].includes(state)) return out({ error: 'leads mark <url> done|not_interested' }, 2);
      return out(updateState((s) => {
        const k = leadKey(url);
        const l = (s.leads || []).find((x) => x.key === k);
        if (!l) throw new Error('no such lead');
        l.status = state; // kept as a dedupe key, never shown again
        return { marked: state };
      }));
    }
    return out({ error: 'leads save --result file | mark <url> done|not_interested' }, 2);
  },
  async hn(_, flags) {
    const budgetMs = flags.budget ? Number(flags.budget) * 1000 : DEFAULT_BUDGET_MS;
    return out(await runHn({ fetch: globalThis.fetch, profile: readProfile(), state: loadState(), budgetMs }));
  },
  // Fill-only: per job, or with a fill_only rule. Fill, read back, never submit, leave the tab open.
  // The person applies on LinkedIn. The skill only shows the job's own link and the prepared answers; it never opens,
  // fetches or fills LinkedIn. `applied` is recorded only on the person's word.
  async linkedin([sub, key, answer]) {
    const profile = readProfile();
    if (sub === 'show') {
      const res = updateState((s) => {
        const job = s.jobs[key];
        if (!job || !job.linkedinUrl) throw new Error('that job has no LinkedIn link');
        if (applyPathOf(job, profile) !== 'linkedin') throw new Error('that job goes to the employer\'s site under your choice');
        job.linkedinShownAt = job.linkedinShownAt || new Date().toISOString();
        job.broughtAt = job.broughtAt || job.linkedinShownAt;
        const answers = job.sheet ? (job.sheet.fields || []).map((f) => ({ label: f.label, value: f.tag === 'upload' ? 'your resume' : f.value, tag: f.tag })) : [];
        return { key, company: job.company, title: job.title, link: job.linkedinUrl, answers, facts: job.sheet ? undefined : profile.facts || {}, note: job.sheet ? 'answers from the employer posting\'s questions; LinkedIn\'s own questions are yours to answer' : 'no employer form was found: the facts above and a short note you draft from the resume, facts only from the profile' };
      });
      return out(res);
    }
    if (sub === 'applied') {
      if (!['yes', 'not_yet', 'skip'].includes(answer)) return out({ error: 'linkedin applied <key> yes|not_yet|skip' }, 2);
      return out(updateState((s) => {
        const job = s.jobs[key];
        if (!job || !job.linkedinShownAt) throw new Error('its LinkedIn link was not shown yet');
        if (answer === 'yes') {
          const at = new Date().toISOString();
          job.status = 'submitted';
          job.statusAt = at;
          job.applied = { source: 'person', via: 'linkedin', at };
          s.applications.push({ key: job.key, companyKey: companyTitleKey(job), at, source: 'person' });
          bump(job);
        } else if (answer === 'skip') {
          applyOp(s, { op: 'transition', key, to: 'skipped', reason: 'the person skipped it after the LinkedIn link' });
        } else job.linkedinAskedV = itemVersion(job);
        return { key, recorded: answer };
      }));
    }
    return out({ error: 'linkedin show <key> | applied <key> yes|not_yet|skip' }, 2);
  },
  // The last check right before the submit click: the browser subagent presses submit only on yes.
  async 'may-submit'([key, hash]) {
    if (!key || !hash) return out({ error: 'may-submit <key> <sheet hash>' }, 2);
    const r = maySubmit(loadState(), readProfile(), loadOverlay(), key, hash, batch.isActive());
    return out(r, r.ok ? 0 : 4);
  },
  // Whether the Claude in Chrome tools are in this session, recorded at every start and after a /chrome reconnect. With them
  // off, options that need them carry a note. On clears every Chrome hold, so those jobs go back to the normal flow in this turn.
  // Whether Remote Control looks connected in this session (Claude Code's own session note is there), recorded at each start next to
  // `chrome set`. Code never reads Claude Code's config file.
  // The uploads folder grant: `granted` records one the model saw in the session (a /add-dir it watched, or a starting folder that
  // covers it). Code never writes Claude Code's settings.
  async uploads([sub, v]) {
    if (sub === 'set' && v === 'granted') return out(updateState((s) => { s.uploads = 'granted'; return { folder: uploadsDir(), granted: true }; }));
    if (sub === 'status' || !sub) {
      const granted = uploadsGranted({ recorded: loadState().uploads === 'granted' });
      return out({ folder: uploadsDir(), granted, ...(granted ? {} : { say: uploadsLine() }) });
    }
    return out({ error: 'uploads status | set granted' }, 2);
  },
  async rc([sub, v]) {
    if (sub !== 'set' || !['on', 'unknown'].includes(v)) return out({ error: 'rc set on|unknown' }, 2);
    return out(updateState((s) => { s.rc = v; return { rc: v, reminder: qs.rcReminder({ rc: v, pushSent: s.pushSent === true, settings: pushSettings() }) }; }));
  },
  async chrome([sub, v]) {
    if (sub !== 'set' || !['on', 'off'].includes(v)) return out({ error: 'chrome set on|off' }, 2);
    return out(updateState((s) => {
      s.chrome = v;
      let cleared = 0;
      if (v === 'on') {
        const n = s.held.length;
        s.held = s.held.filter((h) => !['chrome_disconnected', 'no_chrome_tools'].includes(h.reason));
        cleared = n - s.held.length;
        for (const j of Object.values(s.jobs)) if (j.noChromeTools) { j.noChromeTools = false; cleared++; }
      }
      return { chrome: v, cleared, ...(v === 'off' ? { steps: CHROME_STEPS } : {}) };
    }));
  },
  // "Just open the pages": the OS's own open command, in the person's default browser, with the job's exact URL. Attended turns only.
  async open(keys) {
    if (!keys.length) return out({ error: 'open <key...>' }, 2);
    if (batch.isActive() && batch.batchMode() === 'unattended') return out({ error: 'pages open only in an attended turn' }, 4);
    const st = loadState();
    const profile = readProfile();
    const res = [];
    for (const k of keys) {
      const job = st.jobs[k];
      const url = job ? openUrlOf(job, profile) : null;
      if (!url) { res.push({ key: k, opened: false, why: 'nothing to open for this job' }); continue; }
      const bad = checkOpenUrl(url);
      if (bad) { res.push({ key: k, opened: false, why: bad }); continue; }
      const r = openPage(url);
      res.push({ key: k, url, opened: r.ok, ...(r.ok ? {} : { why: r.why }), sheet: job.sheet ? (job.sheet.fields || []).map((f) => ({ label: f.label, value: f.tag === 'upload' ? 'your resume' : f.value, tag: f.tag })) : [] });
      if (r.ok) updateState((s) => { s.jobs[k].openedAt = new Date().toISOString(); s.jobs[k].broughtAt = s.jobs[k].broughtAt || s.jobs[k].openedAt; bump(s.jobs[k]); });
    }
    return out({ opened: res.filter((x) => x.opened).length, results: res, next: 'show each opened job\'s sheet as text; the outcome is the person\'s word: J submitted <key>' });
  },
  // A voluntary demographic answer, per field, kept for a later form only when the same option text is offered.
  async eeo([sub, label, ...rest]) {
    if (sub !== 'set' || !label || !rest.length) return out({ error: 'eeo set <field label> <answer>' }, 2);
    const profile = readProfile();
    const cur = profile.eeo && typeof profile.eeo === 'object' ? profile.eeo : { answers: {} };
    const nl = String(label).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    const next = { ...profile, eeo: { answers: { ...(cur.answers || {}), [nl]: rest.join(' ') } } };
    const bad = validateProfile(next);
    if (bad.length) return out({ error: bad.join('; ') }, 2);
    writeJsonAtomic(profileFile(), next);
    return out({ saved: label });
  },
  async fillonly([key, onoff]) {
    return out(updateState((s) => {
      if (!s.jobs[key]) throw new Error(`unknown job: ${key}`);
      s.jobs[key].fillOnly = onoff !== 'off';
      return { fillOnly: s.jobs[key].fillOnly };
    }));
  },
  // The person's own yes to a form's legal acknowledgment (or, in fill-only, its attestation): the fill ticks it.
  async agree([key, ...label]) {
    if (!key || !label.length) return out({ error: 'agree <key> <the acknowledgment\'s label>' }, 2);
    return out(updateState((s) => {
      const job = s.jobs[key];
      if (!job) throw new Error(`unknown job: ${key}`);
      (job.acks ||= {})[normLabelFn(label.join(' '))] = new Date().toISOString();
      bump(job);
      return { acknowledged: label.join(' '), next: `rebuild and check the sheet against the live form: J sheet build ${key} --questions <live file>, then J sheet check ${key} --live <file>` };
    }));
  },
  async fill([sub, key]) {
    if (sub !== 'done') return out({ error: 'fill done <key>' }, 2);
    return out(updateState((s) => markFillReady(s, key)));
  },
  // The person says they submitted it.
  async submitted([key]) {
    return out(updateState((s) => {
      markSubmitted(s, key, applyOp);
      return { submitted: key };
    }) || { submitted: key });
  },

  // After a search round is ingested: code decides whether another round (the next role-word variant) is worth it.
  async search([sub, kind], flags) {
    const profile = readProfile();
    if (sub === 'plan') {
      if (!profile.search || !profile.search.role) return out({ error: 'no search role in the profile' }, 2);
      const st = loadState();
      // Ask first: while the session's Tenjin ask is due, the ask is printed in place of the free queries.
      const ask = askFirst(st, 'daily_search', { unattended: flags.unattended === true || batch.isActive() && batch.batchMode() === 'unattended' });
      if (ask) return out(ask);
      const round = st.search.webPending ? st.search.webPending.round : st.search.session ? st.search.session.round : 0;
      return out(webPlan(profile, round, st.routed.lastSearchAt));
    }
    if (sub === 'web-done') return out(updateState((s) => { s.search.webPending = null; return { done: true }; }));
    if (sub === 'done') return out(updateState((s) => { s.search.needPending = (s.search.needPending || []).filter((n) => n.kind !== kind); return { done: kind }; }));
    if (sub !== 'next') return out({ error: 'search plan | next | web-done | done <need kind>' }, 2);
    return out(updateState((s) => advanceSearch(s, profile)));
  },

  // The start: the resume (a file, a link or the text), then one question-tool call (apply mode, search frequency,
  // positions), then the `/rc` reminder line. Remote Control is not a question.
  async start([sub], flags) {
    const profile = readProfile();
    const st = loadState();
    if (sub === 'status' || !sub) {
      const missing = [];
      if (!profile.resumeText && !profile.resumePath) missing.push('resume');
      if (!profile.applyMode || !profile.frequency || !(st.start && st.start.positionsAt) || !(profile.apply && profile.apply.where)) missing.push('start_questions');
      return out({ missing, next: missing[0] === 'resume' ? 'Job Search is set up and watching, and this is the first run, so I need one thing to start: can you share your resume? Drop the file here, paste a link, or paste the text. I\'ll take your role, location and remote preference from it, then ask four quick choices and run the first search.' : missing.length ? 'J ask start, then J start record' : 'run the free search and the report', start: st.start || null });
    }
    if (sub !== 'record') return out({ error: 'start status | record --mode m --frequency f --catch-up n --per-day n|none (or --positions n|none|skip, or --no-limit) --where employer|linkedin|ask [--words text]' }, 2);
    if (flags.where !== undefined && !['employer', 'linkedin', 'ask'].includes(flags.where)) return out({ error: 'where must be employer, linkedin or ask' }, 2);
    if (!['attended', 'auto_no_new', 'auto_write', 'fill_only', 'open_only'].includes(flags.mode || 'attended')) return out({ error: 'mode must be attended, auto_no_new, auto_write, fill_only or open_only' }, 2);
    if (flags.frequency && !FREQUENCIES.includes(flags.frequency)) return out({ error: 'frequency must be daily, twice_daily or weekly' }, 2);
    const mode = flags.mode || 'attended';
    const frequency = flags.frequency || 'daily';
    // No answer to the count means no limit: nothing is recorded. A catch-up and a daily number are one rule.
    let positions = 'skip';
    if (flags['per-day'] !== undefined || flags['catch-up'] !== undefined) {
      const perDay = flags['per-day'] === undefined ? 'none' : coerce(flags['per-day']);
      const catchUp = flags['catch-up'] === undefined ? null : coerce(flags['catch-up']);
      positions = `${catchUp === null ? '' : `${catchUp} now, `}${perDay === 'none' ? 'no daily limit' : `${perDay} daily`}`;
      addRule({ effect: 'period_max', value: { catchUp, perDay, at: new Date().toISOString() }, words: String(flags.words || `positions: ${positions}`) });
    } else if (flags['no-limit'] === true || flags.positions === undefined || flags.positions === true || flags.positions === 'skip') {
      positions = 'skip'; // "No limit" and no answer record nothing
    } else {
      positions = String(flags.positions);
      addRule({ effect: 'period_max', value: positions === 'none' ? 'none' : coerce(positions), words: String(flags.words || `positions per period: ${positions}`) });
    }
    // No answer to where means the employer's site, recorded as the person's own setting.
    const where = flags.where || 'employer';
    writeJsonAtomic(profileFile(), { ...profile, applyMode: mode, frequency, frequencySource: 'person', apply: { where, source: 'person' } });
    const now = new Date().toISOString();
    updateState((s) => {
      s.start = { ...(s.start || {}), modeAt: now, frequencyAt: now, positionsAt: now, whereAt: now };
    });
    return out({ recorded: { mode, frequency, positions, where }, reminder: qs.rcReminder({ rc: st.rc || 'unknown', pushSent: st.pushSent === true, settings: pushSettings() }), note: ['attended', 'fill_only', 'open_only'].includes(mode) ? 'no consent is needed for this mode' : 'an auto mode also needs the unattended rules shown back, a clear yes, then consent record (and consent record writing for Fully auto apply)' });
  },
  // The payload for Claude Code's question tool, so the questions are asked as choices, never as a list in prose.
  async ask([kind], flags) {
    const arg = flags.json ? readJsonArg(flags.json) : {};
    if (kind === 'approval') {
      const job = loadState().jobs[flags.key];
      if (!job || !job.sheet) return out({ error: 'ask approval --key <job>: prepare its sheet first' }, 2);
      updateState((st) => { markShown(st, [`yes:${flags.key}`]); }); // the application is shown with this call: no push repeats it
      { const ap = qs.approvalQuestions(job, applyPathOf(job, readProfile()), { chromeOff: loadState().chrome === 'off' }); const bad = ap.questions.length ? qs.validateAsk(ap) : []; return bad.length ? out({ error: bad.join('; ') }, 2) : out(ap); }
    }
    if (kind === 'approve-pick') return out({ groups: qs.approvePickQuestions(readySheets(loadState()), { chromeOff: loadState().chrome === 'off' }) });
    if (kind === 'applied') {
      const job = loadState().jobs[flags.key];
      if (!job || !job.linkedinShownAt) return out({ error: 'ask applied --key <job>: its LinkedIn link was not shown yet' }, 2);
      return out(qs.appliedQuestion(job));
    }
    const make = { approve: () => qs.approveListQuestion(readySheets(loadState()).length, { chromeOff: loadState().chrome === 'off' }), start: () => qs.startQuestions({ chromeOff: loadState().chrome === 'off', rc: loadState().rc || 'unknown', pushSent: loadState().pushSent === true, settings: pushSettings() }), auto: () => qs.autoModeQuestion({ chromeOff: loadState().chrome === 'off' }), place: () => qs.placeQuestion(arg), role: () => qs.roleQuestion(arg), acknowledge: () => qs.acknowledgeQuestion(arg), follow_up_detail: () => qs.followUpDetail(arg), resume: () => qs.resumeChoiceQuestion(arg), tenjin: () => qs.tenjinAsk(arg), eeo: () => qs.eeoFieldQuestion(arg), follow_up: () => qs.followUpQuestion(arg), contacts: () => qs.contactsCountQuestion(), 'optional-writing': () => qs.optionalWritingQuestion(), fact: () => qs.factQuestion(arg), yes: () => qs.sheetYesQuestion(arg), email: () => qs.emailBatchQuestion(em.addBatchPeek(loadState()), flags.group === undefined ? null : Number(flags.group)), 'email-mode': () => qs.emailModeQuestion() }[kind];
    if (!make) return out({ error: 'ask start | auto | place --json {guess,remote} | role --json {guess} | acknowledge --json {company,text,link} | follow_up_detail --json {company} | resume --json {header,question,guess,next} | tenjin --json {line,status} | eeo --json {label,options} | optional-writing | fact --json {label,options} | yes --json {company,title} | email | email-mode | approve | approve-pick | approval --key <job>' }, 2);
    if (batch.isActive() && batch.batchMode() === 'unattended') return out({ error: 'no questions in an unattended turn: nobody can answer; hold the job and notify' }, 4);
    const p = make();
    if (p.plain) return out(p); // a plain question: ask it in words, with the guess in its text
    const bad = qs.validateAsk(p);
    return bad.length ? out({ error: bad.join('; ') }, 2) : out(p);
  },
  async frequency([sub, f]) {
    if (sub !== 'set' || !FREQUENCIES.includes(f)) return out({ error: 'frequency set daily|twice_daily|weekly' }, 2);
    writeJsonAtomic(profileFile(), { ...readProfile(), frequency: f, frequencySource: 'person' });
    return out({ frequency: f });
  },
  // A form fact the person gave: kept in the profile, and the jobs that waited for it go back in the queue.
  async fact([sub, name, ...rest]) {
    if (sub !== 'set' || !name || !rest.length) return out({ error: 'fact set <name> <value>' }, 2);
    const profile = readProfile();
    // `account` is a list of hosts where the person has an account: each call adds one.
    const value = name === 'account' ? [...new Set([...String((profile.facts || {}).account || '').split(/[\s,]+/).filter(Boolean), ...rest.join(' ').split(/[\s,]+/).filter(Boolean)])].join(' ') : rest.join(' ');
    const next = { ...profile, facts: { ...(profile.facts || {}), [name]: value } };
    const bad = validateProfile(next);
    if (bad.length) return out({ error: bad.join('; ') }, 2);
    writeJsonAtomic(profileFile(), next);
    return out({ saved: name, resumed: resumeHeld(next) });
  },
  // Watched boards the skill found itself, and the person's removals. A removed company is never added again.
  async watch([sub, name], flags) {
    if (!sub) {
      // the watcher: a background command that exits when work is due
      const r = await runWatcher({ fetchImpl: globalThis.fetch, runner: asyncRun });
      process.exitCode = r.exit;
      return;
    }
    if (sub === 'list') return out({ found: loadState().found || [], pasted: readProfile().watch || [], removed: loadState().removedBoards || [] });
    if (sub !== 'remove' || !name) return out({ error: 'watch list | remove <company or board>' }, 2);
    return out(updateState((s) => {
      const hit = (b) => [b.board, b.name].some((x) => String(x).toLowerCase() === name.toLowerCase());
      const gone = (s.found || []).filter(hit);
      s.found = (s.found || []).filter((b) => !hit(b));
      s.removedBoards = [...new Set([...(s.removedBoards || []), ...gone.map((b) => b.board), name.toLowerCase()])];
      return { removed: gone.length, never_again: name };
    }));
  },
  // Example intros: one writer call per job, for the contacts with a channel. Never sent.
  async intros([sub, key], flags) {
    if (sub !== 'save') return out({ error: 'intros save <key> --result file' }, 2);
    const r = parseIntroResult(fs.readFileSync(flags.result, 'utf8'));
    const ops = Object.entries(r).map(([name, v]) => ({ op: 'intro', key, name, subject: v.subject, text: v.text }));
    updateState((s) => logRun(s, 'writer', ops.length));
    return out(applyOps(ops));
  },
  async ack() {
    return out(updateState((s) => { for (const c of s.consentLog || []) c.acked = true; return { acked: true }; }));
  },

  // A search round in code through the router, for one attended or manual run. The watcher does the same on its tick.
  async route() {
    const profile = readProfile();
    if (!profile.search || !profile.search.role) return out({ error: 'no search role in the profile' }, 2);
    const log = await routedRounds({ profile, fetch: globalThis.fetch });
    return out({ rounds: log });
  },

  // "Leave it": the item stays in the report but is not due work until there is news about the job, an answer from the
  // person, or a rule that affects it. Every handled item ends with its J outcome command, or the watcher shows it again.
  async leave(keys, flags) {
    const jobs = keys.filter((k) => itemKind(k) === 'job');
    const allowed = [...LEAVE_REASONS, ...Object.values(ITEM_LEAVE_REASONS).flat()];
    if (!keys.length || !allowed.includes(flags.reason)) return out({ error: `leave <key...> --reason <${LEAVE_REASONS.join('|')}> for jobs; ${Object.entries(ITEM_LEAVE_REASONS).map(([k, v]) => `${k === 'search' ? 'search, web, need:<kind>' : 'contacts:<key>'}: ${v.join('|')}`).join('; ')}` }, 2);
    const overlay = loadOverlay();
    const profile = readProfile();
    return out(updateState((s) => {
      for (const k of jobs) if (!s.jobs[k]) throw new Error(`unknown job: ${k}`);
      for (const k of keys) {
        if (itemKind(k) === 'job') {
          if (!LEAVE_REASONS.includes(flags.reason)) throw new Error(`the reason for a job is one of ${LEAVE_REASONS.join(', ')}`);
          s.jobs[k].left = leaveRecord(s, s.jobs[k], overlay, flags.reason, profile);
        } else leaveItem(s, k, flags.reason, profile);
      }
      releaseClaims(s, (key) => keys.includes(key) || keys.includes(`contacts:${key}`) || keys.some((k) => k === `contacts:${key}`));
      return { left: keys.length, reason: flags.reason, ...(keys.some((k) => itemKind(k) === 'contacts') && flags.unattended !== true ? { askTenjin: askFirst(s, 'contacts') } : {}) };
    }));
  },
  // The person said "try again" about a job: it is due work again.
  async retry(keys) {
    return out(updateState((s) => {
      for (const k of keys) {
        if (s.jobs[k]) s.jobs[k].left = null;
        if (s.leftItems && s.leftItems[k]) delete s.leftItems[k];
      }
      return { retried: keys.length };
    }));
  },

  // What happened with an application, from the person: the follow-up item's outcome command.
  async outcome([key], flags) {
    const to = { reply: null, interview: 'interview', rejected: 'rejected', offer: 'offer', no_reply: null, withdrawn: 'withdrawn' }[flags.status];
    if (!key || flags.status === undefined || (to === undefined)) return out({ error: 'outcome <key> --status reply|interview|rejected|offer|no_reply|withdrawn' }, 2);
    return out(updateState((s) => {
      const job = s.jobs[key];
      if (!job) throw new Error(`unknown job: ${key}`);
      applyOp(s, { op: 'signal', kind: flags.status === 'no_reply' ? 'no_reply' : flags.status });
      if (to) applyOp(s, { op: 'transition', key, to });
      job.followUpAsked = new Date().toISOString(); // asked: not due again until something changes
      return { recorded: flags.status, status: job.status };
    }));
  },

  // Email goes out through the person's Gmail connector, which only the model can call. Code hands out only what may go.
  async email([sub, ...rest], flags) {
    const profile = readProfile();
    const overlay = loadOverlay();
    if (sub === 'batch') {
      // the round's drafts, after they are written; the first batch asks the mode once
      const r = updateState((s) => {
        const list = em.addBatch(s);
        const e = em.emailState(s);
        return { drafts: list.map((c) => ({ id: c.id, to: c.to, subject: c.subject, text: c.text, employer: c.employer, role: c.role })), mode: em.emailConsentCurrent(s, profile, overlay) ? 'auto' : 'ask', askMode: !e.modeAsked && !em.emailConsentCurrent(s, profile, overlay), connector: e.connector };
      });
      return out({ ...r, next: r.drafts.length ? (r.askMode ? 'J ask email-mode first (J email mode ask|auto), then J ask email, then J email approve <ids>' : r.mode === 'auto' ? 'J email next --unattended' : 'J ask email, then J email approve <ids> --skip-rest') : 'no drafts' });
    }
    if (sub === 'mode') {
      if (rest[0] !== 'ask') return out({ error: 'email mode ask (the person picked "Ask me each batch"); "send without asking" is J consent record email' }, 2);
      return out(updateState((s) => { em.emailState(s).modeAsked = new Date().toISOString(); return { mode: 'ask' }; }));
    }
    if (sub === 'connector') {
      if (!['send', 'drafts', 'none'].includes(rest[0])) return out({ error: 'email connector send|drafts|none (what the Gmail connector offers; none when it is not connected)' }, 2);
      return out(updateState((s) => { em.emailState(s).connector = rest[0]; return { connector: rest[0] }; }));
    }
    if (sub === 'approve') {
      if (!rest.length) return out({ error: 'email approve <id...> [--skip-rest]' }, 2);
      return out(updateState((s) => em.approve(s, rest, { skipRest: flags['skip-rest'] === true })));
    }
    if (sub === 'next') {
      const unattended = flags.unattended === true;
      const r = updateState((s) => em.nextEmail(s, { profile, overlay, unattended }));
      return out(r);
    }
    if (sub === 'sent') {
      const [id, messageId] = rest;
      if (!id) return out({ error: 'email sent <id> [message id] [--drafted|--shown]' }, 2);
      const how = flags.drafted === true ? 'drafted' : flags.shown === true ? 'shown' : 'sent';
      return out(updateState((s) => { logRun(s, 'email', 1); return em.markSent(s, id, { messageId: messageId || null, how }); }));
    }
    return out({ error: 'email batch | mode ask | connector send|drafts|none | approve <id...> | next [--unattended] | sent <id> [message id]' }, 2);
  },

  // The resume, in any form: a file, a link or the text. Read once; a link is not read again unless a new one is given.
  async resume([sub], flags) {
    if (sub !== 'set') return out({ error: 'resume set --file <path> | --url <link> | --text (the text on standard input, or --text "...")' }, 2);
    const profile = readProfile();
    let r;
    if (flags.file) r = rs.setFile(String(flags.file));
    else if (flags.url) r = await rs.setFromLink({ url: String(flags.url), state: loadState() });
    else if (flags.text !== undefined) {
      const text = flags.text === true ? fs.readFileSync(0, 'utf8') : String(flags.text);
      r = { read: true, ...rs.setText(text, { source: profile.resumeNeedsText ? profile.resumeSource || 'file' : 'text' }) };
      if (profile.resumeNeedsText) r.keepFile = true;
    } else return out({ error: 'resume set --file <path> | --url <link> | --text' }, 2);
    if (r.ask === true) r = { ...r, ask: r.why };
    if (r.ask || r.read === false) return out({ read: false, ...r });
    ensureDir(stateDir());
    const next = { ...profile, resumeSource: r.source, resumeText: r.resumeText !== undefined ? r.resumeText : r.keepFile ? profile.resumeText : undefined, resumeNeedsText: Boolean(r.needsText), resumeThin: r.thin === true };
    if (r.resumePath) next.resumePath = r.resumePath;
    else if (!r.keepFile) delete next.resumePath;
    // The file a form takes: a copy in the uploads folder (a link's PDF is saved there directly); the original is not touched.
    if (r.resumeUploadPath) next.resumeUploadPath = r.resumeUploadPath;
    else if (r.source === 'file' && r.resumePath) next.resumeUploadPath = copyToUploads(r.resumePath);
    else if (!r.keepFile) delete next.resumeUploadPath;
    if (r.url) next.resumeUrl = r.url;
    else if (!r.keepFile) delete next.resumeUrl;
    writeJsonAtomic(profileFile(), next);
    // Right after a file is saved, and before any fill: one plain line, unless a settings grant already covers the uploads folder.
    const needLine = Boolean(next.resumeUploadPath) && !uploadsGranted({ recorded: loadState().uploads === 'granted' });
    return out({ ...(needLine ? { say: uploadsLine() } : {}), read: true, source: next.resumeSource, saved: r.resumeTextFile || r.resumePath || null, needsText: next.resumeNeedsText, next: next.resumeNeedsText ? 'read the file with your file reader, then save its text: J resume set --text' : next.resumeThin ? 'a LinkedIn profile has employers but no job titles: confirm the target role with a choice question, your guess first (J ask resume --json {header,question,guess,next,source:"LinkedIn"}); a form that needs more asks for a file or the text' : 'read role, role words, place and remote from the resume' });
  },

  // Items shown to the person in a reply: they leave the notify set until their version changes.
  async shown(keys, flags) {
    return out(updateState((s) => ({ shown: markShown(s, flags.all === true || !keys.length ? null : keys) })));
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
      const say = result === 'not_sent' && !s.rcPushSaid ? qs.rcAtPush(reason, pushSettings()) : null;
      if (say) s.rcPushSaid = true;
      return { recorded: result, ...(reason ? { reason } : {}), say };
    }));
  },

  async gates(_, flags) {
    const h = gatesHash();
    if (flags.write) {
      const f = path.join(SKILL_DIR, 'manifest.json');
      const m = readJson(f, {});
      writeFileSync(f, JSON.stringify({ ...m, gatesHash: h }, null, 2) + '\n');
    }
    return out({ gatesHash: h });
  },

  async signals() {
    return out(observations(loadState()));
  },
};

// A lead's intro must fit its channel. Never sent.
function saveLeadIntros(s, r) {
  let n = 0;
  for (const l of s.leads || []) {
    const v = r[l.url];
    if (!v) continue;
    const text = String(v.text).trim();
    if (l.channel === 'email' ? !String(v.subject || '').trim() || text.split(/\s+/).length > 120 : text.length > 300) throw new Error(`the intro for ${l.url} does not fit its channel`);
    l.intro = { channel: l.channel, subject: l.channel === 'email' ? v.subject : null, text, writtenAt: new Date().toISOString() };
    n++;
  }
  joinLeads(s);
  return n;
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return /^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : v;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  if (!commands[cmd]) return out({ error: `unknown command: ${cmd}`, commands: Object.keys(commands) }, 2);
  // A command that changes what a submit may do is refused while a batch is open, whoever calls it.
  if (batch.isBatchDenied(cmd, pos[0]) && batch.isActive()) return out({ error: `${cmd} ${pos[0] || ''} is refused while a batch is open; close it in an attended session first`.replace('  ', ' ') }, 4);
  // An install from before the uploads folder: the first command that sees a saved resume file with no copy there copies it.
    try { const prof = readProfile(); const m = migrateResume(prof); if (m) writeJsonAtomic(profileFile(), { ...prof, ...m }); } catch {}
  try {
    await commands[cmd](pos, flags);
    if (cmd !== 'watch') touchLease();
    // The person's next turn lifts the "not sent" stop on notify-only wakes (only a person runs these).
    if (['report', 'approve', 'submitted', 'ask', 'answer', 'fact', 'start', 'resume', 'consent', 'fill'].includes(cmd)) updateState((st) => { if (st.watcher && st.watcher.notifyResult === 'not_sent') st.watcher.notifyResult = null; });
    // The person's answer is news: items left alone come back for it.
    if (!process.exitCode && (['fact set', 'profile set', 'answer add', 'writing approve'].includes(`${cmd} ${pos[0]}`) && !(cmd === 'fact' && pos[1] === 'account'))) updateState((st) => { st.answerV = (st.answerV || 0) + 1; });
  } catch (e) {
    out({ error: e.message }, 2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
export { commands };
