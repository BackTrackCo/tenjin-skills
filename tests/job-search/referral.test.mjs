import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const ref = await import(`${S}referral.mjs`);
const qs = await import(`${S}questions.mjs`);
const sheet = await import(`${S}sheet.mjs`);
const work = await import(`${S}work.mjs`);
const warm = await import(`${S}warmpath.mjs`);
const routed = await import(`${S}routed.mjs`);
const router = await import(`${S}router.mjs`);
const J = (...a) => runJobs(home, a);
const EEO = 'Decline every voluntary demographic question (test placeholder).';
const U = { roles: ['engineer'], places: ['Berlin'], remote: false, minScore: 50, hosts: ['*'] };
const NOW = Date.parse('2026-11-25T12:00:00Z');
const prof = (extra = {}) => ({ eeoText: EEO, applyMode: 'auto_write', unattended: U, ...extra });
const reset = (jobs = [], profile = prof()) => {
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'rules.json'), { force: true });
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState()); for (const j of jobs) s.jobs[j.key] = j; });
  J('profile', 'set', JSON.stringify(profile));
};
const job = (n, company, over = {}) => mkJob({ key: `https://jobs.site${n}.test/${company}/jobs/${n}`, status: 'apply_ready', company, title: 'Software Engineer', city: 'Berlin', fit: 90, verifiedAt: new Date().toISOString(), employerPosting: { url: `https://jobs.site${n}.test/${company}/jobs/${n}`, system: 'employer_site', token: null, jobId: null, source: 'careers_page', confidence: 'confirmed' }, sheet: { hash: `h${n}`, passed: true, eeoMissing: false, unanswered: [], forbidden: [], fields: [] }, ...over });
const profileFile = () => JSON.parse(fs.readFileSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), 'utf8'));


const empty = { rules: [], lessons: [] };
const ANSWERED = { referralList: { answeredAt: '2026-11-25T00:00:00.000Z', words: 'none' } };
// An auto mode ready to hand out: consent recorded and the dry run confirmed.
function auto(jobs, profile = prof()) {
  reset(jobs, profile);
  J('rules', 'add', '--effect', 'period_max', '--value', '5', '--words', 'five');
  J('consent', 'record', 'unattended', '--optional-writing', 'skip');
  for (const j of jobs) J('dryrun', 'record', j.key, '{}');
  J('dryrun', 'confirm');
}
const handout = () => { J('batch', 'open', '--unattended'); const r = J('apply', 'next', '--unattended'); return r; };
const clean = () => { J('batch', 'close'); store.updateState((s) => { for (const j of Object.values(s.jobs)) { j.parked = null; delete j.inFlight; } }); };

test('the parser: each separator, parentheses, colon, via and through, a leading "and", dedupe, and the "none" answers', () => {
  const names = (w) => ref.parseReferralList(w).map((x) => [x.company, x.referrer || null]);
  assert.deepEqual(names('Acme Placeholder; Beta Placeholder'), [['Acme Placeholder', null], ['Beta Placeholder', null]]);
  assert.deepEqual(names('Acme Placeholder, Beta Placeholder, and Gamma Placeholder'), [['Acme Placeholder', null], ['Beta Placeholder', null], ['Gamma Placeholder', null]], 'a leading and is dropped');
  assert.deepEqual(names('Acme Placeholder\nBeta Placeholder'), [['Acme Placeholder', null], ['Beta Placeholder', null]]);
  assert.deepEqual(names('Acme Placeholder (Pat Placeholder); Beta Placeholder'), [['Acme Placeholder', 'Pat Placeholder'], ['Beta Placeholder', null]]);
  assert.deepEqual(names('Acme Placeholder: Pat Placeholder, Beta Placeholder'), [['Acme Placeholder', 'Pat Placeholder'], ['Beta Placeholder', null]]);
  assert.deepEqual(names('Acme Placeholder via Pat Placeholder; Beta Placeholder through Sam Placeholder'), [['Acme Placeholder', 'Pat Placeholder'], ['Beta Placeholder', 'Sam Placeholder']]);
  assert.deepEqual(names('Acme Placeholder (Pat Placeholder, a friend); and Beta Placeholder'), [['Acme Placeholder', 'Pat Placeholder, a friend'], ['Beta Placeholder', null]], 'a comma inside parentheses stays');
  assert.deepEqual(names('Acme Placeholder, acme placeholder inc, Beta Placeholder'), [['Acme Placeholder', null], ['Beta Placeholder', null]], 'deduped by employer name');
  for (const w of ['none', 'None.', 'no one', 'No one.', 'nobody', 'No', 'n/a', 'N/A.', '  none  ', '']) assert.deepEqual(ref.parseReferralList(w), [], JSON.stringify(w));
  assert.deepEqual(names('none; Acme Placeholder'), [['Acme Placeholder', null]], 'a list that names a company is a list');
});

test('the start: the plain referral question comes with J start record in every apply mode, with no options, and J ask start has none', () => {
  for (const mode of ['attended', 'auto_no_new', 'auto_write', 'fill_only', 'open_only']) {
    reset([], {});
    const r = J('start', 'record', '--mode', mode, '--frequency', 'daily', '--where', 'employer');
    assert.equal(r.code, 0, r.stdout);
    assert.equal(typeof r.json.referral, 'string', mode);
    assert.match(r.json.referral, /^Which companies can you get a referral at\?/);
    assert.match(r.json.referral, /Say none if there are none/);
    assert.doesNotMatch(JSON.stringify(r.json.referral), /options|multiSelect/);
    assert.ok(store.loadState().start.referralAskedAt, 'recorded');
    const ask = J('ask', 'start').json;
    assert.doesNotMatch(JSON.stringify(ask), /referral/i, 'the question tool call carries no referral question');
    assert.equal(ask.questions.length, 4);
  }
  assert.equal(qs.referralQuestion().plain, ref.REFERRAL_QUESTION);
  reset([], {});
  assert.match(J('start', 'status').json.next, /four quick choices and one question about referrals/);
});

test('J start record asks again only for an auto mode while the list is unanswered', () => {
  reset([], {});
  assert.ok(J('start', 'record', '--mode', 'attended', '--where', 'employer').json.referral);
  assert.equal(J('start', 'record', '--mode', 'fill_only', '--where', 'employer').json.referral, undefined, 'not again in a mode that never waits');
  assert.ok(J('start', 'record', '--mode', 'auto_write', '--where', 'employer').json.referral, 'a person who switches to auto is asked again');
  assert.equal(J('referral', 'list', 'set', '--words', 'none').code, 0);
  assert.equal(J('start', 'record', '--mode', 'auto_write', '--where', 'employer').json.referral, undefined, 'answered: never again');
});

test('auto apply is blocked until the list is answered: no handout, no may-submit, 30 days later too, and one waiting item that never wakes the model', () => {
  const a = job(2, 'Acme Placeholder');
  auto([a]);
  J('batch', 'open', '--unattended');
  let r = J('apply', 'next', '--unattended');
  assert.equal(r.json.refused, 'referral_list_unanswered');
  J('batch', 'close');
  const later = Date.now() + 30 * 86400000;
  const profile = profileFile();
  assert.equal(ref.referralListAnswered(profile), false);
  const items = work.buildWorkList(store.loadState(), empty, later, profile).items.filter((i) => i.reason === 'referral_list');
  assert.equal(items.length, 1);
  assert.equal(work.waitsForPerson(store.loadState(), profile, items[0], empty), true, 'it never wakes the model');
  assert.match(items[0].gate, /J referral list set/);
  assert.match(work.notifyLine(store.loadState(), empty, Date.now()).line, /which companies you can get a referral at/);
  assert.match(require_report(), /Auto apply waits for one answer: which companies can you get a referral at, or none\?/);
  J('batch', 'open', '--unattended');
  store.updateState((s) => { s.jobs[a.key].inFlight = { mode: 'unattended', submit: true, sheetHash: 'h2', at: new Date().toISOString() }; });
  assert.equal(J('may-submit', a.key, 'h2').json.why, 'referral_list_unanswered');
  clean();
  assert.equal(J('referral', 'list', 'set', '--words', 'none').code, 0);
  r = handout();
  assert.equal(r.json.handout.key, a.key, 'after the answer the handout goes out');
});

function require_report() {
  const report = JSON.stringify(J('report', '--all').json || {}) + (J('report', '--all').stdout || '');
  return report;
}

test('"none" in any wording saves an empty answered list, and unattended handouts then pass for any company', () => {
  for (const words of ['none', 'None.', 'no one', 'n/a']) {
    const a = job(3, 'Acme Placeholder');
    auto([a]);
    const r = J('referral', 'list', 'set', '--words', words);
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(r.json.companies, []);
    const p = profileFile();
    assert.ok(p.referralList.answeredAt, words);
    assert.deepEqual(p.referrals, {});
    assert.equal(handout().json.handout.key, a.key, words);
    clean();
  }
  assert.equal(J('referral', 'list', 'set').code, 2, 'only from the person\'s own words');
});

test('a listed company holds unattended submits only; an attended approval offers to wait; fill-only and open-only show the note and never hold', () => {
  const a = job(4, 'Acme Placeholder');
  auto([a]);
  const set = J('referral', 'list', 'set', '--words', 'Acme Placeholder (Pat Placeholder)');
  assert.deepEqual(set.json.companies, [{ company: 'Acme Placeholder', referrer: 'Pat Placeholder' }]);
  assert.equal(profileFile().referrals['acme placeholder'].status, 'pending');
  const r = handout();
  assert.deepEqual(r.json.queue, [{ key: a.key, reason: 'referral_pending' }]);
  clean();
  J('batch', 'open', '--unattended');
  store.updateState((s) => { s.jobs[a.key].inFlight = { mode: 'unattended', submit: true, sheetHash: 'h4', at: new Date().toISOString() }; });
  assert.equal(J('may-submit', a.key, 'h4').json.why, 'referral_pending');
  clean();
  const q = qs.approvalQuestions(a, 'employer', { referral: ref.recordOf(profileFile(), a.company) });
  assert.ok(q.questions[0].options.some((o) => o.label === 'Wait for the referral'));
  for (const applyMode of ['fill_only', 'open_only']) {
    const p = { ...profileFile(), applyMode };
    assert.equal(ref.referralNote(p, a), 'referral pending at Acme Placeholder: Pat Placeholder', applyMode);
  }
  // an attended submit with a recorded yes passes may-submit
  reset([a], prof({ applyMode: 'attended' }));
  J('referral', 'list', 'set', '--words', 'Acme Placeholder');
  store.updateState((s) => { s.approvals[a.key] = { sheetHash: 'h4', at: new Date().toISOString() }; s.jobs[a.key].sheet = { hash: 'h4', passed: true, fields: [], eeoMissing: false }; s.jobs[a.key].inFlight = { mode: 'attended', sheetHash: 'h4', at: new Date().toISOString() }; });
  const m = J('may-submit', a.key, 'h4');
  assert.notEqual(m.json.why, 'referral_pending', JSON.stringify(m.json));
});

test('an unlisted company is asked nothing: no count, no referral work item, and the unattended handout passes', () => {
  const a = job(5, 'Acme Placeholder');
  auto([a], prof(ANSWERED));
  J('referral', 'list', 'set', '--words', 'Beta Placeholder');
  assert.equal(J('ask', 'referral').json.count, 0);
  const items = work.buildWorkList(store.loadState(), empty, Date.now(), profileFile()).items.filter((i) => /^referral/.test(i.reason));
  assert.deepEqual(items, []);
  assert.equal(handout().json.handout.key, a.key);
});

test('adding and removing later come only from the person\'s words; setting the list again keeps status and referrer of companies still listed', () => {
  const a = job(6, 'Acme Placeholder');
  auto([a], prof(ANSWERED));
  assert.equal(J('referral', 'add', 'Acme Placeholder', '--referrer', 'Pat Placeholder').code, 2, 'no words, no change');
  assert.equal(J('referral', 'add', 'Acme Placeholder', '--referrer', 'Pat Placeholder', '--words', 'add Acme Placeholder, Pat Placeholder can refer me').code, 0);
  assert.deepEqual(handout().json.queue, [{ key: a.key, reason: 'referral_pending' }], 'the new company holds');
  clean();
  assert.equal(J('referral', 'remove', 'Acme Placeholder').code, 2);
  assert.equal(J('referral', 'remove', 'Acme Placeholder', '--words', 'drop Acme Placeholder').code, 0);
  assert.equal(handout().json.handout.key, a.key, 'released');
  clean();
  J('referral', 'add', 'Acme Placeholder', '--referrer', 'Pat Placeholder', '--words', 'back again');
  J('referral', 'in', 'Acme Placeholder');
  J('referral', 'list', 'set', '--words', 'Acme Placeholder; Beta Placeholder');
  const p = profileFile();
  assert.equal(p.referrals['acme placeholder'].status, 'in', 'kept');
  assert.equal(p.referrals['acme placeholder'].referrer, 'Pat Placeholder', 'kept');
  assert.equal(p.referrals['beta placeholder'].status, 'pending');
  J('referral', 'list', 'set', '--words', 'Beta Placeholder');
  assert.deepEqual(Object.keys(profileFile().referrals), ['beta placeholder'], 'the rest is dropped');
  assert.equal(J('referral', 'list').json.companies.length, 1);
  assert.equal(J('referral', 'remove', 'Gamma Placeholder', '--words', 'x').code, 2, 'not on the list');
});

test('the follow-up comes 7 days after the first planned job, or after the person\'s own delay, and "Not yet" restarts the clock', () => {
  const t0 = Date.parse('2026-11-01T00:00:00Z');
  const a = job(7, 'Acme Placeholder', { firstSeen: new Date(t0).toISOString() });
  const b = job(8, 'Acme Placeholder', { firstSeen: new Date(t0 + 3 * 86400000).toISOString() });
  reset([a, b], prof(ANSWERED));
  J('referral', 'list', 'set', '--words', 'Acme Placeholder');
  const waiting = (at, overlay = empty) => ref.referralWaiting(store.loadState(), profileFile(), overlay, at).due.length;
  assert.equal(waiting(t0 + 6 * 86400000), 0);
  assert.equal(waiting(t0 + 7 * 86400000), 1, 'from the earliest planned job');
  assert.equal(waiting(t0 + 3 * 86400000, { rules: [{ effect: 'referral_delay_days', value: 2 }] }), 1, 'the person\'s own delay');
  assert.equal(profileFile().referrals['acme placeholder'].pendingAt, undefined, 'the clock is computed, never written');
  const before = Date.now();
  J('referral', 'notyet', 'Acme Placeholder');
  const at = Date.parse(profileFile().referrals['acme placeholder'].pendingAt);
  assert.ok(at >= before - 1000);
  assert.equal(waiting(at + 6 * 86400000), 0, 'restarted');
  assert.equal(waiting(at + 8 * 86400000), 1);
  const f = ref.followUpQuestion('Acme Placeholder').questions[0];
  assert.deepEqual(f.options.map((o) => o.label), ['Yes, apply now', 'Not yet', 'Apply without it']);
  const ask = J('ask', 'referral');
  assert.equal(ask.json.count, ask.json.followUps.reduce((n, c) => n + c.questions.length, 0));
  assert.equal(J('referral', 'in', 'Acme Placeholder').code, 0);
  assert.equal(profileFile().referrals['acme placeholder'].status, 'in');
  assert.equal(J('referral', 'without', 'Acme Placeholder').code, 0);
});

test('the Referred by field gets the name given and wins over where-you-heard; with no name a required field is a missing fact', () => {
  const j = job(9, 'Acme Placeholder', { source: 'indeed' });
  const questions = [
    { label: 'Referred by', required: true, type: 'input_text' },
    { label: 'How did you hear about this job?', required: true, type: 'multi_value_single_select', options: ['Job board', 'Employee referral', 'Other'] },
  ];
  const base = { job: j, questions, answers: [], drafts: {} };
  const withName = sheet.buildSheet({ ...base, profile: { referrals: { 'acme placeholder': { company: 'Acme Placeholder', status: 'pending', referrer: 'Pat Placeholder' } } } });
  assert.deepEqual(withName.fields.map((f) => [f.label, f.value, f.tag]), [['Referred by', 'Pat Placeholder', 'fact'], ['How did you hear about this job?', 'Employee referral', 'fact']]);
  const listedNoName = sheet.buildSheet({ ...base, profile: { referrals: { 'acme placeholder': { company: 'Acme Placeholder', status: 'pending' } } } });
  assert.deepEqual(listedNoName.unanswered.map((u) => u.label), ['Referred by'], 'a missing fact, never guessed');
  const unlisted = sheet.buildSheet({ ...base, profile: {} });
  assert.ok(!unlisted.fields.some((f) => f.label === 'Referred by'));
});

test('J referral answer is gone, and nothing outside the follow-up asks about a company', () => {
  reset([job(10, 'Acme Placeholder')], prof(ANSWERED));
  const r = J('referral', 'answer', 'acme placeholder', 'none');
  assert.equal(r.code, 2);
  assert.match(r.json.error, /referral list/);
  assert.equal(J('ask', 'referral').json.count, 0);
  assert.equal(J('referral', 'name', 'Acme Placeholder', 'Pat Placeholder').code, 2, 'not on the list: nothing is added by itself');
  assert.equal(ref.referralHold(prof(), job(10, 'Acme Placeholder')), null);
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'skills', 'job-search', 'scripts', 'lib', 'referral.mjs'), 'utf8');
  assert.doesNotMatch(src, /referralCalls|referral_check/);
});

test('the profile refuses the old "none" status and takes only pending, in and without', () => {
  reset([], {});
  assert.notEqual(J('profile', 'set', JSON.stringify({ referrals: { acme: { status: 'none' } } })).code, 0);
  assert.equal(J('profile', 'set', JSON.stringify({ referrals: { acme: { company: 'Acme', status: 'without' } } })).code, 0);
});

test('the referral commands are refused in an unattended batch', () => {
  reset([job(11, 'Acme Placeholder')], prof(ANSWERED));
  J('batch', 'open', '--unattended');
  for (const args of [['list', 'set', '--words', 'none'], ['add', 'Acme Placeholder', '--words', 'x'], ['remove', 'Acme Placeholder', '--words', 'x']]) assert.equal(J('referral', ...args).code, 4, args[0]);
});

// ---- the "also worked at" hints --------------------------------------------------------------------------------
test('only a small past employer gives a hint without the checks; the ranges are read by their upper bound', () => {
  for (const small of ['1-10', '11-50', '2-10']) assert.equal(warm.isSmall(small), true, small);
  for (const big of ['51-200', '201-500', '501-1K', '1K-5K', '10K+', '', null]) assert.equal(warm.isSmall(big), false, String(big));
});

test('a big-employer hint needs both an overlap and a shared team word; a generic word alone is no match; no titles or dates means no hint', () => {
  const me = [{ company: 'Placeholder Labs', title: 'Payments Engineer', start: '2018-06', end: '2021-02' }];
  const cand = (over) => [{ company: 'Placeholder Labs', title: 'Senior Payments Engineer', start: '2019-01', end: '2022-01', ...over }];
  assert.deepEqual(warm.bigEmployerMatch(me, cand(), 'Placeholder Labs', NOW).team, 'payments');
  assert.equal(warm.bigEmployerMatch(me, cand({ start: '2021-06', end: '2023-01' }), 'Placeholder Labs', NOW), null, 'same team, no overlap');
  assert.equal(warm.bigEmployerMatch(me, cand({ title: 'Staff Software Engineer' }), 'Placeholder Labs', NOW), null, 'overlap, generic words only');
  assert.equal(warm.sharedTeamWord('Senior Software Engineer', 'Engineering Manager'), null);
  assert.equal(warm.bigEmployerMatch(me, cand({ title: '' }), 'Placeholder Labs', NOW), null, 'no title');
  assert.equal(warm.bigEmployerMatch(me, cand({ start: null }), 'Placeholder Labs', NOW), null, 'no dates');
  assert.equal(warm.bigEmployerMatch([{ company: 'Placeholder Labs', title: 'Payments Engineer' }], cand(), 'Placeholder Labs', NOW), null, 'the person\'s own dates are missing');
  assert.equal(warm.bigEmployerMatch([], cand(), 'Placeholder Labs', NOW), null);
  assert.equal(warm.bigEmployerMatch(me, cand({ company: 'Other Co' }), 'Placeholder Labs', NOW), null, 'another employer');
});

// A router client that answers by the need: a spec, then the run. It counts the profile reads.
function fakeRouter({ employees, leads, histories }) {
  const reads = [];
  let last = null;
  const client = {
    timeouts: router.TIMEOUTS,
    async start() {},
    async close() {},
    async request(args) {
      if (args.tool === 'companyenrich-properties') { last = 'company'; return { status: 'spec', id: 'o-company', __text: 'company profile lookup' }; }
      if (typeof args.query === 'string') {
        if (/people search/.test(args.query)) { last = 'people'; return { status: 'spec', id: 'o-people', __text: 'POST https://x402.orthogonal.com/people/search' }; }
        last = 'profile';
        last = { profile: /linkedin\.com\/in\/([\w-]+)/.exec(args.query)[1] };
        return { status: 'spec', id: 'o-profile', __text: 'POST https://api.getanyapi.com/v1/run/linkedin.profile' };
      }
      if (args.id === 'o-company') return { status: 'fulfilled', result: JSON.stringify({ name: 'Placeholder Labs', domain: 'placeholderlabs.test', employees, socials: {} }), cost: ['x'] };
      if (args.id === 'o-people') return { status: 'fulfilled', supplier: 'x402.orthogonal.com', result: JSON.stringify({ success: true, total: leads.length, leads }), cost: ['x'] };
      const handle = (last && last.profile) || '';
      reads.push(handle);
      return { status: 'fulfilled', supplier: 'api.getanyapi.com', result: JSON.stringify({ output: { found: true, data: { firstName: handle, lastName: 'Sample', headline: 'x', experience: histories[handle] || [] } } }), cost: ['x'] };
    },
  };
  return { client, reads };
}
const lead = (handle) => ({ firstname: handle, lastname: 'Sample', headline: 'Engineer at Target Placeholder', profileUrl: `https://www.linkedin.com/in/${handle}`, lastJobTitle: 'Software Engineer', lastCompanyName: 'Target Placeholder', address: 'Berlin' });
const exp = (title, start, end) => [{ position: title, companyName: 'Placeholder Labs', startDate: start, endDate: end }];
const history = [{ company: 'Placeholder Labs', title: 'Payments Engineer', start: '2018-06', end: '2021-02' }];

test('small past employer: each person now at the target who also worked there is a hint, with no profile read', async () => {
  reset([job(20, 'Target Placeholder')]);
  const f = fakeRouter({ employees: '11-50', leads: [lead('alex'), lead('sam')], histories: {} });
  const log = await routed.routeWarmPaths({ profile: prof({ resumeHistory: history }), client: f.client, now: NOW });
  assert.equal(log[0].small, true);
  assert.deepEqual(f.reads, [], 'no overlap check for a small employer');
  const hints = store.loadState().alsoWorked['target placeholder'].hints;
  assert.deepEqual(hints.map((h) => [h.name, h.pastCompany, h.basis]), [['alex Sample', 'Placeholder Labs', 'small employer'], ['sam Sample', 'Placeholder Labs', 'small employer']]);
});

test('big past employer: one profile read per candidate, and only the overlap plus the team word makes a hint', async () => {
  reset([job(21, 'Target Placeholder')]);
  const f = fakeRouter({
    employees: '1K-5K',
    leads: [lead('alex'), lead('sam'), lead('kim')],
    histories: { alex: exp('Senior Payments Engineer', 'Jan 2019', 'Jan 2022'), sam: exp('Software Engineer', 'Jan 2019', 'Jan 2022'), kim: exp('Payments Engineer', '2022-06', '2023-01') },
  });
  await routed.routeWarmPaths({ profile: prof({ resumeHistory: history }), client: f.client, now: NOW });
  assert.deepEqual(f.reads.sort(), ['alex', 'kim', 'sam'], 'one read for each candidate');
  const hints = store.loadState().alsoWorked['target placeholder'].hints;
  assert.deepEqual(hints.map((h) => h.name), ['alex Sample']);
  assert.match(hints[0].basis, /same team \(payments\) and overlapping dates/);
  // no titles or dates of the person's own: no hint, and no call is made at all
  const g = fakeRouter({ employees: '1K-5K', leads: [lead('alex')], histories: {} });
  const none = await routed.routeWarmPaths({ profile: prof({}), client: g.client, now: NOW });
  assert.equal(none[0].ok, false);
  assert.deepEqual(g.reads, []);
});

test('hints are shown as contacts marked "also worked at", and nothing reads or stores connections', () => {
  const text = (f) => fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'scripts', f), 'utf8');
  reset([job(22, 'Target Placeholder')]);
  store.updateState((s) => { s.alsoWorked = { 'target placeholder': { company: 'Target Placeholder', hints: [{ name: 'Alex Sample', title: 'Engineer', url: 'https://www.linkedin.com/in/alex', pastCompany: 'Placeholder Labs', basis: 'small employer' }] } }; });
  const out = J('report', '--all').stdout;
  assert.match(out, /Also worked at \(people you could ask; the skill never contacts them, and none counts as a referral unless you say so\)/);
  assert.match(out, /Target Placeholder: Alex Sample, Engineer: also worked at Placeholder Labs \(small employer\)/);
  for (const f of ['lib/warmpath.mjs', 'lib/referral.mjs']) assert.doesNotMatch(text(f).replace(/\/\/.*$/gm, ''), /connections?\b/i, f);
  assert.doesNotMatch(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'loop-base', 'lib', 'suppliers', 'linkedin-history.mjs'), 'utf8').replace(/\/\/.*$/gm, ''), /connection/i);
});


test('the request draft is saved as a draft and never sent: no email draft or handout is made', () => {
  reset([job(12, 'Acme Placeholder')], prof(ANSWERED));
  J('referral', 'list', 'set', '--words', 'Acme Placeholder');
  assert.equal(J('referral', 'draft', 'acme placeholder').code, 2, 'the name comes first');
  J('referral', 'name', 'acme placeholder', 'Pat Placeholder');
  const d = J('referral', 'draft', 'acme placeholder');
  assert.match(d.json.prompt, /at most 90 words/);
  const file = path.join(home, 'draft.txt');
  fs.writeFileSync(file, 'Hi Pat Placeholder, would you be willing to refer me for the engineering role at Acme Placeholder? Thank you.');
  const saved = J('referral', 'draft-save', 'acme placeholder', '--text', file);
  assert.equal(saved.code, 0, saved.stdout);
  assert.match(saved.json.next, /Nothing is sent without that yes/);
  assert.match(profileFile().referrals['acme placeholder'].draft.text, /refer me/);
  fs.writeFileSync(file, 'Hi [name], please refer me.');
  assert.equal(J('referral', 'draft-save', 'acme placeholder', '--text', file).code, 2, 'a placeholder is refused');
  assert.deepEqual(Object.keys((store.loadState().emails && store.loadState().emails.drafts) || {}), [], 'no email draft exists');
  assert.equal(J('email', 'next').json.handout, null);
});

test('the referral request goes through the email flow only to an address the person typed, with its own yes, never under the consent or unattended', () => {
  reset([job(30, 'Acme Placeholder')], prof(ANSWERED));
  J('referral', 'list', 'set', '--words', 'Acme Placeholder (Pat Placeholder)');
  assert.equal(J('referral', 'email', 'acme placeholder', 'person@example.test').code, 2, 'save the draft first');
  const file = path.join(home, 'draft2.txt');
  fs.writeFileSync(file, 'Hi Pat Placeholder, would you be willing to refer me for the engineering role at Acme Placeholder? Thank you.');
  J('referral', 'draft-save', 'acme placeholder', '--text', file);
  assert.equal(J('referral', 'email', 'acme placeholder', 'not an address').code, 2);
  assert.equal(J('referral', 'email', 'acme placeholder', 'person@example.test').code, 0);
  const b = J('email', 'batch');
  assert.deepEqual(b.json.drafts.map((d) => d.to), ['person@example.test']);
  J('email', 'connector', 'send');
  J('consent', 'record', 'email');
  assert.equal(J('email', 'next', '--unattended').json.handout, null, 'the consent and an unattended turn never send it');
  assert.equal(J('email', 'next').json.handout, null, 'not without its own yes');
  J('email', 'approve', b.json.drafts[0].id);
  const h = J('email', 'next').json.handout;
  assert.equal(h.to, 'person@example.test');
  assert.match(h.text, /refer me/);
});
