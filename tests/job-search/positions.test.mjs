import test from 'node:test';
import assert from 'node:assert/strict';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const ap = await import('../../skills/job-search/scripts/lib/apply.mjs');
const work = await import('../../skills/job-search/scripts/lib/work.mjs');
const sched = await import('../../skills/job-search/scripts/lib/schedule.mjs');
const ov = await import('../../skills/job-search/scripts/lib/overlay.mjs');
const q = await import('../../skills/job-search/scripts/lib/questions.mjs');

const NOW = Date.parse('2026-11-23T12:00:00');
const empty = { rules: [], lessons: [] };
const rule = (value) => ({ rules: [{ id: 'r', effect: 'period_max', value, words: 'x', date: '2026-11-23' }], lessons: [] });
const profile = { eeo: 'decline_all', unattended: { roles: ['engineer'], places: ['Berlin'], minScore: 70, hosts: ['greenhouse'] }, search: { role: 'engineer' } };

// ---- the start questions: four in one call after the resume ------------------
test('the start: the resume is a plain question, then one call with four questions', () => {
  assert.match(q.START_RESUME_QUESTION, /plain question/);
  const p = q.startQuestions();
  assert.equal(p.questions.length, 4);
  assert.deepEqual(p.questions.map((x) => x.header), ['Apply mode', 'Search', 'Positions', 'Remote']);
  assert.deepEqual(q.validateAsk(p), []);
  for (const x of p.questions) assert.match(x.options[0].label, /\(Recommended\)$/);
  assert.deepEqual(p.questions[1].options.map((o) => o.label), ['Every day (Recommended)', 'Twice a day', 'Once a week']);
  assert.deepEqual(p.questions[2].options.map((o) => o.label), ['Up to 10 (Recommended)', 'Up to 5', 'Up to 20']);
  assert.match(p.questions[1].options[0].description, /runs in code at the router's price, with no Claude usage for the searches/);
  assert.match(p.questions[3].options[0].description, /\/remote-control/);
  assert.ok(p.questions[0].options.length === 3 && p.questions[0].options[1].label.startsWith('Auto apply only when there are no new questions'));
});

test('the other questions go through the same tool: resume choice, Tenjin ask, EEO, optional writing, facts, the yes', () => {
  const all = [q.resumeChoiceQuestion({ header: 'Role', question: 'Which role?', guess: 'Backend engineer', next: 'Data engineer' }), q.tenjinAsk({ line: 'Tenjin adds X.', status: 'missing' }), q.tenjinAsk({ line: 'Tenjin adds X.', status: 'unfunded' }), q.eeoQuestion(), q.optionalWritingQuestion(), q.factQuestion({ label: 'Work authorization', options: ['Yes', 'No'] }), q.sheetYesQuestion({ company: 'Acme', title: 'Engineer' })];
  for (const p of all) assert.deepEqual(q.validateAsk(p), [], JSON.stringify(p).slice(0, 80));
  assert.match(all[0].questions[0].options[0].label, /\(from your resume\)$/);
  assert.equal(all[5].questions[0].options.at(-1).label, 'Skip this job');
  assert.deepEqual(q.validateAsk({ questions: [] }), ['1 to 4 questions per call']);
  assert.ok(q.validateAsk({ questions: [{ header: 'A', question: 'q', options: [{ label: 'only', description: 'one' }] }] }).length);
});

test('the CLI prints the payload for the question tool, and none in an unattended turn', () => {
  const r = runJobs(home, ['ask', 'start']);
  assert.equal(r.json.questions.length, 4);
  assert.equal(runJobs(home, ['ask', 'nonsense']).code, 2);
  const b = runJobs(home, ['batch', 'open', '--unattended']);
  assert.equal(b.code, 0);
  assert.equal(runJobs(home, ['ask', 'start']).code, 4, 'nobody can answer in an unattended turn');
  runJobs(home, ['batch', 'close']);
});

test('start record: the mode, the frequency and the count are kept; no answer to the count means no limit', () => {
  const r = runJobs(home, ['start', 'record', '--mode', 'attended', '--frequency', 'twice_daily', '--positions', '5', '--remote-control', 'later', '--words', 'up to 5 per period']);
  assert.equal(r.code, 0, r.stdout);
  const prof = runJobs(home, ['profile', 'get']).json;
  assert.deepEqual([prof.applyMode, prof.frequency, prof.frequencySource], ['attended', 'twice_daily', 'person']);
  const rules = runJobs(home, ['rules']).json;
  assert.deepEqual(rules.map((x) => [x.effect, x.value, x.words]), [['period_max', 5, 'up to 5 per period']]);
  assert.ok(store.loadState().start.rcOfferedAt, 'Remote Control is offered once and recorded');
  // no answer to the count: nothing is recorded, so there is no limit
  store.updateState((s) => { Object.assign(s, store.emptyState()); });
  const none = runJobs(home, ['start', 'record', '--mode', 'attended', '--frequency', 'daily']);
  assert.equal(none.json.recorded.positions, 'skip');
  assert.equal(ap.periodLimit(ov.loadOverlay()), 5, 'the earlier rule file is untouched here');
  assert.equal(runJobs(home, ['start', 'record', '--mode', 'sideways']).code, 2);
  assert.equal(runJobs(home, ['start', 'status']).json.missing.includes('resume'), true);
});

// ---- frequency sets when the search is due ---------------------------------------
test('the frequency sets when search_due comes up', () => {
  const H = 3600000;
  const at = (h) => new Date(NOW - h * H).toISOString();
  const due = (freq, hoursAgo) => {
    const s = store.emptyState();
    s.routed.lastSearchAt = at(hoursAgo);
    return work.buildWorkList(s, empty, NOW, { ...profile, frequency: freq, sweepHour: 0 }).items.some((i) => i.reason === 'search_due');
  };
  assert.equal(due('daily', 10), false);
  assert.equal(due('daily', 21), true);
  assert.equal(due('twice_daily', 6), false);
  assert.equal(due('twice_daily', 10.5), true);
  assert.equal(due('weekly', 30), false);
  assert.equal(due('weekly', 24 * 6.9), true);
  assert.equal(due(undefined, 21), true, 'daily by default');
  assert.deepEqual(sched.INTERVAL_MS, { daily: 24 * H, twice_daily: 12 * H, weekly: 168 * H });
  assert.equal(runJobs(home, ['frequency', 'set', 'hourly']).code, 2);
  assert.equal(runJobs(home, ['frequency', 'set', 'weekly']).code, 0);
  assert.equal(runJobs(home, ['profile', 'get']).json.frequency, 'weekly');
});

test('the period starts at midnight, noon or Monday', () => {
  const d = (s) => new Date(s).getTime();
  assert.equal(sched.periodStart(d('2026-11-23T15:30:00'), 'daily'), d('2026-11-23T00:00:00'));
  assert.equal(sched.periodStart(d('2026-11-23T15:30:00'), 'twice_daily'), d('2026-11-23T12:00:00'));
  assert.equal(sched.periodStart(d('2026-11-23T09:30:00'), 'twice_daily'), d('2026-11-23T00:00:00'));
  assert.equal(sched.periodStart(d('2026-11-25T09:30:00'), 'weekly'), d('2026-11-23T00:00:00')); // 2026-11-23 is a Monday
});

// ---- the count holds the extra jobs for the next period and drops none --------------
const readyJobs = (n) => Array.from({ length: n }, (_, i) => mkJob({ key: `https://boards.greenhouse.io/acme/jobs/${200 + i}`, status: 'apply_ready', fit: 90 - i, sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [] } }));
const stateOf = (jobs) => { const s = store.emptyState(); for (const j of jobs) s.jobs[j.key] = j; return s; };

test('attended: only the count of sheets is brought for the yes, best fit first; the rest wait for the next period, none dropped', () => {
  const s = stateOf(readyJobs(7));
  const first = work.buildWorkList(s, rule(3), NOW, profile);
  assert.deepEqual(first.items.filter((i) => i.reason === 'apply_ready').map((i) => i.key.slice(-3)), ['200', '201', '202']);
  assert.equal(first.heldForPeriod, 4);
  for (const k of first.bring) s.jobs[k].broughtAt = new Date(NOW).toISOString();
  // later in the same period the same three remain, and nothing new comes
  const again = work.buildWorkList(s, rule(3), NOW + 3600000, profile);
  assert.deepEqual(again.items.filter((i) => i.reason === 'apply_ready').length, 3);
  assert.equal(again.heldForPeriod, 4);
  // the next day the person said yes to two; three more are brought, none of the seven is gone
  for (const k of ['200', '201']) s.jobs[`https://boards.greenhouse.io/acme/jobs/${k}`].status = 'submitted';
  const next = work.buildWorkList(s, rule(3), NOW + 24 * 3600000, profile);
  assert.deepEqual(next.items.filter((i) => i.reason === 'apply_ready').map((i) => i.key.slice(-3)), ['202', '203', '204', '205']);
  assert.equal(next.heldForPeriod, 1);
  assert.equal(Object.keys(s.jobs).length, 7);
  assert.ok(Object.values(s.jobs).every((j) => j.status !== 'skipped'));
});

test('no answer to the count means no limit; "none" and no rule are the same', () => {
  const s = stateOf(readyJobs(25));
  for (const o of [empty, rule('none')]) {
    const wl = work.buildWorkList(s, o, NOW, profile);
    assert.equal(wl.items.filter((i) => i.reason === 'apply_ready').length, 25);
    assert.equal(wl.heldForPeriod, 0);
  }
  assert.equal(ap.periodLimit(empty), null);
  assert.equal(ap.periodLimit(rule('none')), null);
  assert.equal(ap.periodLimit(rule(10)), 10);
});

test('the work-list commit marks the sheets as brought, once', () => {
  store.updateState((st) => { Object.assign(st, store.emptyState()); for (const j of readyJobs(4)) st.jobs[j.key] = j; });
  runJobs(home, ['profile', 'set', JSON.stringify(profile)]);
  runJobs(home, ['rules', 'add', '--effect', 'period_max', '--value', '2', '--words', 'two per period']);
  const w = runJobs(home, ['work', '--commit']).json;
  assert.equal(w.items.filter((i) => i.reason === 'apply_ready').length, 2);
  assert.equal(Object.values(store.loadState().jobs).filter((j) => j.broughtAt).length, 2);
  assert.equal(runJobs(home, ['work']).json.items.filter((i) => i.reason === 'apply_ready').length, 2, 'the same two, no new ones this period');
});

test('auto: the count limits the applications of one period; the rest wait and none is dropped', () => {
  const jobs = readyJobs(4);
  const s = stateOf(jobs);
  ap.recordConsent(s, profile, empty, NOW, 'skip');
  s.consent.dryRun = { records: [{ key: 'd' }], confirmedAt: new Date(NOW).toISOString(), rulesHash: ov.rulesHash(profile, empty) };
  const next = (o) => ap.applyNext({ state: s, profile: { ...profile, frequency: 'daily' }, overlay: o, mode: 'unattended', now: NOW, batchOpen: true });
  for (const j of jobs) j.fit = 90;
  const o = rule(2);
  for (let i = 0; i < 2; i++) {
    const r = next(o);
    assert.ok(r.handout, `handout ${i} ${JSON.stringify(r)}`);
    s.handouts.push({ key: r.handout.key, at: new Date(NOW).toISOString(), counted: r.handout.submit });
    s.jobs[r.handout.key].status = 'submitted';
  }
  const third = next(o);
  assert.equal(third.refused, 'period_max');
  assert.equal(Object.values(s.jobs).filter((j) => j.status === 'apply_ready').length, 2, 'the rest are waiting, not dropped');
  const later = ap.applyNext({ state: s, profile: { ...profile, frequency: 'daily' }, overlay: o, mode: 'unattended', now: NOW + 24 * 3600000, batchOpen: true });
  assert.ok(later.handout, 'the next period');
  assert.ok(ap.applyNext({ state: s, profile, overlay: empty, mode: 'unattended', now: NOW, batchOpen: true }).handout, 'no rule, no limit');
});

test('the positions rule keeps the words and date, and is a number or none', () => {
  assert.throws(() => ov.addRule({ effect: 'period_max', value: 'lots', words: 'x' }), /whole number/);
  assert.throws(() => ov.addRule({ effect: 'period_max', value: 0, words: 'x' }), /whole number/);
  assert.throws(() => ov.addRule({ effect: 'daily_max', value: 5, words: 'x' }), /vocabulary/, 'replaced by the per-period rule');
  const r = ov.addRule({ effect: 'period_max', value: 7, words: 'seven a period', date: '2026-11-23' });
  assert.deepEqual([r.words, r.date], ['seven a period', '2026-11-23']);
});
