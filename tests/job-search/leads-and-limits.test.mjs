import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeFetch, mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const ing = await import('../../skills/job-search/scripts/lib/ingest.mjs');
const ap = await import('../../skills/job-search/scripts/lib/apply.mjs');
const ov = await import('../../skills/job-search/scripts/lib/overlay.mjs');
const work = await import('../../skills/job-search/scripts/lib/work.mjs');
const report = await import('../../skills/job-search/scripts/lib/report.mjs');
const writing = await import('../../skills/job-search/scripts/lib/writing.mjs');
const routed = await import('../../skills/job-search/scripts/lib/routed.mjs');
const router = await import('../../skills/job-search/scripts/lib/router.mjs');

const NOW = Date.parse('2026-11-23T10:00:00Z');
const empty = { rules: [], lessons: [] };
const reset = () => store.updateState((s) => { Object.assign(s, store.emptyState()); });
const rule = (effect, value) => ({ rules: [{ id: effect, effect, value, words: 'w', date: '2026-11-23' }], lessons: [] });
const profile = { eeo: 'decline_all', unattended: { roles: ['engineer'], places: ['Berlin'], minScore: 70, hosts: ['greenhouse'] } };

// ---- fix 4: limits that loosen need a new consent ---------------------------------
test('adding or lowering period_max, or adding fill_only, only tightens and keeps the consent', () => {
  const consentWith = (o) => { const s = store.emptyState(); ap.recordConsent(s, profile, o, NOW, 'skip'); return s; };
  const status = (s, o) => ap.consentStatus(s, profile, o).ok;
  const base = consentWith(empty);
  assert.equal(status(base, rule('period_max', 5)), true, 'adding a limit tightens');
  assert.equal(status(base, rule('fill_only', true)), true, 'adding fill-only tightens');
  const limited = consentWith(rule('period_max', 10));
  assert.equal(status(limited, rule('period_max', 5)), true, 'lowering tightens');
  assert.equal(status(limited, rule('period_max', 10)), true, 'the same is fine');
});

test('removing or raising period_max, or removing fill_only, loosens an unattended run and needs a new consent', () => {
  const consentWith = (o) => { const s = store.emptyState(); ap.recordConsent(s, profile, o, NOW, 'skip'); return s; };
  const status = (s, o) => ap.consentStatus(s, profile, o);
  const limited = consentWith(rule('period_max', 10));
  for (const o of [empty, rule('period_max', 'none'), rule('period_max', 20)]) assert.deepEqual(status(limited, o), { ok: false, reason: 'rules_changed' });
  const fill = consentWith(rule('fill_only', true));
  assert.equal(status(fill, empty).reason, 'rules_changed');
  assert.equal(status(fill, rule('fill_only', 'acme')).reason, 'rules_changed', 'a named company is looser than every job');
  const named = consentWith(rule('fill_only', 'acme'));
  assert.equal(status(named, rule('fill_only', true)).ok, true);
  assert.equal(status(named, empty).reason, 'rules_changed');
  // a new consent under the new limits is valid again
  const again = consentWith(empty);
  assert.equal(status(again, empty).ok, true);
});

// ---- fix 5: the Tenjin hint rides on an unattended notification when it fits ---------
test('in an unattended run the Tenjin hint rides on the notification line only when it fits under 200 characters; the approved search hint is longer, so it stays in the report', () => {
  const s = store.emptyState();
  s.tenjin.status = 'missing';
  const j = mkJob({ status: 'apply_ready', company: 'Initech' });
  s.jobs[j.key] = j;
  const attended = work.notifyLine(s, empty, NOW);
  assert.match(attended.line, /wait for your yes/);
  assert.doesNotMatch(attended.line, /With Tenjin/);
  const un = work.notifyLine(s, empty, NOW, { unattended: true });
  assert.ok(un.line.length < 200);
  assert.equal(un.line, attended.line, 'the approved hint is too long to fit the 200-character line: it stays in the report');
  assert.ok(work.HINT_LINES.daily_search.length + attended.line.length + 3 >= 200);
  // with a long line the hint stays in the report only
  const long = store.emptyState();
  long.tenjin.status = 'missing';
  for (let i = 0; i < 6; i++) { const k = mkJob({ status: 'apply_ready', company: `Company ${i}` }); k.parked = { key: 'k', reasons: ['needs_facts'] }; k.missingFacts = ['authorized_to_work', 'requires_sponsorship', 'salary_expectation']; long.jobs[k.key] = k; }
  const l = work.notifyLine(long, empty, NOW, { unattended: true });
  assert.ok(l.line.length < 200);
  assert.doesNotMatch(l.line, /With Tenjin/);
  assert.match(report.renderReport(store.emptyState(), empty, { now: NOW }), /Job Search report/);
  s.tenjin.status = 'ready';
  assert.doesNotMatch(work.notifyLine(s, empty, NOW, { unattended: true }).line, /With Tenjin/);
});

// ---- ruling 16: outcomes and leads ----------------------------------------------------
const posts = () => [
  { url: 'https://x.com/ada_dev/status/111', author: 'ada_dev', postedAt: null, text: 'We are hiring a platform engineer in Berlin. DM me!', status: 'new', source: 'x' },
  { url: 'https://x.com/bo/status/222', author: 'bo', postedAt: null, text: 'Hiring: backend engineer, Berlin. Apply at https://boards.greenhouse.io/acme/jobs/77', status: 'new', source: 'x' },
  { url: 'hn:333', author: 'cy', postedAt: null, text: 'Initech (Berlin) | Software Engineer | email jobs@initech.test to apply', status: 'new', source: 'hn' },
  { url: 'hn:444', author: 'di', postedAt: null, text: 'Globex is hiring, onsite Berlin', status: 'new', source: 'hn' },
  { url: 'https://x.com/ed/status/555', author: 'ed', postedAt: null, text: 'Great weather today', status: 'new', source: 'x' },
];
const file = (over) => ({ need: 'hn_hiring_posts', query: { role: 'engineer', place: 'Berlin', remote: false, since: null }, status: 'fulfilled', batch: posts().map((p) => p.url), postings: [], outcomes: [], leads: [], ...over });
const run = (obj, f = fakeFetch({})) => ing.ingest({ obj, state: store.loadState(), profile: { places: ['Berlin'], includeOld: true }, overlay: empty, fetch: f, now: NOW });
const seed = () => { reset(); store.updateState((s) => { s.posts = posts(); }); };

test('a file with a post that has no outcome is refused, and every post stays in the queue', async () => {
  seed();
  const r = await run(file({ outcomes: [{ url: posts()[0].url, outcome: 'no_fit' }] }));
  assert.match(r.held[0], /no outcome for 4 posts/);
  assert.equal(store.loadState().posts.length, 5);
  assert.equal(store.loadState().leads.length, 0);
  assert.match((await run(file({ outcomes: [...posts().map((p) => ({ url: p.url, outcome: 'no_fit' })), { url: posts()[0].url, outcome: 'job' }] }))).held[0], /two outcomes/);
  assert.match((await run(file({ outcomes: posts().map((p) => ({ url: p.url, outcome: 'maybe' })) }))).held[0], /one of job, lead, not_hiring, no_fit/);
  assert.equal(runJobs(home, ['posts', 'drop', 'x']).code, 2, 'J posts drop is gone');
});

test('outcomes are recorded in the same write as the postings; not_hiring and no_fit are counted in the report', async () => {
  seed();
  const f = fakeFetch({ 'https://boards-api.greenhouse.io/v1/boards/acme/': { jobs: [{ id: 77, title: 'Backend Engineer', company_name: 'Acme', location: { name: 'Berlin' }, first_published: '2026-11-20T00:00:00Z', content: '' }] } });
  const posting = { title: 'Backend Engineer', employer: 'Acme', city: 'Berlin', region: '', country: 'DE', remote: false, postedAt: null, employmentType: '', salary: null, applyLinks: [{ url: 'https://boards.greenhouse.io/acme/jobs/77', publisher: '' }], description: 'x', sourceUrl: 'https://x.com/bo/status/222' };
  const r = await run(file({ postings: [posting], outcomes: [{ url: posts()[1].url, outcome: 'job' }, { url: posts()[4].url, outcome: 'not_hiring' }, { url: posts()[3].url, outcome: 'no_fit', reason: 'onsite only' }, { url: posts()[0].url, outcome: 'no_fit' }, { url: posts()[2].url, outcome: 'no_fit' }] }), f);
  assert.equal(r.added, 1);
  const s = store.loadState();
  assert.equal(s.posts.length, 0);
  assert.deepEqual(s.postOutcomes, { job: 1, not_hiring: 1, no_fit: 3 });
  assert.match(report.renderReport(s, empty, { now: NOW }), /Hiring posts set aside: 1 not hiring, 3 no fit\./);
  seed();
  assert.match((await run(file({ postings: [], outcomes: posts().map((p, i) => ({ url: p.url, outcome: i === 1 ? 'job' : 'no_fit' })) }))).held[0], /marked job but has no posting/);
});

test('a lead keeps the X handle from the post record, an HN email only word for word, and is stored once per post', async () => {
  seed();
  const outcomes = posts().map((p, i) => ({ url: p.url, outcome: i === 0 || i === 2 ? 'lead' : 'not_hiring', employer: i === 2 ? 'Initech' : '', role: i === 0 ? 'platform engineer' : i === 2 ? 'Software Engineer' : '' }));
  // a handle the post record does not have is refused
  const bad = await run(file({ outcomes, leads: [{ url: posts()[0].url, handle: 'someone_else' }, { url: posts()[2].url, email: 'jobs@initech.test' }] }));
  assert.match(bad.held[0], /handle must be the post's author from the record/);
  const wrongEmail = await run(file({ outcomes, leads: [{ url: posts()[0].url }, { url: posts()[2].url, email: 'attacker@evil.test' }] }));
  assert.match(wrongEmail.held[0], /not word for word in the post/);
  const noWay = await run(file({ outcomes: posts().map((p, i) => ({ url: p.url, outcome: i === 3 ? 'lead' : 'no_fit' })), leads: [{ url: posts()[3].url }] }));
  assert.match(noWay.held[0], /needs an email or a handle that appears in it/);
  assert.equal(store.loadState().posts.length, 5, 'nothing was recorded by the refused files');
  const ok = await run(file({ outcomes, leads: [{ url: posts()[0].url }, { url: posts()[2].url, email: 'jobs@initech.test' }] }));
  assert.equal(ok.held.length, 0);
  const leads = store.loadState().leads;
  assert.deepEqual(leads.map((l) => [l.key, l.channel, l.handle || l.email, l.status]), [['x:111', 'x', 'ada_dev', 'new'], ['hn:333', 'email', 'jobs@initech.test', 'new']]);
  // one lead per post: the same post again, on the other host, is not added twice
  seed();
  store.updateState((s) => { s.leads = leads; s.posts = [{ ...posts()[0], url: 'https://twitter.com/ada_dev/status/111' }]; });
  await run(file({ batch: ['https://twitter.com/ada_dev/status/111'], outcomes: [{ url: 'https://twitter.com/ada_dev/status/111', outcome: 'lead' }], leads: [{ url: 'https://twitter.com/ada_dev/status/111' }] }));
  assert.equal(store.loadState().leads.length, 2);
  assert.equal(ing.leadKey('https://twitter.com/ada_dev/status/111'), ing.leadKey('https://x.com/other/status/111'));
});

test('the intros for a round\'s new leads come from one writer call, fit their channel, and are never sent or gated', async () => {
  seed();
  const outcomes = posts().map((p, i) => ({ url: p.url, outcome: i === 0 || i === 2 ? 'lead' : 'not_hiring' }));
  await run(file({ outcomes, leads: [{ url: posts()[0].url }, { url: posts()[2].url, email: 'jobs@initech.test' }] }));
  runJobs(home, ['profile', 'set', JSON.stringify({ facts: { first_name: 'Ada' }, resumeText: 'Ada builds compilers.' })]);
  const req = runJobs(home, ['write-prompt', '--leads', 'x']).json;
  assert.equal(req.model, 'opus');
  assert.match(req.prompt, /under 300 characters/);
  assert.match(req.prompt, /"channel":"x"/);
  assert.match(req.prompt, /"channel":"email"/);
  const result = path.join(home, 'lead-intros.json');
  fs.writeFileSync(result, JSON.stringify({ 'https://x.com/ada_dev/status/111': { text: 'Hi, I build compilers and your platform role fits.' }, 'hn:333': { subject: 'Software Engineer', text: 'Hello, a short note about the role.' } }));
  assert.equal(runJobs(home, ['leads', 'save', '--result', result]).json.saved, 2);
  const s = store.loadState();
  assert.ok(s.leads.every((l) => l.intro && l.intro.text));
  fs.writeFileSync(result, JSON.stringify({ 'https://x.com/ada_dev/status/111': { text: 'x'.repeat(301) } }));
  assert.notEqual(runJobs(home, ['leads', 'save', '--result', result]).code, 0, 'too long for an X DM');
  const text = report.renderReport(store.loadState(), empty, { now: NOW });
  assert.match(text, /## People hiring \(2\)/);
  assert.match(text, /ada_dev.*Intro to copy \(x\)\. Open https:\/\/x\.com\/ada_dev, press Message, paste, and send it yourself: Hi, I build compilers/);
  assert.equal(store.loadState().held.length, 0, 'no writing_needs_yes, no consent gate');
  assert.equal(store.loadState().leads.filter((l) => l.status === 'new').length, 2);
  // not counted in period_max, which counts applications
  assert.equal(work.buildWorkList(store.loadState(), rule('period_max', 1), NOW, {}).items.filter((i) => i.reason === 'apply_ready').length, 0);
});

test('a lead joins a job when employer and role later match exactly one job, and done or not interested is never shown again', async () => {
  seed();
  await run(file({ outcomes: posts().map((p, i) => ({ url: p.url, outcome: i === 0 ? 'lead' : 'no_fit', employer: 'Acme', role: 'Platform Engineer', place: 'Berlin' })), leads: [{ url: posts()[0].url }] }));
  assert.equal(store.loadState().leads[0].joinedJob, null);
  const j = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/88', company: 'Acme, Inc.', title: 'Platform Engineer', city: 'Berlin', status: 'reviewed' });
  store.updateState((s) => { s.jobs[j.key] = j; s.leads[0].intro = { channel: 'x', subject: null, text: 'Hi', writtenAt: 'x' }; ing.joinLeads(s); });
  const s = store.loadState();
  assert.equal(s.leads[0].joinedJob, j.key);
  assert.deepEqual(s.contacts[j.key].map((c) => [c.name, c.channel, c.intro.text]), [['ada_dev', 'x', 'Hi']]);
  assert.doesNotMatch(report.renderReport(s, empty, { now: NOW }), /People hiring/, 'a joined lead is a contact on the job');
  // two matching jobs: no join
  seed();
  await run(file({ outcomes: posts().map((p, i) => ({ url: p.url, outcome: i === 0 ? 'lead' : 'no_fit', employer: 'Acme', role: 'Platform Engineer', place: 'Berlin' })), leads: [{ url: posts()[0].url }] }));
  const a = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/1', company: 'Acme', title: 'Platform Engineer', city: 'Berlin' });
  const b = mkJob({ key: 'https://jobs.lever.co/acme/2', company: 'Acme', title: 'Platform Engineer', city: 'Berlin' });
  store.updateState((st) => { st.jobs[a.key] = a; st.jobs[b.key] = b; ing.joinLeads(st); });
  assert.equal(store.loadState().leads[0].joinedJob, null);
  // done and not interested stay as dedupe keys and are never shown again
  for (const state of ['done', 'not_interested']) {
    assert.equal(runJobs(home, ['leads', 'mark', 'https://x.com/ada_dev/status/111', state]).code, 0);
    assert.doesNotMatch(report.renderReport(store.loadState(), empty, { now: NOW }), /People hiring/);
    assert.equal(store.loadState().leads.length, 1, 'kept as a dedupe key');
  }
  assert.equal(runJobs(home, ['leads', 'mark', 'https://x.com/ada_dev/status/111', 'later']).code, 2);
});
