import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const sheet = await import(`${S}sheet.mjs`);
const ap = await import(`${S}apply.mjs`);
const approval = await import(`${S}approval.mjs`);
const report = await import(`${S}report.mjs`);
const qs = await import(`${S}questions.mjs`);
const J = (...a) => runJobs(home, a);
const empty = { rules: [], lessons: [] };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
const file = (v) => { const f = path.join(tmp(), 'x.json'); fs.writeFileSync(f, JSON.stringify(v)); return f; };
const PROFILE = { eeo: 'decline_all', facts: { email: 'ada@example.test', first_name: 'Ada', last_name: 'L', phone: '+49 1', github: 'https://github.com/ada', current_company: 'Initech' } };
const reset = (profile = {}) => {
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'rules.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState()); });
  J('profile', 'set', JSON.stringify({ ...PROFILE, ...profile }));
};
const withSheet = (questions, mode = null) => {
  const job = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/9', status: 'prepared', company: 'Acme', questions });
  store.updateState((s) => { s.jobs[job.key] = job; });
  return job;
};
const build = (job, qfile) => J('sheet', 'build', job.key, '--questions', qfile);
const Q = (label, extra = {}) => ({ label, required: true, type: 'input_text', options: [], maxLength: null, ...extra });

test('a required field with no answer is asked first and the job waits as needs_facts with no fill; unattended nobody is asked', () => {
  reset();
  const job = withSheet([Q('Email'), Q('First name')]);
  build(job, file([Q('Email'), Q('First name')]));
  const live = [Q('Email'), Q('First name'), Q('Earliest start date'), Q('Work authorization', { type: 'multi_value_single_select', options: ['Yes', 'No'] })];
  const r = J('sheet', 'check', job.key, '--live', file(live));
  assert.equal(r.code, 4, r.stdout);
  assert.equal(r.json.held, 'needs_facts');
  assert.equal(store.loadState().jobs[job.key].parked.reasons[0], 'needs_facts');
  assert.deepEqual(r.json.ask.plain.map((p) => p.label), ['Earliest start date'], 'a typed answer is a plain question');
  assert.deepEqual(r.json.ask.questions[0].options.map((o) => o.label), ['Yes', 'No', 'Skip this job'], 'a fixed answer uses the form\'s own options');
  assert.match(r.json.next, /nothing is filled before the sheet is complete/);
  // unattended: nobody is asked
  const u = J('sheet', 'check', job.key, '--live', file(live), '--unattended');
  assert.equal(u.json.ask, undefined);
  assert.match(u.json.next, /nobody is asked/);
  // the answer is saved, the sheet rebuilt from the live form and the check passes
  J('answer', 'add', '--label', 'Earliest start date', '--value', 'Next month');
  J('fact', 'set', 'authorized_to_work', 'Yes');
  assert.equal(build(job, file(live)).code, 0);
  const ok = J('sheet', 'check', job.key, '--live', file(live));
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(store.loadState().jobs[job.key].parked, null);
});

test('a legal acknowledgment is asked before the fill and the fill ticks it; an attestation is covered by the approval, but asked in fill-only', () => {
  reset();
  const live = [Q('Email'), Q('I agree to the arbitration agreement', { type: 'checkbox' }), Q('I confirm the information is accurate and complete', { type: 'checkbox' })];
  const job = withSheet(live);
  build(job, file(live));
  const r = J('sheet', 'check', job.key, '--live', file(live));
  assert.equal(r.code, 4);
  const ack = r.json.ask.questions.find((q) => q.ack);
  assert.equal(ack.ack, 'I agree to the arbitration agreement');
  assert.deepEqual(ack.options.map((o) => o.label), ['Yes, I accept', 'Skip this job']);
  assert.equal(r.json.ask.questions.some((q) => /accurate/.test(q.question)), false, 'in a submit mode the attestation is covered by the approval');
  assert.equal(J('agree', job.key, 'I agree to the arbitration agreement').code, 0);
  build(job, file(live));
  const ok = J('sheet', 'check', job.key, '--live', file(live));
  assert.equal(ok.code, 0, ok.stdout);
  const fields = store.loadState().jobs[job.key].sheet.fields;
  assert.deepEqual(fields.filter((f) => f.tag === 'ack').map((f) => f.value), ['checked', 'checked'], 'the fill ticks both');
  // fill-only: the attestation is asked with the acknowledgments
  reset({ applyMode: 'fill_only' });
  const job2 = withSheet(live);
  build(job2, file(live));
  J('agree', job2.key, 'I agree to the arbitration agreement');
  build(job2, file(live));
  const r2 = J('sheet', 'check', job2.key, '--live', file(live));
  assert.equal(r2.code, 4, 'the fill-only attestation still needs a yes');
  assert.ok(r2.json.ask.questions.some((q) => q.ack === 'I confirm the information is accurate and complete'));
  J('agree', job2.key, 'I confirm the information is accurate and complete');
  build(job2, file(live));
  assert.equal(J('sheet', 'check', job2.key, '--live', file(live)).code, 0);
});

test('optional fields the profile or resume answers are filled', () => {
  reset();
  const qsList = [Q('Email'), Q('GitHub', { required: false }), Q('Current company', { required: false }), Q('Cover letter', { required: false })];
  const s = sheet.buildSheet({ job: mkJob({}), questions: qsList, profile: { facts: PROFILE.facts, eeo: 'decline_all' } });
  assert.deepEqual(s.fields.map((f) => f.label), ['Email', 'GitHub', 'Current company'], 'answered optional fields are filled; one with no answer is left');
  assert.equal(s.unanswered.length, 0);
});

test('the read-back refills a field once, then holds the job as fill_problem and shows the field and its value', () => {
  reset();
  const live = [Q('Email')];
  const job = withSheet(live);
  build(job, file(live));
  J('sheet', 'check', job.key, '--live', file(live));
  const bad = file([{ label: 'Email', value: 'wrong@x.test' }]);
  const first = J('sheet', 'readback', job.key, '--read', bad);
  assert.equal(first.code, 4);
  assert.deepEqual(first.json.refill, [{ label: 'Email', value: 'wrong@x.test' }]);
  assert.equal(store.loadState().jobs[job.key].parked, null, 'refilled once, not held yet');
  const second = J('sheet', 'readback', job.key, '--read', bad);
  assert.equal(second.json.held, 'fill_problem');
  assert.deepEqual(second.json.show, [{ label: 'Email', value: 'wrong@x.test' }]);
  assert.equal(store.loadState().jobs[job.key].parked.reasons[0], 'fill_problem');
  const waiting = (async () => (await import(`${S}work.mjs`)).notifyLine(store.loadState(), empty, Date.now()).line)();
  return waiting.then((line) => assert.match(line, /fill problem/));
});

test('a filled job offers Submit it now, I\'ll submit in Chrome and Not this one; Submit it now is checked by may-submit on the unchanged sheet', () => {
  reset({ applyMode: 'fill_only' });
  const job = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/50', status: 'apply_ready', company: 'Acme', verifiedAt: new Date().toISOString(), fillReady: { at: new Date().toISOString() }, sheet: { hash: 'h50', passed: true, eeoMissing: false, fields: [{ label: 'Email', value: 'a@b.test', tag: 'fact', required: true }] } });
  store.updateState((s) => { s.jobs[job.key] = job; });
  const q = J('ask', 'approval', '--key', job.key).json;
  assert.deepEqual(q.questions[0].options.map((o) => o.label), ['Submit it now (Recommended)', 'I\'ll submit in Chrome', 'Not this one']);
  assert.deepEqual(qs.validateAsk({ questions: q.questions }), []);
  const profile = { eeo: 'decline_all', applyMode: 'fill_only' };
  const may = () => approval.maySubmit(store.loadState(), profile, empty, job.key, 'h50', true);
  assert.equal(may().why, 'fill_only', 'the fill-only mode never reaches a submit without that answer');
  const base = { overlay: empty, mode: 'attended', now: Date.now(), batchOpen: true, profile };
  assert.equal(ap.applyNext({ ...base, state: store.loadState() }).handouts.length, 0, 'a filled job is not handed out again');
  const r = J('approve', job.key, '--submit-now');
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.json.state, /^Submitted: none yet\. Submitting after one last check: Acme\./);
  assert.equal(may().ok, true, 'the unchanged sheet hash passes the last check');
  const h = ap.applyNext({ ...base, state: store.loadState() }).handouts[0];
  assert.deepEqual([h.key, h.submit, h.fillOnly, h.fromFilled], [job.key, true, false, true], 'handed out to submit, filling again first if the tab is gone');
  store.updateState((s) => { s.jobs[job.key].sheet.hash = 'changed'; });
  assert.equal(may().ok, false, 'a changed sheet needs a new answer');
  assert.equal(J('approve', 'nonexistent', '--submit-now').code, 4);
});

test('no report text says left for you or check when you review', () => {
  const job = mkJob({ status: 'apply_ready', fillReady: { at: new Date().toISOString() } });
  store.updateState((s) => { Object.assign(s, store.emptyState()); s.jobs[job.key] = job; });
  for (const short of [false, true]) {
    const text = report.renderReport(store.loadState(), empty, { now: Date.now(), profile: {}, short });
    assert.doesNotMatch(text, /left for you|check when you review|Check it/i);
    assert.match(text, /Submit it now/);
  }
  const root = path.join(import.meta.dirname, '..', '..', 'skills', 'job-search');
  for (const f of ['scripts/lib/report.mjs', 'scripts/lib/work.mjs', 'SKILL.md', 'references/apply.md']) assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), /left for you|check when you review/i, f);
  const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  assert.ok(skill.length <= 10000, `${skill.length}`);
  assert.match(skill, /a complete sheet before any fill/);
});
