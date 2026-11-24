import test from 'node:test';
import assert from 'node:assert/strict';
import { mkJob, tmpHome } from './helpers/env.mjs';

tmpHome();
const ap = await import('../../skills/job-search/scripts/lib/apply.mjs');
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const ov = await import('../../skills/job-search/scripts/lib/overlay.mjs');
const NOW = Date.parse('2026-11-23T12:00:00Z');
const GUARD = { ok: true };
const DS_OFF = { enabled: false };
const empty = () => ({ rules: [], lessons: [] });
const U = { roles: ['engineer'], places: ['Berlin'], remote: false, minPay: 100000, excludeCompanies: ['Evilcorp'], excludeLevels: ['intern', 'junior'], minScore: 70, hosts: ['greenhouse', 'lever'] };
const profile = () => ({ eeo: 'decline_all', unattended: { ...U } });
const ready = (over = {}) => mkJob({ status: 'apply_ready', fit: 80, sheet: { hash: 'sh1', passed: true, eeoMissing: false, fields: [] }, verifiedAt: new Date(NOW - 3600000).toISOString(), ...over });
const stateWith = (...jobs) => { const s = store.emptyState(); for (const j of jobs) s.jobs[j.key] = j; return s; };
const run = (state, o = {}) => ap.applyNext({ state, profile: profile(), overlay: empty(), mode: 'attended', now: NOW, guard: GUARD, deepseek: DS_OFF, ...o });

test('attended: no recorded yes means no hand-out', () => {
  const j = ready();
  const r = run(stateWith(j));
  assert.equal(r.handout, null);
  assert.deepEqual(r.queue, [{ key: j.key, reason: 'no_recorded_yes' }]);
});

test('attended: a yes names this job and this sheet; a changed sheet needs a new yes', () => {
  const j = ready();
  const s = stateWith(j);
  s.approvals[j.key] = { sheetHash: 'sh1' };
  const r = run(s);
  assert.equal(r.handout.key, j.key);
  assert.equal(r.handout.submit, true);
  j.sheet.hash = 'sh2';
  assert.equal(run(s).queue[0].reason, 'sheet_changed_needs_new_yes');
});

test('both modes: each common check holds the job', () => {
  const cases = [
    ['host_not_allowed', { ats: 'workday' }],
    ['not_verified_recently', { verifiedAt: new Date(NOW - 25 * 3600000).toISOString() }],
    ['sheet_not_checked', { sheet: { hash: 'sh1', passed: false } }],
    ['sheet_not_checked', { sheet: null }],
    ['eeo_missing', { sheet: { hash: 'sh1', passed: true, eeoMissing: true } }],
    ['parked', { parked: { key: 'k', reasons: ['captcha'] } }],
  ];
  for (const [reason, over] of cases) {
    const j = ready(over);
    const s = stateWith(j);
    s.approvals[j.key] = { sheetHash: 'sh1' };
    assert.equal(run(s).queue[0].reason, reason, reason);
  }
  const j = ready();
  const s = stateWith(j);
  s.approvals[j.key] = { sheetHash: 'sh1' };
  assert.equal(ap.jobFailure({ job: j, state: s, profile: { ...profile(), eeo: null }, overlay: empty(), mode: 'attended', now: NOW }), 'eeo_missing');
});

test('both modes: no second application to the same company and title within 90 days', () => {
  const prior = ready({ status: 'submitted' });
  const j = ready({ key: 'https://boards.greenhouse.io/acme/jobs/2' });
  const s = stateWith(j);
  s.approvals[j.key] = { sheetHash: 'sh1' };
  s.applications.push({ key: prior.key, companyKey: store.companyTitleKey(prior), at: new Date(NOW - 89 * 864e5).toISOString() });
  assert.equal(run(s).queue[0].reason, 'applied_to_company_title_within_90_days');
  s.applications[0].at = new Date(NOW - 91 * 864e5).toISOString();
  assert.ok(run(s).handout);
});

test('both modes: the guard self-test and DeepSeek off come first', () => {
  const j = ready();
  const s = stateWith(j);
  s.approvals[j.key] = { sheetHash: 'sh1' };
  assert.equal(run(s, { guard: { ok: false, reasons: ['probe_not_seen'] } }).refused, 'guard_missing');
  assert.equal(run(s, { guard: null }).refused, 'guard_missing');
  assert.equal(run(s, { deepseek: { enabled: true } }).refused, 'deepseek_on');
  assert.equal(run(s, { deepseek: { enabled: null } }).refused, 'deepseek_on', 'unreadable counts as on');
});

test('the person\'s own daily_max, and no daily_max meaning no limit', () => {
  const j = ready();
  const s = stateWith(j);
  s.approvals[j.key] = { sheetHash: 'sh1' };
  for (let i = 0; i < 40; i++) s.applications.push({ key: `x${i}`, companyKey: `c${i}|t`, at: new Date(NOW - 1000).toISOString() });
  assert.ok(run(s).handout, 'forty applications today and no rule: no limit');
  const o = { rules: [{ id: '1', effect: 'daily_max', value: 40 }], lessons: [] };
  assert.equal(run(s, { overlay: o }).refused, 'daily_max');
  o.rules[0].value = 41;
  assert.ok(run(s, { overlay: o }).handout);
});

// ---- unattended -------------------------------------------------------
const consented = (extra = {}) => {
  const p = profile();
  const s = stateWith();
  ap.recordConsent(s, p, empty(), NOW, 'skip');
  s.consent.dryRun = { records: [{ key: 'd' }], confirmedAt: new Date(NOW).toISOString(), rulesHash: ov.rulesHash(p, empty()) };
  Object.assign(s, extra);
  return s;
};

test('unattended: a table of rule cases, each to apply or to the attended queue', () => {
  const cases = [
    ['applies', {}, null],
    ['host not in the rules', { ats: 'ashby' }, 'host_not_in_rules'],
    ['role', { title: 'Account Manager' }, 'role_not_in_rules'],
    ['place', { city: 'Paris' }, 'place_not_in_rules'],
    ['remote job, remote not said', { city: '', remote: true }, 'place_not_in_rules'],
    ['level', { title: 'Junior Engineer' }, 'level_excluded'],
    ['pay floor, pay shown', { salary: '60000-80000 EUR' }, 'below_pay_floor'],
    ['pay floor, no pay shown', { salary: null }, null],
    ['excluded company', { company: 'Evilcorp' }, 'company_excluded'],
    ['score', { fit: 69 }, 'score_below_rule'],
    ['no score', { fit: undefined }, 'score_below_rule'],
    ['warning', { warnings: ['layoffs announced'] }, 'warning_blocks_unattended'],
  ];
  for (const [name, over, expected] of cases) {
    const j = ready(over);
    assert.equal(ap.unattendedRuleFailure(j, profile(), empty()), expected, name);
  }
});

test('unattended: rules and lessons from the person and the skill', () => {
  const o = { rules: [{ id: 'r1', effect: 'exclude_company', value: 'Globex' }], lessons: [{ effect: 'host_attended', subject: 'lever', expires: new Date(NOW + 864e5).toISOString() }, { effect: 'company_attended', subject: 'Hooli', expires: new Date(NOW + 864e5).toISOString() }] };
  assert.equal(ap.unattendedRuleFailure(ready({ company: 'Globex Inc' }), profile(), o), 'company_excluded');
  assert.equal(ap.unattendedRuleFailure(ready({ ats: 'lever' }), profile(), o), 'lesson_host_attended');
  assert.equal(ap.unattendedRuleFailure(ready({ company: 'Hooli' }), profile(), o), 'lesson_company_attended');
});

test('unattended: no submit without a recorded consent', () => {
  const j = ready();
  const s = stateWith(j);
  assert.equal(run(s, { mode: 'unattended' }).refused, 'no_consent');
});

test('unattended: a changed rules hash needs a new consent', () => {
  const j = ready();
  const s = consented();
  s.jobs[j.key] = j;
  assert.ok(run(s, { mode: 'unattended' }).handout);
  const changed = { ...profile(), unattended: { ...U, minScore: 50 } };
  assert.equal(run(s, { mode: 'unattended', profile: changed }).refused, 'rules_changed');
  const withRule = { rules: [{ id: 'r', effect: 'exclude_term', value: 'x' }], lessons: [] };
  assert.equal(run(s, { mode: 'unattended', overlay: withRule }).refused, 'rules_changed');
});

test('unattended: the dry run never hands out a submit, and submit needs the confirmed dry run', () => {
  const j = ready();
  const s = consented();
  s.jobs[j.key] = j;
  s.consent.dryRun = { records: [], confirmedAt: null, rulesHash: null };
  const dry = run(s, { mode: 'unattended' });
  assert.equal(dry.handout.dryRun, true);
  assert.equal(dry.handout.submit, false);
  assert.throws(() => ap.confirmDryRun(s, profile(), empty()), /no records/);
  ap.recordDryRun(s, { key: j.key, fields: {} });
  ap.confirmDryRun(s, profile(), empty(), NOW);
  const live = run(s, { mode: 'unattended' });
  assert.equal(live.handout.dryRun, false);
  assert.equal(live.handout.submit, true);
});

test('unattended: a job outside the rules goes to the attended queue with its reason', () => {
  const j = ready({ title: 'Junior Engineer' });
  const s = consented();
  s.jobs[j.key] = j;
  const r = run(s, { mode: 'unattended' });
  assert.equal(r.handout, null);
  assert.deepEqual(r.queue, [{ key: j.key, reason: 'level_excluded' }]);
});

test('unattended refuses to start without the guard', () => {
  const s = consented();
  s.jobs.x = ready();
  assert.equal(run(s, { mode: 'unattended', guard: { ok: false, reasons: ['hook_not_installed'] } }).refused, 'guard_missing');
});

test('consent needs complete rules and the EEO choice; no rule or lesson can record it', () => {
  const s = stateWith();
  assert.throws(() => ap.recordConsent(s, { eeo: 'decline_all' }, empty()), /not set/);
  assert.throws(() => ap.recordConsent(s, { unattended: U }, empty()), /EEO/);
  assert.throws(() => ap.recordConsent(s, { eeo: 'decline_all', unattended: { ...U, hosts: ['workday'] } }, empty()), /hosts/);
  assert.equal(s.consent.unattended, null);
  for (const effect of ['unattended_consent', 'consent']) assert.throws(() => ov.addRule({ effect, value: true, words: 'yes do it' }), /vocabulary/);
  assert.throws(() => ov.addLesson({ effect: 'unattended_consent', subject: 'x' }), /tighten-only/);
});

test('hand-out order: a host with a "go last" lesson comes after the others', () => {
  const a = ready({ ats: 'lever' });
  const b = ready();
  const s = stateWith(a, b);
  for (const j of [a, b]) s.approvals[j.key] = { sheetHash: 'sh1' };
  const o = { rules: [], lessons: [{ effect: 'host_last', subject: 'lever', expires: new Date(NOW + 864e5).toISOString() }] };
  assert.equal(run(s, { overlay: o }).handout.key, b.key);
});
