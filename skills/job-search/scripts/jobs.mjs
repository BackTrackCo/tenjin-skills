#!/usr/bin/env node
// Job Search runtime. Every command prints JSON. Exit 0 ok, 3 clean (empty work-list), 2 error, 4 refused.
import fs, { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { graph } from './lib/graph.mjs';
import { SKILL_DIR, ensureDir, readJson, stateDir, writeJsonAtomic } from './lib/paths.mjs';
import { applyOp, applyOps, compact, loadState, updateState, view } from './lib/store.mjs';
import { addLesson, addRule, deriveLessons, loadOverlay, removeRule } from './lib/overlay.mjs';
import { persist, runSweep } from './lib/sweep.mjs';
import { advanceSearch, park, unpark, workList } from './lib/work.mjs';
import { claimLease } from './lib/lease.mjs';
import { readProfile, tick, watcherCodeHash } from './lib/watcher.mjs';
import { applyUpdate, checkRelease, gatesHash, recordRelease } from './lib/release.mjs';
import { applyNext, confirmDryRun, recordConsent, recordDryRun, recordWritingConsent, revokeConsent } from './lib/apply.mjs';
import { addAnswer, approveWriting, loadAnswers } from './lib/answers.mjs';
import * as batch from './lib/batch.mjs';
import { hintState, defaultRun, findTenjin } from './lib/tenjin.mjs';
import { buildSheet, checkReadBack, checkSheet, parseGreenhouseQuestions } from './lib/sheet.mjs';
import { buildContactMessageRequest, buildIntroRequest, buildWritingRequest, parseIntroResult, parseWritingResult, readWritingRules } from './lib/writing.mjs';
import { renderReport } from './lib/report.mjs';
import * as qs from './lib/questions.mjs';
import { FREQUENCIES } from './lib/schedule.mjs';
import { appendPending, isCareerOpsDir, pipelineLine, readCareerOps } from './lib/careerops.mjs';
import { observations } from './lib/signals.mjs';
import { ingest } from './lib/ingest.mjs';
import { validateProfile } from './lib/profile.mjs';
import { resumeHeld } from './lib/held.mjs';
import { DEFAULT_BUDGET_MS, runHn } from './lib/hn.mjs';
import { isFillOnly, markFillReady, markSubmitted } from './lib/fillonly.mjs';

const out = (o, code = 0) => {
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
        return { asked: true, answer: answer || null };
      }));
    }
    const r = hintState();
    updateState((s) => {
      s.held = s.held.filter((h) => h.reason !== 'tenjin_missing');
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
    if (sub === 'careerops') {
      // Inside a career-ops folder: read cv.md and config/profile.yml, ask nothing they already answer.
      const dir = process.cwd();
      if (!isCareerOpsDir(dir)) return out({ detected: false });
      const co = readCareerOps(dir);
      const prof = readProfile();
      writeJsonAtomic(profileFile(), { ...prof, resumePath: path.join(dir, 'cv.md'), resumeText: co.cv, careerOps: { dir, pipeline: flags.pipeline === 'yes' } });
      return out({ detected: true, dir, pipeline: flags.pipeline === 'yes', profileYml: co.profileYml.slice(0, 20000), note: 'cv.md and config/profile.yml are read; answer the profile from them and ask only what they leave out' });
    }
    if (sub === 'stage') {
      updateState((s) => {
        s.setup = { ...s.setup, stage: rest[0] || null, next: rest[1] || null };
      });
      return out({ saved: true });
    }
    return out({ error: 'setup check | resume <path> | careerops | stage <stage> <next>' }, 2);
  },

  async profile([sub, arg]) {
    if (sub === 'get') return out(readProfile());
    if (sub === 'set') {
      ensureDir(stateDir());
      const next = { ...readProfile(), ...readJsonArg(arg) };
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
      const p = batch.openBatch({ mode: flags.unattended ? 'unattended' : 'attended', uploadPath: flags.upload || profile.resumePath });
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
    return out(applyOps(readJsonArg(arg)));
  },
  async persist([arg]) {
    return out(persist(readJsonArg(arg)));
  },
  async compact() {
    return out({ archived: updateState((s) => compact(s)) });
  },

  async rules([sub, ...rest], flags) {
    if (sub === 'add') return out(addRule({ effect: flags.effect, value: flags.value === undefined ? null : coerce(flags.value), words: flags.words }));
    if (sub === 'remove') return out({ removed: removeRule(rest[0]) });
    return out(loadOverlay().rules);
  },
  async lessons([sub, ...rest], flags) {
    if (sub === 'derive') return out(deriveLessons(loadState()));
    if (sub === 'remove') return out({ removed: removeRule(rest[0]) });
    if (sub === 'add') return out(addLesson({ effect: flags.effect, subject: flags.subject, evidence: String(flags.evidence || '').split(',').filter(Boolean) }));
    return out(loadOverlay().lessons);
  },

  async arm() {
    const holder = Math.random().toString(36).slice(2, 10);
    const r = await claimLease({ holder });
    if (!r.ok) return out({ armed: false, heldBy: r.heldBy, note: 'another session holds the lease; attended work still works' });
    const monitor = `node "${path.join(SKILL_DIR, 'scripts', 'jobs.mjs')}" watch --holder ${holder}`;
    return out({ armed: true, monitor, note: 'Run this with Monitor, persistent if the tool offers it, else timeout_ms 1800000 and run arm again at the deadline message.', view: view(loadState(), { limit: 10 }) });
  },
  async watch(_, flags) {
    const holder = flags.holder;
    const seen = { sig: null };
    const startHash = watcherCodeHash();
    for (let first = true; ; first = false) {
      const r = await tick({ holder, fetchImpl: globalThis.fetch, runner: asyncRun, firstTick: first, seen, startHash });
      for (const l of r.lines) process.stdout.write(l + '\n');
      if (r.stop) return;
      await new Promise((res) => setTimeout(res, 60000));
    }
  },

  async work(_, flags) {
    const wl = workList({ commit: flags.commit === true, unattended: flags.unattended === true });
    return out(wl, wl.exit === 0 ? 0 : 3);
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
      const res = updateState((s) => {
        const job = s.jobs[key];
        if (!job || !job.sheet) throw new Error('build the sheet first');
        const r = checkSheet(job.sheet, live);
        job.sheet.passed = r.ok;
        if (r.ok) {
          unpark(job);
          if (job.status === 'prepared') job.status = 'apply_ready';
        } else {
          // A missing form fact holds only this job, with the names of what is missing; the question comes at its trigger.
          const facts = job.sheet.unanswered.filter((u) => u.factKey).map((u) => u.factKey);
          job.missingFacts = [...new Set(facts)];
          park(job, [job.sheet.eeoMissing ? 'eeo_missing' : facts.length && facts.length === job.sheet.unanswered.length ? 'needs_facts' : job.sheet.unanswered.length ? 'unknown_field' : job.sheet.forbidden.length ? 'forbidden_field' : 'form_changed']);
        }
        return r;
      });
      return out(res, res.ok ? 0 : 4);
    }
    if (sub === 'readback') {
      const job = loadState().jobs[key];
      const r = checkReadBack(job.sheet, readJsonArg(flags.read));
      return out(r, r.ok ? 0 : 4);
    }
    return out({ error: 'sheet build <key> --questions f | check <key> [--live f] | readback <key> --read f' }, 2);
  },

  async apply([sub], flags) {
    if (sub !== 'next') return out({ error: 'apply next [--unattended]' }, 2);
    const mode = flags.unattended ? 'unattended' : 'attended';
    batch.touchBatch();
    const state = loadState();
    const res = applyNext({ state, profile: readProfile(), overlay: loadOverlay(), mode, batchOpen: batch.isActive(Date.now(), state), writingRulesText: readWritingRules() });
    let batchClosed = false;
    updateState((s) => {
      for (const q of res.queue) if (s.jobs[q.key] && !['sheet_not_checked', 'no_recorded_yes', 'no_chrome_tools'].includes(q.reason)) park(s.jobs[q.key], [q.reason]);
      if (res.handout) (s.handouts ||= []).push({ key: res.handout.key, at: new Date().toISOString(), counted: Boolean(res.handout.submit || res.handout.fillOnly) });
      // An unattended round ends in code: nothing left to submit (empty, held, parked or refused) closes the batch.
      if (mode === 'unattended' && !res.handout && s.batch && s.batch.mode === 'unattended') {
        s.batch = null;
        batchClosed = true;
      }
    });
    return out({ ...res, batchClosed }, res.handout ? 0 : 4);
  },

  async approve([key]) {
    return out(applyOps([{ op: 'approve', key, sheetHash: loadState().jobs[key].sheet.hash }]));
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
    if (sub !== 'record' || !['unattended', 'writing'].includes(which)) return out({ error: 'consent record unattended --optional-writing skip|wait | record writing | revoke unattended|writing' }, 2);
    return out(updateState((s) => {
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
      return { parked: kind };
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
  // On the person's yes at setup, each job that passed review is appended under "## Pending" in the career-ops pipeline.
  async pipeline([sub, ...keys]) {
    if (sub !== 'add') return out({ error: 'pipeline add [key...]' }, 2);
    const profile = readProfile();
    if (!profile.careerOps || profile.careerOps.pipeline !== true) return out({ error: 'the person has not said yes to the career-ops pipeline at setup' }, 4);
    return out(updateState((s) => {
      const pick = keys.length ? keys.map((k) => s.jobs[k]).filter(Boolean) : Object.values(s.jobs).filter((j) => ['reviewed', 'shortlisted', 'prepared', 'apply_ready'].includes(j.status));
      const jobs = pick.filter((j) => !j.pipelineAt);
      const lines = jobs.map((j) => pipelineLine(j, (s.contacts[j.key] || [])[0] || null));
      const n = appendPending(profile.careerOps.dir, lines);
      for (const j of jobs) j.pipelineAt = new Date().toISOString();
      return { appended: n, next: 'Tell the person that /career-ops pipeline scores these jobs and tailors their CV.' };
    }));
  },
  async contacts([sub, ...keys]) {
    if (sub !== 'request') return out({ error: 'contacts request [key...] (5 jobs, or the contact_count rule, when none are named)' }, 2);
    if (!keys.length) {
      const n = Number(loadOverlay().rules.filter((r) => r.effect === 'contact_count').pop()?.value) || 5;
      keys = Object.values(loadState().jobs).filter((j) => ['reviewed', 'shortlisted', 'prepared', 'apply_ready'].includes(j.status)).sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1)).slice(0, n).map((j) => j.key);
    }
    return out(updateState((s) => {
      s.contactsRequested = [...new Set([...(s.contactsRequested || []), ...keys])];
      return { requested: s.contactsRequested.length };
    }));
  },

  async 'write-prompt'([key], flags) {
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
    const profile = readProfile();
    const r = parseWritingResult(fs.readFileSync(flags.result, 'utf8'), loadQuestions(flags.questions), profile);
    updateState((s) => {
      const job = s.jobs[key];
      job.drafts = { ...(job.drafts || {}), ...r.drafts };
      if (!r.ok) {
        job.status === 'shortlisted' && (job.status = 'stopped');
        s.held.push({ reason: 'stopped', detail: `${job.company}: writing failed` });
      }
    });
    return out(r, r.ok ? 0 : 4);
  },

  async report() {
    const s = loadState();
    const text = renderReport(s, loadOverlay(), { since: s.lastReportAt, profile: readProfile() });
    const dir = ensureDir(path.join(stateDir(), 'reports'));
    fs.appendFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.md`), `${text}\n\n`, { mode: 0o600 });
    updateState((st) => {
      st.lastReportAt = new Date().toISOString();
      st.updateLines = [];
      for (const c of st.consentLog || []) c.acked = true;
      st.dropLines = [];
      if ((st.found || []).length) st.watchTipShown = true;
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
  async posts([sub, ...urls]) {
    if (sub !== 'drop') return out({ error: 'posts drop <url...>' }, 2);
    return out(updateState((s) => {
      s.posts = (s.posts || []).filter((p) => !urls.includes(p.url));
      return { left: s.posts.length };
    }));
  },

  // Hacker News through the official API, in code, one request a second. Kept posts become post_review items.
  async hn(_, flags) {
    const budgetMs = flags.budget ? Number(flags.budget) * 1000 : DEFAULT_BUDGET_MS;
    return out(await runHn({ fetch: globalThis.fetch, profile: readProfile(), state: loadState(), budgetMs }));
  },
  // Fill-only: per job, or with a fill_only rule. Fill, read back, never submit, leave the tab open.
  async fillonly([key, onoff]) {
    return out(updateState((s) => {
      if (!s.jobs[key]) throw new Error(`unknown job: ${key}`);
      s.jobs[key].fillOnly = onoff !== 'off';
      return { fillOnly: s.jobs[key].fillOnly };
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
  async search([sub]) {
    if (sub !== 'next') return out({ error: 'search next' }, 2);
    const profile = readProfile();
    return out(updateState((s) => advanceSearch(s, profile)));
  },

  // The start: the resume path, then one question-tool call (apply mode, search frequency, positions, Remote Control).
  async start([sub], flags) {
    const profile = readProfile();
    const st = loadState();
    if (sub === 'status' || !sub) {
      const missing = [];
      if (!profile.resumeText) missing.push('resume');
      if (!profile.applyMode || !profile.frequency || !(st.start && st.start.positionsAt) || !(st.start && st.start.rcOfferedAt)) missing.push('start_questions');
      return out({ missing, next: missing[0] === 'resume' ? 'ask the resume path as a plain question' : missing.length ? 'J ask start, then J start record' : 'run the free search and the report', start: st.start || null });
    }
    if (sub !== 'record') return out({ error: 'start status | record --mode m --frequency f --positions n|none|skip --remote-control now|later [--words text]' }, 2);
    if (!['attended', 'auto_no_new', 'auto_write'].includes(flags.mode || 'attended')) return out({ error: 'mode must be attended, auto_no_new or auto_write' }, 2);
    if (flags.frequency && !FREQUENCIES.includes(flags.frequency)) return out({ error: 'frequency must be daily, twice_daily or weekly' }, 2);
    const mode = flags.mode || 'attended';
    const frequency = flags.frequency || 'daily';
    const positions = flags.positions === undefined || flags.positions === true || flags.positions === 'skip' ? 'skip' : String(flags.positions);
    // No answer to the count means no limit: nothing is recorded.
    if (positions !== 'skip') addRule({ effect: 'period_max', value: positions === 'none' ? 'none' : coerce(positions), words: String(flags.words || `positions per period: ${positions}`) });
    writeJsonAtomic(profileFile(), { ...profile, applyMode: mode, frequency, frequencySource: 'person' });
    const now = new Date().toISOString();
    updateState((s) => {
      s.start = { ...(s.start || {}), modeAt: now, frequencyAt: now, positionsAt: now, rcOfferedAt: now, remoteControl: flags['remote-control'] === 'now' ? 'now' : 'later' };
    });
    return out({ recorded: { mode, frequency, positions }, note: mode === 'attended' ? 'attended is the default; nothing more to record' : 'an auto mode also needs the unattended rules shown back, a clear yes, then consent record (and consent record writing for auto_write)' });
  },
  // The payload for Claude Code's question tool, so the questions are asked as choices, never as a list in prose.
  async ask([kind], flags) {
    const arg = flags.json ? readJsonArg(flags.json) : {};
    const make = { start: () => qs.startQuestions(), resume: () => qs.resumeChoiceQuestion(arg), tenjin: () => qs.tenjinAsk(arg), eeo: () => qs.eeoQuestion(), 'optional-writing': () => qs.optionalWritingQuestion(), fact: () => qs.factQuestion(arg), yes: () => qs.sheetYesQuestion(arg) }[kind];
    if (!make) return out({ error: 'ask start | resume --json {header,question,guess,next} | tenjin --json {line,status} | eeo | optional-writing | fact --json {label,options} | yes --json {company,title}' }, 2);
    if (batch.isActive() && batch.batchMode() === 'unattended') return out({ error: 'no questions in an unattended turn: nobody can answer; hold the job and notify' }, 4);
    const p = make();
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
    const next = { ...profile, facts: { ...(profile.facts || {}), [name]: rest.join(' ') } };
    const bad = validateProfile(next);
    if (bad.length) return out({ error: bad.join('; ') }, 2);
    writeJsonAtomic(profileFile(), next);
    return out({ saved: name, resumed: resumeHeld(next) });
  },
  // Watched boards the skill found itself, and the person's removals. A removed company is never added again.
  async watch([sub, name]) {
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
    return out(applyOps(ops));
  },
  async ack() {
    return out(updateState((s) => { for (const c of s.consentLog || []) c.acked = true; return { acked: true }; }));
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
  try {
    await commands[cmd](pos, flags);
  } catch (e) {
    out({ error: e.message }, 2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
export { commands };
