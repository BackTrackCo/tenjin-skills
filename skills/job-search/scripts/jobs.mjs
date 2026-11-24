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
import * as guard from './lib/guard.mjs';
import { checkTenjin, deepseekStep, defaultRun, findTenjin, readSubagents } from './lib/tenjin.mjs';
import { buildSheet, checkReadBack, checkSheet, parseGreenhouseQuestions } from './lib/sheet.mjs';
import { buildContactMessageRequest, buildWritingRequest, parseWritingResult, readWritingRules } from './lib/writing.mjs';
import { renderReport } from './lib/report.mjs';
import { appendPending, isCareerOpsDir, pipelineLine, readCareerOps } from './lib/careerops.mjs';
import { observations } from './lib/signals.mjs';
import { ingest } from './lib/ingest.mjs';
import { validateProfile } from './lib/profile.mjs';
import { DEFAULT_BUDGET_MS, runHn } from './lib/hn.mjs';
import { isFillOnly, markFillReady, markSubmitted } from './lib/fillonly.mjs';

// A command that changes what a submit may do is refused while a batch is open, whoever calls it.
const batchOpen = () => guard.isActive();
const refuseInBatch = (what) => {
  if (!batchOpen()) return false;
  out({ error: `${what} is refused while a batch is open; close it in an attended session first` }, 4);
  return true;
};

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
  async tenjin() {
    const r = checkTenjin();
    updateState((s) => {
      s.held = s.held.filter((h) => h.reason !== 'tenjin_missing');
      if (r.status !== 'present') s.held.push({ reason: 'tenjin_missing', detail: r.status });
    });
    return out(r);
  },

  async setup([sub, ...rest], flags) {
    if ((sub === 'resume' || sub === 'deepseek' || sub === 'careerops') && refuseInBatch(`setup ${sub}`)) return;
    if (sub === 'check') {
      const t = checkTenjin();
      const bin = t.bin || findTenjin();
      return out({ tenjin: t, deepseek: bin ? readSubagents({ bin }) : { ok: true, enabled: false }, guardInstalled: guard.guardInstalled(), profile: fs.existsSync(profileFile()), setup: loadState().setup });
    }
    if (sub === 'deepseek') {
      const bin = findTenjin();
      const r = deepseekStep({ bin, yes: flags.yes === true, keep: flags.keep === true });
      updateState((s) => {
        s.setup.deepseek = r.state;
        s.held = s.held.filter((h) => h.reason !== 'deepseek_on');
        if (r.state === 'on_kept') s.held.push({ reason: 'deepseek_on', detail: 'kept on' });
      });
      return out(r);
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
    return out({ error: 'setup check | deepseek [--yes|--keep] | resume <path> | stage <stage> <next>' }, 2);
  },

  async profile([sub, arg]) {
    if (sub === 'set' && refuseInBatch('profile set')) return;
    if (sub === 'get') return out(readProfile());
    if (sub === 'set') {
      ensureDir(stateDir());
      const next = { ...readProfile(), ...readJsonArg(arg) };
      const bad = validateProfile(next);
      if (bad.length) return out({ error: `the profile was not saved: ${bad.join('; ')}` }, 2);
      writeJsonAtomic(profileFile(), next);
      return out({ saved: Object.keys(next) });
    }
    return out({ error: 'profile get | set <json>' }, 2);
  },

  async guard([sub, ...rest]) {
    if (sub === 'install') return out(guard.installGuard());
    if (sub === 'uninstall') return refuseInBatch('guard uninstall') || out(guard.uninstallGuard());
    if (sub === 'selftest') return out(guard.selftest());
    if (sub === 'probe') return out({ probe: rest[0] });
    if (sub === 'hook') {
      const res = guard.hookMain(fs.readFileSync(0, 'utf8'));
      if (res) process.stdout.write(JSON.stringify(res));
      return;
    }
    return out({ error: 'guard install | uninstall | selftest | probe <nonce> | hook' }, 2);
  },

  async batch([sub], flags) {
    if (sub === 'open' && refuseInBatch('batch open')) return;
    if (sub === 'open') {
      const profile = readProfile();
      const p = guard.openBatch({ mode: flags.unattended ? 'unattended' : 'attended', uploadPath: flags.upload || profile.resumePath });
      return out({ nonce: p.nonce, mode: p.mode, next: `run: node ${path.join(SKILL_DIR, 'scripts', 'jobs.mjs')} guard probe ${p.nonce}` });
    }
    if (sub === 'close') {
      guard.closeBatch();
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
    if ((sub === 'add' || sub === 'remove') && refuseInBatch('rules change')) return;
    if (sub === 'add') return out(addRule({ effect: flags.effect, value: flags.value === undefined ? null : coerce(flags.value), words: flags.words }));
    if (sub === 'remove') return out({ removed: removeRule(rest[0]) });
    return out(loadOverlay().rules);
  },
  async lessons([sub, ...rest], flags) {
    if ((sub === 'add' || sub === 'remove') && refuseInBatch('lessons change')) return;
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
    const wl = workList({ commit: flags.commit === true });
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
        } else park(job, [job.sheet.eeoMissing ? 'eeo_missing' : job.sheet.unanswered.length ? 'unknown_field' : job.sheet.forbidden.length ? 'forbidden_field' : 'form_changed']);
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
    const bin = findTenjin();
    const ds = bin ? readSubagents({ bin }) : { ok: true, enabled: false };
    const state = loadState();
    guard.touchBatch();
    const res = applyNext({ state, profile: readProfile(), overlay: loadOverlay(), mode, guard: guard.selftest(), deepseek: { enabled: ds.ok ? ds.enabled : null }, writingRulesText: readWritingRules() });
    updateState((s) => {
      s.held = s.held.filter((h) => !['deepseek_on', 'guard_missing'].includes(h.reason));
      if (res.refused === 'deepseek_on' || res.refused === 'guard_missing') s.held.push({ reason: res.refused, detail: mode });
      for (const q of res.queue) if (s.jobs[q.key] && !['sheet_not_checked', 'no_recorded_yes'].includes(q.reason)) park(s.jobs[q.key], [q.reason]);
    });
    // An unattended round ends in code: nothing left to submit (empty, held, parked or refused) closes the batch.
    let batchClosed = false;
    if (mode === 'unattended' && !res.handout && guard.batchMode() === 'unattended') {
      guard.closeBatch();
      batchClosed = true;
    }
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
        return { revoked: which };
      }));
    }
    if (sub !== 'record' || !['unattended', 'writing'].includes(which)) return out({ error: 'consent record unattended --optional-writing skip|wait | record writing | revoke unattended|writing' }, 2);
    if (guard.isActive()) return out({ error: 'consent is recorded in an attended session; close the batch first' }, 4);
    return out(updateState((s) => {
      if (which === 'unattended') return recordConsent(s, readProfile(), loadOverlay(), Date.now(), flags['optional-writing']);
      const c = recordWritingConsent(s, readWritingRules());
      // jobs that only waited for this consent go back to the queue
      for (const j of Object.values(s.jobs)) if (j.parked && j.parked.reasons.length === 1 && j.parked.reasons[0] === 'writing_needs_yes') unpark(j);
      return c;
    }));
  },
  // The person read the draft: approve it as it is or edited. Each new-writing field becomes an earlier answer.
  async writing([sub, key], flags) {
    if (sub === 'approve' && refuseInBatch('writing approve')) return;
    if (sub !== 'approve') return out({ error: 'writing approve <key> [--edits file.json]' }, 2);
    const profile = readProfile();
    const job = loadState().jobs[key];
    if (!job || !job.sheet) throw new Error('build the sheet first');
    const approved = approveWriting(job, profile, flags.edits ? readJsonArg(flags.edits) : {});
    return out(updateState((s) => {
      const j = s.jobs[key];
      const sheet = buildSheet({ job: j, questions: j.questions, profile, answers: loadAnswers().entries, drafts: j.drafts || {} });
      j.sheet = { ...sheet, passed: checkSheet(sheet).ok };
      if (j.parked && j.parked.reasons.includes('writing_needs_yes')) unpark(j);
      return { approved: approved.length, tags: sheet.fields.filter((f) => f.tag === 'new_writing').length, passed: j.sheet.passed };
    }));
  },
  async answer([sub], flags) {
    if (sub === 'add' && refuseInBatch('answer add')) return;
    if (sub !== 'add') return out({ error: 'answer add --label L --value V [--key jobkey]' }, 2);
    const job = flags.key ? loadState().jobs[flags.key] : null;
    const q = ((job && job.questions) || []).find((x) => x.label === flags.label) || {};
    return out(addAnswer({ question: flags.label, answer: flags.value, how: 'typed', source: flags.key || null, type: q.type || 'input_text', options: q.options && q.options.length ? q.options : null }));
  },
  async dryrun([sub, key, json]) {
    if (sub === 'confirm' && refuseInBatch('dryrun confirm')) return;
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
      else {
        if (kind === 'injection_suspected') job.warnings = [...new Set([...(job.warnings || []), 'injection_suspected'])];
        park(job, [kind]);
      }
      // a stop that ends the round also closes an unattended batch, in code
      if (['captcha', 'chrome_disconnected'].includes(kind) && guard.batchMode() === 'unattended') {
        guard.closeBatch();
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
    return out(updateState((s) => unpark(s.jobs[key])) || { ok: true });
  },
  // On the person's yes at setup, each job that passed review is appended under "## Pending" in the career-ops pipeline.
  async pipeline([sub, ...keys]) {
    if (sub !== 'add') return out({ error: 'pipeline add [key...]' }, 2);
    if (refuseInBatch('pipeline add')) return;
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
    const text = renderReport(s, loadOverlay(), { since: s.lastReportAt });
    const dir = ensureDir(path.join(stateDir(), 'reports'));
    fs.appendFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.md`), `${text}\n\n`, { mode: 0o600 });
    updateState((st) => {
      st.lastReportAt = new Date().toISOString();
      st.updateLines = [];
    });
    process.stdout.write(text + '\n');
    // The reply ends with one line on what Tenjin adds. It is not part of the report file. No price.
    if (!findTenjin()) process.stdout.write('\nTenjin is not installed. With it I can also search X live, add more job-board listings and find people to write to. Ask me to set it up.\n');
  },

  async release([sub], flags) {
    if (sub === 'apply' && refuseInBatch('release apply')) return;
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
  try {
    await commands[cmd](pos, flags);
  } catch (e) {
    out({ error: e.message }, 2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
export { commands };
