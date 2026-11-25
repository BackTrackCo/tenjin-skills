import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const ap = await import(`${S}apply.mjs`);
const approval = await import(`${S}approval.mjs`);
const sheetLib = await import(`${S}sheet.mjs`);
const batchLib = await import(`${S}batch.mjs`);
const J = (...a) => runJobs(home, a);
const empty = { rules: [], lessons: [] };
const EEO = 'Decline every voluntary demographic question (test placeholder).';
const U = { roles: ['engineer'], places: ['Berlin'], remote: false, minScore: 50, hosts: ['*'] };
const ep = (n) => ({ url: `https://jobs.site${n}.test/acme/jobs/${n}`, system: 'employer_site', token: null, jobId: null, source: 'careers_page', confidence: 'confirmed' });
const job = (n, over = {}) => mkJob({ key: `https://jobs.site${n}.test/acme/jobs/${n}`, status: 'apply_ready', company: `Co${n}`, title: 'Software Engineer', city: 'Berlin', fit: 90, verifiedAt: new Date().toISOString(), employerPosting: ep(n), sheet: { hash: `h${n}`, passed: true, eeoMissing: false, unanswered: [], forbidden: [], fields: [{ label: 'Email', value: 'a@b.test', tag: 'fact', required: true }] }, ...over });
const profileOf = (extra = {}) => ({ eeoText: EEO, applyMode: 'auto_write', unattended: U, ...extra });
const setProfile = (p) => J('profile', 'set', JSON.stringify(p));
const reset = (jobs = [], profile = { eeoText: EEO }, { approve = false } = {}) => {
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'rules.json'), { force: true });
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState()); for (const j of jobs) { s.jobs[j.key] = j; if (approve) s.approvals[j.key] = { sheetHash: j.sheet.hash }; } });
  setProfile(profile);
};
const hashOf = (k) => store.loadState().jobs[k].sheet.hash;

// ---- 1 ------------------------------------------------------------------------------------------------------------
test('1: an auto mode passes may-submit only through its own checks: consent, rules hash, dry run, writing consent, period limit, apply mode', () => {
  const a = job(1);
  reset([a], profileOf());
  assert.equal(J('rules', 'add', '--effect', 'period_max', '--value', '2', '--words', 'two a day').code, 0);
  assert.equal(J('consent', 'record', 'unattended', '--optional-writing', 'skip').code, 0);
  J('dryrun', 'record', a.key, '{}');
  assert.equal(J('batch', 'open', '--unattended').code, 0);
  // an unconfirmed dry run: handed out with no submit, and may-submit says no
  let r = J('apply', 'next', '--unattended');
  assert.equal(r.json.handout.submit, false);
  assert.equal(J('may-submit', a.key, hashOf(a.key)).json.why, 'not_handed_out_for_submit', 'a dry run is never a submit');
  J('batch', 'close');
  J('unpark', a.key);
  store.updateState((s) => { s.jobs[a.key].inFlight = null; s.jobs[a.key].mayAt = null; });
  assert.equal(J('dryrun', 'confirm').code, 0);
  J('batch', 'open', '--unattended');
  r = J('apply', 'next', '--unattended');
  assert.equal(r.json.handout.submit, true, r.stdout);
  const ok = J('may-submit', a.key, hashOf(a.key));
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(J('may-submit', a.key, hashOf(a.key)).json.why, 'already_checked', 'the one pass');
  // no yes is needed or used in an unattended batch, and an attended yes on file does not stand in for the checks
  store.updateState((s) => { s.jobs[a.key].mayAt = null; s.consent.unattended.rulesHash = 'old'; });
  assert.equal(J('may-submit', a.key, hashOf(a.key)).json.why, 'rules_changed');
  store.updateState((s) => { s.consent.unattended = null; });
  assert.equal(J('may-submit', a.key, hashOf(a.key)).json.why, 'no_consent');
});

test('1: apply next --unattended reads profile.applyMode: an attended mode hands out nothing', () => {
  const a = job(2);
  reset([a], profileOf());
  J('consent', 'record', 'unattended', '--optional-writing', 'skip');
  J('dryrun', 'record', a.key, '{}');
  J('dryrun', 'confirm');
  setProfile({ applyMode: 'attended' });
  store.updateState((s) => { s.consent.unattended.rulesHash = require_hash(); });
  J('batch', 'open', '--unattended');
  const r = J('apply', 'next', '--unattended');
  assert.equal(r.json.refused, 'not_auto_mode');
  assert.equal(r.json.handout, null);
  function require_hash() { return store.loadState().consent.unattended.rulesHash; }
});

test('1: under auto_no_new a job with a new written answer waits for the person', () => {
  const a = job(3, { sheet: { hash: 'h3', passed: true, eeoMissing: false, unanswered: [], forbidden: [], fields: [{ label: 'Why us?', value: 'text', tag: 'new_writing', required: false }] } });
  assert.equal(ap.jobFailure({ job: a, state: Object.assign(store.emptyState(), { consent: { unattended: { optionalWriting: 'skip' } }, jobs: {} }), profile: profileOf({ applyMode: 'auto_no_new' }), overlay: empty, mode: 'unattended', now: Date.now(), writingOk: true }), 'new_answer_needs_yes');
});

// ---- 2 ------------------------------------------------------------------------------------------------------------
test('2: "Submit it now" does not outlive a later fill-only switch or a later fill_only rule', () => {
  const a = job(4, { fillReady: { at: new Date().toISOString() } });
  reset([a], profileOf({ applyMode: 'fill_only' }));
  assert.equal(J('approve', a.key, '--submit-now').code, 0);
  store.updateState((s) => { s.jobs[a.key].inFlight = { at: new Date().toISOString(), mode: 'attended', submit: true, sheetHash: 'h4' }; });
  J('batch', 'open');
  assert.equal(J('may-submit', a.key, 'h4').code, 0, 'the yes for the unchanged sheet');
  store.updateState((s) => { s.jobs[a.key].mayAt = null; });
  J('batch', 'close');
  J('fillonly', a.key, 'on');
  J('batch', 'open');
  assert.equal(J('may-submit', a.key, 'h4').json.why, 'fill_only', 'the stop step holds');
  const other = job(5, { fillReady: { at: new Date().toISOString() } });
  reset([other], profileOf({ applyMode: 'fill_only' }));
  J('approve', other.key, '--submit-now');
  store.updateState((s) => { s.jobs[other.key].inFlight = { at: new Date().toISOString(), mode: 'attended', submit: true, sheetHash: 'h5' }; });
  J('rules', 'add', '--effect', 'fill_only', '--value', 'true', '--words', 'fill only from now on');
  J('batch', 'open');
  assert.equal(J('may-submit', other.key, 'h5').json.why, 'fill_only', 'a later rule stops it too');
});

// ---- 3 ------------------------------------------------------------------------------------------------------------
test('3: a job is never handed out twice, and may-submit says no after a submit', () => {
  const a = job(6);
  reset([a], { eeoText: EEO }, { approve: true });
  J('batch', 'open');
  assert.equal(J('apply', 'next').json.handouts.length, 1);
  assert.equal(J('apply', 'next').json.handouts.length, 0, 'the second call hands out nothing');
  assert.equal(J('may-submit', a.key, 'h6').code, 0);
  J('ops', JSON.stringify([{ op: 'transition', key: a.key, to: 'submitted' }]));
  store.updateState((s) => { s.jobs[a.key].mayAt = null; });
  assert.equal(J('may-submit', a.key, 'h6').json.why, 'already_applied');
});

test('3: may-submit needs the job to have been handed out', () => {
  const a = job(7);
  reset([a], { eeoText: EEO }, { approve: true });
  J('batch', 'open');
  assert.equal(J('may-submit', a.key, 'h7').json.why, 'not_handed_out');
});

// ---- 9 ------------------------------------------------------------------------------------------------------------
test('9: a passing sheet check does not clear a stop', () => {
  const a = job(8, { parked: { key: 'k', reasons: ['captcha'] }, questions: [{ label: 'Email', required: true, type: 'input_text' }] });
  reset([a], { eeoText: EEO, facts: { email: 'a@b.test' } });
  const r = J('sheet', 'check', a.key);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(store.loadState().jobs[a.key].parked.reasons, ['captcha']);
  store.updateState((s) => { s.jobs[a.key].parked = { key: 'k', reasons: ['needs_facts'] }; });
  J('sheet', 'check', a.key);
  assert.equal(store.loadState().jobs[a.key].parked, null, 'a hold the sheet itself caused is lifted');
});

// ---- 10 -----------------------------------------------------------------------------------------------------------
test('10: apply next does not revive a stale batch', () => {
  const a = job(9);
  reset([a], { eeoText: EEO }, { approve: true });
  J('batch', 'open');
  store.updateState((s) => { s.batch.touchedAt = new Date(Date.now() - 5 * 3600000).toISOString(); });
  const r = J('apply', 'next');
  assert.equal(r.json.refused, 'no_batch');
  assert.equal(store.loadState().batch, null);
  assert.equal(J('may-submit', a.key, 'h9').json.why, 'batch_closed');
});

// ---- 11 -----------------------------------------------------------------------------------------------------------
test('11: a Chrome stop says no for every open check, in an attended batch too', () => {
  const a = job(10); const b = job(11);
  reset([a, b], { eeoText: EEO }, { approve: true });
  J('batch', 'open');
  J('apply', 'next', '--all');
  assert.equal(J('stop', a.key, '--kind', 'chrome_disconnected').json.batchClosed, true);
  assert.equal(J('may-submit', b.key, 'h11').json.why, 'batch_closed');
  reset([a, b], { eeoText: EEO }, { approve: true });
  J('batch', 'open');
  J('apply', 'next', '--all');
  J('stop', a.key, '--kind', 'no_chrome_tools');
  store.updateState((s) => { s.batch = { mode: 'attended', denied: [], openedAt: new Date().toISOString(), touchedAt: new Date().toISOString() }; });
  assert.equal(J('may-submit', a.key, 'h10').json.why, 'stopped');
});

// ---- 12 -----------------------------------------------------------------------------------------------------------
test('12: a changed form needs a new yes: the hash covers what is unanswered, and a failing sheet is no', () => {
  const base = { job: { key: 'k' }, questions: [{ label: 'Email', required: true, type: 'input_text' }], profile: { facts: { email: 'a@b.test' }, eeoText: EEO }, answers: [], drafts: {} };
  const one = sheetLib.buildSheet(base);
  const two = sheetLib.buildSheet({ ...base, questions: [...base.questions, { label: 'Date of birth', required: true, type: 'input_text' }, { label: 'Why us?', required: true, type: 'textarea' }] });
  assert.notEqual(one.hash, two.hash, 'a new required question changes the hash');
  const a = job(12, { sheet: { ...two, passed: false } });
  reset([a], { eeoText: EEO }, { approve: true });
  store.updateState((s) => { s.approvals[a.key] = { sheetHash: two.hash }; s.jobs[a.key].inFlight = { at: new Date().toISOString(), mode: 'attended', submit: true, sheetHash: two.hash }; });
  J('batch', 'open');
  assert.equal(J('may-submit', a.key, two.hash).json.why, 'sheet_not_passed');
});

// ---- 13 -----------------------------------------------------------------------------------------------------------
test('13: a read-back mismatch blocks the submit, and a field the sheet does not hold is caught', () => {
  const a = job(13);
  reset([a], { eeoText: EEO }, { approve: true });
  J('batch', 'open');
  J('apply', 'next');
  const bad = path.join(home, 'rb.json');
  fs.writeFileSync(bad, JSON.stringify([{ label: 'Email', value: 'mallory@x.test' }]));
  assert.equal(J('sheet', 'readback', a.key, '--read', bad).code, 4);
  assert.equal(J('may-submit', a.key, 'h13').json.why, 'readback_failed');
  fs.writeFileSync(bad, JSON.stringify([{ label: 'Email', value: 'a@b.test' }]));
  assert.equal(J('sheet', 'readback', a.key, '--read', bad).code, 0);
  assert.equal(J('may-submit', a.key, 'h13').code, 0);
  const extra = sheetLib.checkReadBack({ fields: [{ label: 'Email', value: 'a@b.test', tag: 'fact' }] }, [{ label: 'Email', value: 'a@b.test' }, { label: 'Phone', value: '1' }]);
  assert.equal(extra.ok, false);
  assert.match(extra.problems[0], /a field the sheet does not hold has a value: Phone/);
});

// ---- 14 -----------------------------------------------------------------------------------------------------------
test('14: approve --all covers only the sheets that were shown, and approve <key> refuses a sheet that changed after it was shown', () => {
  const a = job(14, { status: 'apply_ready' }); const b = job(15);
  reset([a, b], { eeoText: EEO });
  assert.equal(J('ask', 'approve').code, 0);
  const c = job(16);
  store.updateState((s) => { s.jobs[c.key] = c; });
  const r = J('approve', '--all');
  assert.equal(r.json.approved, 2, 'the third, prepared after the question, is not approved');
  assert.deepEqual(Object.keys(store.loadState().approvals).sort(), [a.key, b.key].sort());
  const d = job(17);
  store.updateState((s) => { s.jobs[d.key] = d; });
  assert.equal(J('ask', 'approval', '--key', d.key).code, 0);
  store.updateState((s) => { s.jobs[d.key].sheet.hash = 'changed17'; });
  assert.equal(J('approve', d.key).code, 4);
  assert.equal(store.loadState().approvals[d.key], undefined);
});

// ---- 15 -----------------------------------------------------------------------------------------------------------
test('15: an unattended batch refuses every command that records a yes or loosens a stop', () => {
  const a = job(18);
  reset([a], profileOf());
  J('batch', 'open', '--unattended');
  for (const c of [['approve', a.key], ['approve', '--all'], ['approve', a.key, '--facts', '{"x":"y"}'], ['ask', 'approval', '--key', a.key], ['fillonly', a.key, 'off'], ['unpark', a.key], ['chrome', 'set', 'on'], ['sheet', 'build', a.key, '--questions', 'x'], ['eeo', 'set', 'x'], ['eeo', 'skip'], ['agree', a.key, 'label'], ['resume', 'set', '--text'], ['ops', JSON.stringify([{ op: 'approve', key: a.key, sheetHash: 'h18' }])]]) assert.equal(J(...c).code, 4, c.join(' '));
  assert.equal(store.loadState().approvals[a.key], undefined);
  assert.equal(J('sheet', 'check', a.key).code, 0, 'the checks the round needs still run');
  J('batch', 'close');
  const b = job(19, { sheet: { hash: 'h19', passed: false, eeoMissing: false, unanswered: [], forbidden: [], fields: [] } });
  store.updateState((s) => { s.jobs[b.key] = b; });
  assert.equal(J('ops', JSON.stringify([{ op: 'approve', key: b.key, sheetHash: 'h19' }])).code, 2, 'a yes on a sheet that did not pass is refused');
});

// ---- 16 -----------------------------------------------------------------------------------------------------------
test('16: a larger catch-up number needs a new consent', () => {
  const overlayWith = (v) => ({ rules: [{ effect: 'period_max', value: v }] });
  const was = ap.limitsOf(overlayWith({ catchUp: 5, perDay: 2, at: new Date().toISOString() }));
  assert.equal(ap.loosened(was, ap.limitsOf(overlayWith({ catchUp: 50, perDay: 2, at: new Date().toISOString() }))), true);
  assert.equal(ap.loosened(was, ap.limitsOf(overlayWith({ catchUp: 3, perDay: 2, at: new Date().toISOString() }))), false, 'tightening needs none');
  assert.equal(ap.loosened(ap.limitsOf(overlayWith(2)), ap.limitsOf(overlayWith({ catchUp: 50, perDay: 2, at: new Date().toISOString() }))), true);
});

// ---- 17 -----------------------------------------------------------------------------------------------------------
test('17: only the resume the person named is uploaded: batch open refuses another path and the handout carries the named one', () => {
  const resume = path.join(home, 'resume.pdf');
  fs.writeFileSync(resume, 'x');
  const a = job(20, { sheet: { hash: 'h20', passed: true, eeoMissing: false, unanswered: [], forbidden: [], fields: [{ label: 'Resume/CV', value: '<resume>', tag: 'upload', required: true }] } });
  reset([a], { eeoText: EEO, resumePath: resume }, { approve: true });
  assert.equal(J('batch', 'open', '--upload', '/etc/passwd').code, 4);
  assert.equal(store.loadState().batch, null);
  assert.equal(J('batch', 'open', '--upload', resume).code, 0);
  assert.equal(J('apply', 'next').json.handout.resume, resume);
});

// ---- 18 -----------------------------------------------------------------------------------------------------------
test('18: apply next keeps the stop reasons of a parked job', () => {
  const a = job(21, { parked: { key: `${'x'}@1`, reasons: ['captcha'] }, hash: '1' });
  reset([a], { eeoText: EEO }, { approve: true });
  J('batch', 'open');
  const r = J('apply', 'next');
  assert.deepEqual(r.json.queue, [{ key: a.key, reason: 'parked' }]);
  assert.deepEqual(store.loadState().jobs[a.key].parked.reasons, ['captcha']);
});

// ---- 47, 48, 49 ---------------------------------------------------------------------------------------------------
test('47: approve --submit-now on an unfilled job records nothing', () => {
  const a = job(22);
  reset([a], { eeoText: EEO });
  assert.equal(J('approve', a.key, '--submit-now').code, 4);
  assert.equal(store.loadState().approvals[a.key], undefined);
});

test('48: a dry-run record needs a real job', () => {
  reset([job(23)], profileOf());
  assert.equal(J('dryrun', 'record', 'no-such-job', '{}').code, 2);
});

test('49: an attended yes does not outlive a later exclude_company rule', () => {
  const a = job(24, { company: 'Initech' });
  reset([a], { eeoText: EEO }, { approve: true });
  assert.equal(ap.jobFailure({ job: a, state: store.loadState(), profile: { eeoText: EEO }, overlay: { rules: [{ effect: 'exclude_company', value: 'initech' }] }, mode: 'attended', now: Date.now() }), 'company_excluded');
  J('rules', 'add', '--effect', 'exclude_company', '--value', 'initech', '--words', 'not them');
  J('batch', 'open');
  store.updateState((s) => { s.jobs[a.key].inFlight = { at: new Date().toISOString(), mode: 'attended', submit: true, sheetHash: 'h24' }; });
  assert.equal(J('may-submit', a.key, 'h24').json.why, 'company_excluded');
});

// ---- 4 ------------------------------------------------------------------------------------------------------------
test('4: J open on Windows never starts a shell (fixed in 85d46ca)', async () => {
  const open = await import(`${S}open.mjs`);
  assert.equal(open.defaultCommand('https://x.example/?a=1&calc', 'win32').bin, 'rundll32.exe');
  assert.equal(open.chromeCommand('https://x.example/?a=1&calc', 'win32', { env: {}, exists: () => false }), null);
});

// ---- 15 follow-up: a whole unattended round never needs a refused command ---------------------------------------------
test('15: a whole unattended round runs in order and no step is refused', () => {
  const resume = path.join(home, 'resume-round.pdf');
  fs.writeFileSync(resume, 'x');
  const j = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/777', url: 'https://boards.greenhouse.io/acme/jobs/777', status: 'prepared', fit: 90, title: 'Software Engineer', city: 'Berlin', verifiedAt: new Date().toISOString() });
  reset([j], { eeoText: EEO, applyMode: 'auto_write', resumePath: resume, facts: { first_name: 'Ada' }, unattended: U });
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'answers.json'), { force: true });
  const step = (label, args, want = 0) => { const r = J(...args); assert.equal(r.code, want, `${label}: ${r.stdout}`); return r; };
  const q = path.join(home, 'round-q.json');
  fs.writeFileSync(q, JSON.stringify([{ label: 'First Name', required: true, type: 'input_text' }, { label: 'Resume/CV', required: true, type: 'input_file' }]));
  // before the batch: the person's consent and dry run, and the prepare steps (build and check the sheet)
  step('rule', ['rules', 'add', '--effect', 'period_max', '--value', '5', '--words', 'five']);
  step('consent', ['consent', 'record', 'unattended', '--optional-writing', 'skip']);
  step('dryrun record', ['dryrun', 'record', j.key, '{}']);
  step('dryrun confirm', ['dryrun', 'confirm']);
  step('sheet build', ['sheet', 'build', j.key, '--questions', q]);
  step('sheet check', ['sheet', 'check', j.key]);
  // the batch: only what the handed-out subagent needs
  step('batch open', ['batch', 'open', '--unattended', '--upload', resume]);
  const next = step('apply next', ['apply', 'next', '--unattended']);
  assert.equal(next.json.handout.submit, true);
  assert.equal(next.json.handout.resume, resume);
  const hash = next.json.handout.sheetHash;
  const live = path.join(home, 'round-live.json');
  fs.writeFileSync(live, JSON.stringify([{ label: 'First Name', required: true }, { label: 'Resume/CV', required: true }]));
  step('sheet check --live', ['sheet', 'check', j.key, '--live', live]);
  const rb = path.join(home, 'round-rb.json');
  fs.writeFileSync(rb, JSON.stringify([{ label: 'First Name', value: 'Ada' }]));
  step('readback', ['sheet', 'readback', j.key, '--read', rb]);
  step('may-submit', ['may-submit', j.key, hash]);
  step('submitted', ['ops', JSON.stringify([{ op: 'transition', key: j.key, to: 'submitted' }])]);
  step('batch close', ['batch', 'close']);
  assert.equal(store.loadState().jobs[j.key].status, 'submitted');
});
