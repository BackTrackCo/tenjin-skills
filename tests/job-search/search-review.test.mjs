import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fakeFetch, fixture, mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const dedupe = await import(`${S}dedupe.mjs`);
const ing = await import(`${S}ingest.mjs`);
const emp = await import(`${S}employer.mjs`);
const verify = await import(`${S}verify.mjs`);
const hn = await import(`${S}hn.mjs`);
const net = await import(`${S}net.mjs`);
const plat = await import(`${S}platforms.mjs`);
const open = await import(`${S}open.mjs`);
const resume = await import(`${S}resume.mjs`);
const sweep = await import(`${S}sweep.mjs`);
const routed = await import(`${S}routed.mjs`);
const router = await import(`${S}router.mjs`);
const work = await import(`${S}work.mjs`);

const NOW = Date.parse('2026-11-24T20:00:00Z');
const empty = { rules: [], lessons: [] };
const reset = (jobs = []) => store.updateState((s) => { Object.assign(s, store.emptyState()); for (const j of jobs) s.jobs[j.key] = j; });
const GH = 'https://boards-api.greenhouse.io/v1/boards';
const ghBoard = (name, jobs, place = 'Berlin, Germany') => ({ jobs: jobs.map((j) => ({ id: j.id, title: j.title, company_name: name, location: { name: place }, first_published: '2026-11-20T00:00:00Z', content: '' })) });
const posting = (over = {}) => ({ title: 'Software Engineer', employer: 'Acme', employerWebsite: 'acme.test', city: 'Berlin', region: '', country: '', remote: false, employmentType: '', postedAt: new Date(NOW - 86400000).toISOString().slice(0, 10), salary: null, applyLinks: [{ url: 'https://www.example-jobs.test/view/1', publisher: 'X' }], description: 'x', sourceUrl: 'https://www.example-jobs.test/view/1', ...over });
const doc = (postings) => ({ need: 'job_postings', status: 'fulfilled', query: { role: 'software engineer', place: 'Berlin', remote: false, since: null }, postings });
const profile = { places: ['Berlin'], includeOld: true, search: { role: 'software engineer', place: 'Berlin' } };
const ingest = (obj, extra = {}) => ing.ingest({ obj, state: store.loadState(), profile, overlay: empty, fetch: fakeFetch({}), now: NOW, ...extra });

// ---- 5 ------------------------------------------------------------------------------------------------------------
test('5: a link with no scheme is refused with its reason, never thrown on; a paid round whose ingest fails is not due again', async () => {
  reset();
  const r = await ingest(doc([posting({ applyLinks: [{ url: 'acme.com/jobs/1', publisher: 'X' }] })]));
  assert.match(r.held[0], /every apply link must start with http:\/\/ or https:\/\//);
  assert.equal(dedupe.normalizeUrl('acme.com/jobs/1'), 'acme.com/jobs/1', 'normalizing a bare link does not throw');
  assert.doesNotThrow(() => dedupe.mergeJobs(store.loadState(), [{ url: '/viewjob?jk=1', title: 'T', company: 'C', place: 'x' }], new Date(NOW).toISOString()));
});

// ---- 6 ------------------------------------------------------------------------------------------------------------
test('6: a board linked from a page that is not the employer\'s, and named for another company, is not confirmed', async () => {
  const p = { title: 'Software Engineer', employer: 'Acme', city: 'Berlin', remote: false, postedAt: '2026-11-20T00:00:00Z' };
  const other = emp.careersFromLinks({ careersUrl: 'https://some-aggregator.example/acme', boardLinks: ['https://boards.greenhouse.io/othercorp/jobs/999'] });
  const f = fakeFetch({ [`${GH}/othercorp/`]: ghBoard('OtherCorp', [{ id: 999, title: 'Software Engineer' }]) });
  const r = await emp.resolveFromCareersPage(p, other, { fetch: f, now: NOW, website: 'acme.test' });
  assert.equal(r.match, undefined);
  assert.equal(r.reason, 'unconfirmed_board');
  // linked from the employer's own page it counts; so does a board named like the employer
  const own = emp.careersFromLinks({ careersUrl: 'https://careers.acme.test/jobs', boardLinks: ['https://boards.greenhouse.io/othercorp/jobs/999'] });
  assert.equal((await emp.resolveFromCareersPage(p, own, { fetch: f, now: NOW, website: 'acme.test' })).match.employerPosting.confidence, 'confirmed');
  const named = emp.careersFromLinks({ careersUrl: 'https://x.example/', boardLinks: ['https://boards.greenhouse.io/acme/jobs/5'] });
  const f2 = fakeFetch({ [`${GH}/acme/`]: ghBoard('Acme', [{ id: 5, title: 'Software Engineer' }]) });
  assert.ok((await emp.resolveFromCareersPage(p, named, { fetch: f2, now: NOW, website: 'acme.test' })).match);
});

// ---- 7 ------------------------------------------------------------------------------------------------------------
test('7: a careers lookup is tried once per job, whatever its answer', () => {
  const j = mkJob({ key: 'https://www.example-jobs.test/view/7', status: 'reviewed', employerPosting: null, openConfirmed: false, unresolved: 'no_board', company: 'Co7', employerWebsite: 'co7.test' });
  reset([j]);
  const needs = () => routed.jobNeeds(store.loadState(), profile, empty, { kinds: ['careers_page'] });
  assert.equal(needs().length, 1);
  store.updateState((s) => { (s.jobs[j.key].routedTried ||= {}).careers_page = true; });
  assert.equal(needs().length, 0);
});

// ---- 19 -----------------------------------------------------------------------------------------------------------
test('19: a repeat posting keeps the employer posting its careers page confirmed', () => {
  const key = 'https://www.example-jobs.test/view/19';
  const state = store.emptyState();
  const base = { url: key, title: 'Software Engineer', company: 'Acme', city: 'Berlin', place: 'Berlin|', employerPosting: null, applyLinks: [key] };
  dedupe.mergeJobs(state, [base], new Date(NOW).toISOString());
  const ep = { url: 'https://careers.acme.test/jobs/1', system: 'employer_site', token: null, jobId: null, source: 'careers_page', confidence: 'confirmed' };
  Object.assign(state.jobs[key], { employerPosting: ep, openConfirmed: true, employerWebsite: 'acme.test', applyLinks: [ep.url] });
  dedupe.mergeJobs(state, [{ ...base, employerPosting: null, openConfirmed: false }], new Date(NOW + 1000).toISOString());
  assert.deepEqual(state.jobs[key].employerPosting, ep);
  assert.equal(state.jobs[key].openConfirmed, true);
  assert.deepEqual(state.jobs[key].applyLinks, [ep.url]);
  assert.equal(state.jobs[key].employerWebsite, 'acme.test');
});

// ---- 20 -----------------------------------------------------------------------------------------------------------
test('20: different jobs that share a link are separate records', () => {
  const state = store.emptyState();
  const at = new Date(NOW).toISOString();
  const a = { url: 'hn:123', title: 'Backend Engineer', company: 'Acme', place: '|' };
  const b = { url: 'hn:123', title: 'Designer', company: 'Acme', place: '|' };
  dedupe.mergeJobs(state, [a, b], at);
  assert.equal(Object.keys(state.jobs).length, 2);
  state.jobs['hn:123'].status = 'reviewed';
  state.jobs['hn:123'].fit = 80;
  dedupe.mergeJobs(state, [{ url: 'https://acme.test/apply', title: 'Role One', company: 'Acme', place: 'x' }, { url: 'https://acme.test/apply', title: 'Role Two', company: 'Acme', place: 'x' }], at);
  assert.equal(Object.keys(state.jobs).length, 4);
  assert.equal(state.jobs['hn:123'].title, 'Backend Engineer', 'a reviewed record keeps its own title');
  assert.notEqual(dedupe.normalizeUrl('https://acme.test/?gh_jid=111'), dedupe.normalizeUrl('https://acme.test/?gh_jid=222'));
});

// ---- 21 -----------------------------------------------------------------------------------------------------------
test('21: a sweep does not close a job its own board still lists, and the board copy is not added again', async () => {
  const ep = { url: 'https://boards.greenhouse.io/acme/jobs/55', system: 'greenhouse', token: 'acme', jobId: '55', source: 'careers_page', confidence: 'confirmed' };
  const j = mkJob({ key: 'https://www.linkedin.com/jobs/view/9', status: 'shortlisted', employerPosting: ep, board: 'greenhouse:acme', title: 'Software Engineer', company: 'Acme', city: 'Berlin', place: 'Berlin|', ats: 'greenhouse' });
  reset([j]);
  const f = fakeFetch({ [`${GH}/acme/`]: ghBoard('Acme', [{ id: 55, title: 'Software Engineer' }]) });
  const payload = await sweep.runSweep({ state: store.loadState(), profile: { ...profile, watch: [{ url: 'https://boards.greenhouse.io/acme' }] }, overlay: empty, fetch: f, now: NOW });
  assert.deepEqual(payload.closedKeys, []);
  sweep.persist(payload);
  assert.equal(store.loadState().jobs[j.key].status, 'shortlisted');
  assert.equal(Object.keys(store.loadState().jobs).length, 1, 'the board copy joins the record it belongs to');
});

// ---- 22 -----------------------------------------------------------------------------------------------------------
test('22: a different opening on the same board, and a repost after a close, are separate jobs', () => {
  const state = store.emptyState();
  const at = new Date(NOW).toISOString();
  const mk = (id) => ({ url: `https://boards.greenhouse.io/acme/jobs/${id}`, title: 'Software Engineer', company: 'Acme', city: 'Berlin', place: 'Berlin|', ats: 'greenhouse', board: 'greenhouse:acme', sourceId: String(id) });
  dedupe.mergeJobs(state, [mk(1), mk(2)], at);
  assert.equal(Object.keys(state.jobs).length, 2, 'two openings, one title');
  delete state.jobs[mk(2).url];
  state.jobs[mk(1).url].status = 'closed';
  const added = dedupe.mergeJobs(state, [{ ...mk(3), board: null, ats: null, sourceId: undefined, url: 'https://www.example-jobs.test/repost' }], at);
  assert.equal(added.length, 1, 'a repost after a close is new');
});

// ---- 23 -----------------------------------------------------------------------------------------------------------
test('23: a post with several board links becomes one job per link', async () => {
  reset();
  const links = [1, 2, 3].map((n) => `https://boards.greenhouse.io/acme/jobs/${n}`);
  const f = fakeFetch({ [`${GH}/acme/`]: ghBoard('Acme', [1, 2, 3].map((id) => ({ id, title: `Software Engineer ${id}` }))) });
  const obj = { need: 'x_hiring_posts', status: 'fulfilled', query: { role: 'e', place: '', remote: false, since: null }, posts: [{ url: 'https://x.com/a/status/1', author: 'a', postedAt: null, text: `hiring ${links.join(' ')}`, links }] };
  const r = await ing.ingest({ obj, state: store.loadState(), profile, overlay: empty, fetch: f, now: NOW });
  assert.equal(r.added, 3);
});

// ---- 24 -----------------------------------------------------------------------------------------------------------
test('24: the routed date window follows windowDays and the routed clock, not the board sweep', async () => {
  reset();
  store.updateState((s) => { s.sweep.lastAt = new Date(NOW - 3600000).toISOString(); });
  const old = posting({ postedAt: new Date(NOW - 4 * 86400000).toISOString().slice(0, 10) });
  const r = await ing.ingest({ obj: doc([old]), state: store.loadState(), profile: { ...profile, includeOld: false, windowDays: 30 }, overlay: empty, fetch: fakeFetch({}), now: NOW });
  assert.equal(r.added, 1);
  assert.equal(r.dropped, 0);
});

// ---- 25 -----------------------------------------------------------------------------------------------------------
test('25: a Hacker News job is not dropped for the age of its comment', async () => {
  reset();
  const old = posting({ postedAt: new Date(NOW - 20 * 86400000).toISOString().slice(0, 10), sourceUrl: 'hn:77', applyLinks: [] });
  const r = await ing.ingest({ obj: { need: 'hn_hiring_posts', status: 'fulfilled', query: { role: 'software engineer', place: 'Berlin', remote: false, since: null }, postings: [old] }, state: store.loadState(), profile: { ...profile, includeOld: false }, overlay: empty, fetch: fakeFetch({}), now: NOW });
  assert.equal(r.dropped, 0);
  assert.equal(r.added, 1);
});

// ---- 26, 27, 28 ---------------------------------------------------------------------------------------------------
test('26: the place filter runs from search.place and drops a job in another place', () => {
  const p = { search: { role: 'software engineer', place: 'Berlin' } };
  const job = (city, remote = false) => mkJob({ title: 'Software Engineer', city, region: '', country: '', remote });
  assert.deepEqual(verify.screenJob(job('Tokyo'), p, empty, NOW).drop, ['outside_place']);
  assert.deepEqual(verify.screenJob(job('Berlin'), p, empty, NOW).drop, []);
  assert.deepEqual(verify.screenJob(job('Tokyo', true), { ...p, remote: true }, empty, NOW).drop, [], 'remote is kept when the person wants it');
  assert.deepEqual(verify.screenJob(job('Tokyo', true), { search: { ...p.search, remote: true } }, empty, NOW).drop, []);
});

test('27: the Hacker News prefilter matches the city, not the whole place string', () => {
  const prof = (place) => ({ search: { role: 'software engineer', place } });
  assert.equal(hn.keepPost('Acme | Software Engineer | San Francisco | onsite', prof('San Francisco, CA')), true);
  assert.equal(hn.keepPost('Acme | software engineer | New York, NY', prof('New York City')), true);
  assert.equal(hn.keepPost('Acme | software engineer | Paris', prof('New York City')), false);
});

test('28: the role filter matches whole words, short words count, and a level word never decides', () => {
  const t = (title, role, extra = {}) => verify.titleMatchesRole(title, { search: { role, ...extra } });
  assert.equal(t('QA Analyst', 'QA'), true);
  assert.equal(t('Accountant', 'QA'), false);
  assert.equal(t('PM, Growth', 'PM'), true);
  assert.equal(t('Senior Accountant', 'Senior Software Engineer'), false);
  assert.equal(t('Director, People Partners - Product, Design & Engineering', 'Software Engineer'), false, 'Engineering is not engineer');
  assert.equal(t('Manager, Recruiting - Engineering', 'Software Engineer'), false);
  assert.equal(t('Software Engineer, Platform', 'Software Engineer'), true);
  assert.equal(t('HTML Coder', 'ML Engineer'), false);
});

// ---- 29 -----------------------------------------------------------------------------------------------------------
test('29: J search plan starts again at round 0 once a session has finished', () => {
  reset();
  runJobs(home, ['profile', 'set', JSON.stringify({ search: { role: 'software engineer', place: 'Berlin', variants: ['developer'] } })]);
  store.updateState((s) => { s.search.session = { startedAt: new Date(NOW).toISOString(), round: 1, roundAdded: 0, finished: true }; });
  const r = runJobs(home, ['search', 'plan']);
  assert.equal(r.json.query ? r.json.query.round : r.json.round, 0, r.stdout);
});

// ---- 30, 46 -------------------------------------------------------------------------------------------------------
test('30: a trailing-dot host does not get past the never-automated list or the fixed host list', async () => {
  assert.equal(plat.isNeverAutomated('https://www.linkedin.com./in/x'), true);
  assert.equal(plat.jobSiteOf('https://www.linkedin.com./jobs/view/1'), 'LinkedIn');
  assert.equal(resume.isLinkedIn('https://www.linkedin.com./in/x'), true);
  assert.throws(() => net.assertAllowed('https://www.linkedin.com./in/x'), /never-automated host refused/);
  assert.throws(() => net.assertAllowed('https://api.lever.co./v0/postings/x'), /host not allowed/);
  assert.throws(() => net.assertAllowed('https://boards-api.greenhouse.io./v1/boards/x/jobs'), /host not allowed/);
  await assert.rejects(net.guardedFetch('https://www.linkedin.com./in/x', {}, async () => ({})), /never-automated/);
});

test('46: J open refuses localhost with a dot, a name that carries a private address, and passes the parsed link', () => {
  for (const bad of ['https://localhost./', 'https://foo.localhost./', 'https://127.0.0.1.nip.io/', 'https://10-0-0-5.sslip.io/']) assert.ok(open.checkOpenUrl(bad), bad);
  assert.equal(open.checkOpenUrl('https://www.example.com/jobs/1'), null);
  const calls = [];
  open.openPage('https://Example.com:443/a b?x=1', { spawn: (bin, args) => { calls.push(args); return { status: 0 }; }, platform: 'darwin', env: {} });
  assert.equal(calls[0].at(-1), new URL('https://Example.com:443/a b?x=1').href);
});

// ---- 50 -----------------------------------------------------------------------------------------------------------
test('50: a fetch has a time limit, and a resume page or file passes only up to its size', async () => {
  let seen;
  await net.guardedFetch('https://boards-api.greenhouse.io/v1/boards/x/jobs', {}, async (u, o) => { seen = o; return {}; });
  assert.ok(seen.signal, 'a time limit');
  assert.equal(seen.redirect, 'manual', '54: no redirect is followed on the fixed hosts');
  const big = { arrayBuffer: async () => new ArrayBuffer(3 * 1024 * 1024) };
  assert.equal(await resume.readCapped(big, 1024), null);
  const stream = { body: { getReader: () => { let n = 0; return { read: async () => (n++ < 5 ? { done: false, value: new Uint8Array(1024) } : { done: true }), cancel: async () => { stream.cancelled = true; } }; } } };
  assert.equal(await resume.readCapped(stream, 2048), null);
  assert.equal(stream.cancelled, true, 'the stream is stopped once it passes the limit');
  assert.equal((await resume.readCapped({ arrayBuffer: async () => new Uint8Array([104, 105]).buffer }, 1024)).toString(), 'hi');
});

// ---- 51, 52 -------------------------------------------------------------------------------------------------------
test('51: empty entries are refused with what to rewrite, never a raw TypeError', async () => {
  reset();
  for (const bad of [
    { need: 'web_search', status: 'fulfilled', query: { role: 'e', place: '', remote: false, since: null }, raw: [{ query: 'q', results: [null] }] },
    { need: 'web_search', status: 'fulfilled', query: { role: 'e', place: '', remote: false, since: null }, results: 5 },
    doc([null]),
    { need: 'x_hiring_posts', status: 'fulfilled', query: { role: 'e', place: '', remote: false, since: null }, posts: [null] },
  ]) {
    const r = await ingest(bad);
    assert.ok(r.held.length === 1 && /must|list|rewrite/.test(r.held[0]), JSON.stringify(r.held));
  }
});

test('52: a job key of __proto__ is an unknown job', async () => {
  reset();
  const r = await ingest({ need: 'people_search', status: 'fulfilled', query: { role: 'e', place: '', remote: false, since: null }, jobKey: '__proto__', contacts: [] });
  assert.match(r.held[0], /unknown job __proto__/);
});

// ---- 53 -----------------------------------------------------------------------------------------------------------
test('53: J profile set takes an object only', () => {
  const r = runJobs(home, ['profile', 'set', '"abc"']);
  assert.equal(r.code, 2);
  assert.match(r.json.error, /JSON object/);
  assert.equal(runJobs(home, ['profile', 'set', '[1]']).code, 2);
});

// ---- 55 -----------------------------------------------------------------------------------------------------------
test('55: the dead state is gone', () => {
  const s = store.emptyState();
  assert.equal(s.dedupe, undefined);
  assert.equal(s.search.webPending, undefined);
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'scripts', 'lib', 'work.mjs'), 'utf8');
  assert.doesNotMatch(src, /web_search_due|webPending/);
});

// ---- 5, through the router --------------------------------------------------------------------------------------------
const FAKE = path.join(import.meta.dirname, 'helpers', 'fake-tenjin.mjs');
const FX = Object.fromEntries(['job-postings', 'x-posts', 'exa-search'].map((n) => [n, fixture(`router/${n}.json`)]));
function fake(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faketenjin-'));
  const sf = path.join(dir, 'script.json');
  fs.writeFileSync(sf, JSON.stringify(script));
  const bin = path.join(dir, 'tenjin');
  fs.writeFileSync(bin, `#!/bin/sh\nFAKE_SCRIPT="${sf}" FAKE_LOG="${path.join(dir, 'log.jsonl')}" exec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  return { bin };
}
test('5: a paid result with a bad link is held with its reason and the round is not due again', async () => {
  reset();
  const J = FX['job-postings'];
  const bad = JSON.stringify(J.step2.envelope.result).replace(/"(job_apply_link|apply_link)":"https?:\/\//g, '"$1":"');
  const jrun = { ...J.step2.envelope, result: bad };
  const unknown = { ...FX['x-posts'].step1.json, __text: 'Request: GET https://unknown-seller.example/search\n' };
  const sp = (n) => ({ ...FX[n].step1.json, __text: FX[n].step1.text });
  const f = fake({ answers: [{ ...J.step1.json, __text: J.step1.text }, jrun, unknown, sp('exa-search'), { ...FX['exa-search'].step2.envelope, result: JSON.stringify(FX['exa-search'].step2.envelope.result) }] });
  const prof = { places: ['New York'], includeOld: true, search: { role: 'software engineer', place: 'New York City' } };
  const client = new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 300 } });
  const log = await routed.routedRounds({ profile: prof, fetch: fakeFetch({}), client, now: NOW });
  assert.ok(log.some((l) => l.need === 'job_postings'), 'the paid need was ingested or held, never thrown');
  const s = store.loadState();
  assert.ok(s.routed.lastSearchAt, 'the round is marked done');
  assert.equal(work.searchRound(s, prof, NOW + 60000), null, 'not due again a minute later');
  assert.ok(s.held.some((h) => /routed:job_postings: posting \d+: every apply link must start with http/.test(h.detail)));
});
