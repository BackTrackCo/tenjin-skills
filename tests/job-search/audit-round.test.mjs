import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fakeFetch, fixture, mkJob, runJobs, tmpHome, noReferrals } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const work = await import(`${S}work.mjs`);
const watcher = await import(`${S}watcher.mjs`);
const lease = await import('../../skills/loop-base/lib/lease.mjs');
const report = await import(`${S}report.mjs`);
const routed = await import(`${S}routed.mjs`);
const router = await import(`${S}router.mjs`);
const ing = await import(`${S}ingest.mjs`);
const prep = await import(`${S}prepare.mjs`);
const writing = await import(`${S}writing.mjs`);
const web = await import(`${S}websearch.mjs`);
const post = await import(`${S}postinfo.mjs`);
const { buildSheet } = await import(`${S}sheet.mjs`);

const NOW = Date.parse('2026-11-24T20:00:00Z');
const empty = { rules: [], lessons: [] };
const FAKE = path.join(import.meta.dirname, 'helpers', 'fake-tenjin.mjs');
const FX = Object.fromEntries(['job-postings', 'x-posts', 'exa-search'].map((n) => [n, fixture(`router/${n}.json`)]));
const reset = (jobs = [], extra = {}) => {
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'rules.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState(), extra); for (const j of jobs) s.jobs[j.key] = j; });
  noReferrals();
};
const arm = () => lease.claimLease({ holder: 'w', now: NOW });
const tick = async (at, ctx = {}) => (await watcher.tick({ holder: 'w', now: at, seen: { sig: null }, ...ctx })).lines;
function fake(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faketenjin-'));
  const sf = path.join(dir, 'script.json');
  const lf = path.join(dir, 'log.jsonl');
  fs.writeFileSync(sf, JSON.stringify(script));
  const bin = path.join(dir, 'tenjin');
  fs.writeFileSync(bin, `#!/bin/sh\nFAKE_SCRIPT="${sf}" FAKE_LOG="${lf}" exec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  return { bin, log: () => (fs.existsSync(lf) ? fs.readFileSync(lf, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}
const client = (f) => new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 300 } });
const sp = (name) => ({ ...FX[name].step1.json, __text: FX[name].step1.text });
const noPosting = (i, over = {}) => mkJob({ key: `https://www.example-jobs.test/view/${i}`, status: 'reviewed', employerPosting: null, openConfirmed: false, unresolved: 'no_board', company: `Co${i}`, title: `Engineer ${i}`, employerWebsite: `co${i}.test`, v: 1, ...over });

// ---- item 2: per need, no all-or-nothing --------------------------------------------------
test('routed needs run one by one: a need with an unknown supplier becomes one Haiku item, the others still run', async () => {
  reset();
  const J = FX['job-postings'];
  const jrun = { ...J.step2.envelope, result: JSON.stringify(J.step2.envelope.result) };
  const unknown = { ...FX['x-posts'].step1.json, __text: 'Request: GET https://unknown-seller.example/search\n' };
  const f = fake({ answers: [{ ...J.step1.json, __text: J.step1.text }, jrun, unknown, sp('exa-search'), { ...FX['exa-search'].step2.envelope, result: JSON.stringify(FX['exa-search'].step2.envelope.result) }] });
  const prof = { places: ['New York'], includeOld: true, search: { role: 'software engineer', place: 'New York City' } };
  const log = await routed.routedRounds({ profile: prof, fetch: fakeFetch({}), client: client(f), now: NOW });
  assert.ok(log.some((l) => l.need === 'job_postings' && l.ok), 'the covered need ran');
  assert.ok(log.some((l) => l.need === 'x_hiring_posts' && l.status === 'model'), 'the uncovered need is left for the model');
  const s = store.loadState();
  assert.equal(s.held.some((h) => h.detail.includes('x_hiring_posts')), false, 'not a hold');
  assert.equal(f.log().filter((l) => l.call).length, 5, 'no payment step for the unknown supplier');
  const wl = work.buildWorkList(s, empty, NOW, prof);
  const item = wl.items.find((i) => i.reason === 'need_due');
  assert.equal(item.key, 'need:x_hiring_posts');
  assert.ok(!wl.items.some((i) => i.reason === 'web_search_due'), 'with Tenjin the web search is never a model item');
  assert.ok(s.held.filter((h) => h.detail.startsWith('routed:web_search')).every((h) => /board .* unavailable/.test(h.detail)), 'the board search ran by tool id; only a board lookup may hold it');
  assert.deepEqual(f.log().filter((l) => l.call).map((l) => l.call).filter((c) => c.tool), [{ tool: 'exa-search' }], 'the board search asks the catalog tool by id, never a {query}');
  // the item closes with its outcome command, and a left one comes back at the next period
  assert.equal(runJobs(home, ['search', 'done', 'x_hiring_posts']).code, 0);
  assert.equal(store.loadState().search.needPending.length, 0);
});

// ---- items 3 and 4: one wake per round, the notify line -------------------------------------
const waiting = (i) => mkJob({ key: `https://boards.greenhouse.io/acme/jobs/9${i}`, status: 'apply_ready', company: `Wait${i}`, sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [] }, v: 1 });

test('a notify-only wake comes at most once per round, only for a changed waiting set, and the line waits otherwise', async () => {
  reset([waiting(1)], { sweep: { lastAt: '2026-11-24T07:00:00Z' }, start: { remoteControl: 'now' } });
  await arm();
  const first = await tick(NOW + 1000);
  assert.equal(first.length, 1);
  assert.match(first[0], /notify: 1 application waits for your yes/);
  // the same round: a changed waiting set waits for the next round
  store.updateState((s) => { const j = waiting(2); s.jobs[j.key] = j; });
  assert.deepEqual(await tick(NOW + 2000), [], 'one notify-only wake per round');
  // the next round ends: the changed set wakes once
  store.updateState((s) => { s.sweep.lastAt = '2026-11-25T07:00:00Z'; });
  const next = await tick(NOW + 3000);
  assert.equal(next.length, 1);
  assert.match(next[0], /2 applications wait/);
  // a set that only shrinks sends nothing
  store.updateState((s) => { delete s.jobs[Object.keys(s.jobs)[0]]; s.sweep.lastAt = '2026-11-26T07:00:00Z'; });
  assert.deepEqual(await tick(NOW + 4000), []);
});

test('after a push that came back "not sent" there is no notify-only wake until the person\'s next turn; the line rides the next actionable wake', async () => {
  reset([waiting(1)], { sweep: { lastAt: '2026-11-24T07:00:00Z' } });
  await arm();
  assert.equal((await tick(NOW + 1000)).length, 1, 'the first notify-only wake');
  assert.equal(runJobs(home, ['notify', 'result', 'not_sent']).code, 0);
  store.updateState((s) => { const j = waiting(2); s.jobs[j.key] = j; s.sweep.lastAt = '2026-11-25T07:00:00Z'; });
  assert.deepEqual(await tick(NOW + 2000), [], 'no more notify-only wakes after "not sent"');
  runJobs(home, ['fact', 'set', 'phone', '+49 151 0000001']);
  assert.equal(store.loadState().watcher.notifyResult, null, 'the person\'s next turn lifts the stop');
  runJobs(home, ['notify', 'result', 'not_sent']);
  store.updateState((s) => { const j = noPosting(5); s.jobs[j.key] = j; });
  const wake = await tick(NOW + 3000);
  assert.equal(wake.length, 1);
  assert.match(wake[0], /1 employer_page; notify: 2 applications wait/, 'the line rides an actionable wake');
});

test('an answer that cannot tell sent from not sent allows notify-only wakes only for items that block work', async () => {
  reset([waiting(1)], { sweep: { lastAt: '2026-11-24T07:00:00Z' }, watcher: { sent: [], fingerprint: null, notify: null, notifyResult: 'unknown' } });
  await arm();
  assert.deepEqual(await tick(NOW + 1000), [], 'a count of sheets waiting for a yes is not a blocker');
  store.updateState((s) => { s.sweep.lastAt = '2026-11-25T07:00:00Z'; s.held.push({ reason: 'chrome_disconnected', detail: 'Acme' }); });
  const l = await tick(NOW + 2000);
  assert.equal(l.length, 1);
  assert.match(l[0], /needs you: Claude in Chrome lost its connection/);
});

test('an actionable wake carries the line in the same round, and the same due set is never sent twice', async () => {
  reset([waiting(1), noPosting(1)], { start: { remoteControl: 'now' } });
  await arm();
  const l = await tick(NOW + 1000);
  assert.equal(l.length, 1);
  assert.match(l[0], /employer_page; notify:/);
  assert.deepEqual(await tick(NOW + 2000), []);
});

test('no wake while code is still reading in the round (Hacker News in chunks); the wake comes when the round ends', async () => {
  const AL = 'https://hn.algolia.com/api/v1';
  const FB = 'https://hacker-news.firebaseio.com/v0';
  const items = fixture('hn-job-items.json');
  const mk = () => async (url) => {
    const respond = (v) => ({ ok: true, status: 200, json: async () => v });
    if (url.startsWith(`${AL}/search_by_date?`)) return respond(fixture('algolia-thread.json'));
    if (url.startsWith(`${AL}/search?`)) return respond({ hits: [] });
    if (url === `${FB}/jobstories.json`) return respond(fixture('hn-jobstories.json'));
    const m = /\/item\/(\d+)\.json$/.exec(url);
    if (m && items[m[1]]) return respond(items[m[1]]);
    return { ok: false, status: 404, json: async () => null };
  };
  reset([noPosting(1)], { start: { remoteControl: 'now' } });
  runJobs(home, ['profile', 'set', JSON.stringify({ search: { role: 'software engineer', place: 'Berlin' } })]);
  await arm();
  let t = 0;
  const sleep = async (ms) => { t += ms; };
  const ctx = { fetchImpl: mk(), hnBudgetMs: 1000, sleep, clock: () => t };
  assert.deepEqual(await tick(NOW + 1000, ctx), [], 'the read is cut off: the round is open');
  assert.ok(store.loadState().hn.remaining > 0);
  ctx.hnBudgetMs = 90000;
  const end = await tick(NOW + 2000, ctx);
  assert.equal(store.loadState().hn.remaining, 0);
  assert.equal(end.length, 1);
  assert.match(end[0], /employer_page/);
});

// ---- item 7: prepare and the round's writer ----------------------------------------------------
const qs = [{ label: 'First name', required: true, type: 'input_text' }, { label: 'Email', required: true, type: 'input_text' }, { label: 'Resume', required: true, type: 'input_file' }];
const writes = [...qs, { label: 'Why do you want to work here?', required: true, type: 'textarea', maxLength: 500 }];
const profile = { facts: { first_name: 'Sam', email: 'sam@example.test' }, eeoText: 'Decline every voluntary demographic question (test placeholder).', resumeText: 'text' };

test('a sheet with no new writing goes straight to apply_ready with no model; one that needs writing waits for the round', async () => {
  const a = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/71', status: 'shortlisted', questions: qs });
  const b = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/72', status: 'shortlisted', questions: writes });
  reset([a, b]);
  const r = await prep.prepareInCode({ fetch: null, profile });
  assert.deepEqual(r.ready, [a.key]);
  assert.deepEqual(r.needsWriting, [b.key]);
  assert.equal(store.loadState().jobs[a.key].status, 'apply_ready');
  const items = work.buildWorkList(store.loadState(), empty, NOW, profile).items;
  assert.deepEqual(items.filter((i) => i.reason === 'prepare_due').map((i) => i.key), [b.key], 'prepare_due only for the sheet with new writing');
  assert.ok(items.some((i) => i.key === a.key && i.reason === 'apply_ready'));
});

test('a Greenhouse job gets its questions from the board in code; a failed fetch leaves a model item', async () => {
  const g = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/81', status: 'shortlisted' });
  reset([g]);
  const q = fixture('greenhouse-questions.json');
  const f = fakeFetch({ 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/1?questions=true': q });
  await prep.prepareInCode({ fetch: f, profile });
  assert.ok(store.loadState().jobs[g.key].questions.length > 0, 'questions read by code');
  reset([mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/82', status: 'shortlisted' })]);
  await prep.prepareInCode({ fetch: fakeFetch({}), profile });
  assert.deepEqual(work.buildWorkList(store.loadState(), empty, NOW, profile).items.map((i) => i.reason), ['prepare_due']);
});

test('one writer call per round covers the sheets, the new leads and the contacts; its result lands in code', () => {
  const b = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/72', status: 'shortlisted', questions: writes });
  reset([b]);
  const sheet = syncSheet(b);
  store.updateState((s) => {
    s.jobs[b.key].sheet = sheet;
    s.jobs[b.key].needsWriting = true;
    s.leads = [{ url: 'https://x.com/someone/status/1', key: 'x:1', channel: 'x', author: 'someone', employer: 'Acme', role: 'Engineer', excerpt: 'hiring', status: 'new', intro: null }];
    s.contacts[b.key] = [{ name: 'Person A', title: 'CTO', sourceUrl: 'https://example.test/a', how: 'DM', cares: 'speed', channel: 'x' }];
  });
  const st = store.loadState();
  const req = writing.buildRoundRequest({ sheets: [{ job: st.jobs[b.key], fields: prep.writableFields(sheet).map((u) => writes.find((q) => q.label === u.label)) }], leads: st.leads, intros: [{ job: st.jobs[b.key], contacts: st.contacts[b.key] }], profile, rulesText: '' });
  assert.equal(req.model, 'opus');
  assert.deepEqual(req.counts, { sheets: 1, leads: 1, intros: 1 });
  assert.equal((req.prompt.match(/<data>/g) || []).length, 1, 'one call');
  const result = writing.parseRoundResult(JSON.stringify({ answers: { [b.key]: { 'Why do you want to work here?': 'I like building careful systems.' } }, leads: { 'https://x.com/someone/status/1': { text: 'Hi, I saw your post.' } }, intros: { [b.key]: { 'Person A': { text: 'Hello Person A.' } } } }));
  const out = store.updateState((s) => {
    const r = prep.applyRoundDrafts(s, result.answers, profile);
    store.applyOp(s, { op: 'intro', key: b.key, name: 'Person A', text: result.intros[b.key]['Person A'].text });
    return r;
  });
  assert.equal(out.written, 1);
  assert.equal(store.loadState().jobs[b.key].status, 'apply_ready', 'the sheet was rebuilt, checked and advanced in code');
  assert.equal(store.loadState().contacts[b.key][0].intro.text, 'Hello Person A.');
});
function syncSheet(job) {
  return { ...buildSheet({ job, questions: job.questions, profile, answers: [], drafts: {} }), passed: false };
}

// ---- item 8: post_review facts, board posts in code ----------------------------------------------
test('a post item carries its board links, handle and emails, found by code word for word', () => {
  const p = { url: 'https://x.com/someone/status/5', author: 'someone', source: 'x', text: 'We are hiring! https://job-boards.greenhouse.io/acme/jobs/123 or mail jobs@acme.test', links: [] };
  const f = post.postFacts(p);
  assert.deepEqual(f.boardLinks, ['https://job-boards.greenhouse.io/acme/jobs/123']);
  assert.equal(f.handle, 'someone');
  assert.deepEqual(f.emails, ['jobs@acme.test']);
  reset([], {});
  store.updateState((s) => { s.posts = [{ ...p, status: 'new' }]; });
  const item = work.buildWorkList(store.loadState(), empty, NOW, {}).items.find((i) => i.reason === 'post_review');
  assert.deepEqual(item.posts[0].emails, ['jobs@acme.test']);
});

test('a hiring post with a board link becomes a posting in code, its author becomes the contact, and it is not a post to review', async () => {
  reset();
  const gh = { jobs: [{ id: 123, title: 'Software Engineer', company_name: 'Acme', location: { name: 'Berlin' }, first_published: '2026-11-20T00:00:00Z', content: 'x' }] };
  store.updateState((s) => { s.posts = [{ url: 'https://x.com/someone/status/5', author: 'someone', source: 'x', postedAt: null, text: 'hiring https://job-boards.greenhouse.io/acme/jobs/123', status: 'new' }, { url: 'https://x.com/other/status/6', author: 'other', source: 'x', postedAt: null, text: 'hiring, DM me', status: 'new' }]; });
  const r = await ing.resolveBoardPosts({ profile: {}, overlay: empty, fetch: fakeFetch({ 'https://boards-api.greenhouse.io/v1/boards/acme/jobs': gh }), now: NOW });
  assert.equal(r.resolved, 1);
  const s = store.loadState();
  assert.equal(Object.keys(s.jobs).length, 1);
  assert.deepEqual(s.posts.map((p) => p.author), ['other'], 'only the post without a posting is left to review');
  assert.equal(s.postOutcomes.job, 1);
  const [c] = Object.values(s.contacts)[0];
  assert.deepEqual([c.name, c.channel, c.how], ['someone', 'x', 'DM @someone on X']);
  assert.equal(s.routed.lastSearchAt, null, 'not a search round');
});

test('a lead needs no record from the model when code has its handle or its one email', async () => {
  reset();
  store.updateState((s) => { s.posts = [{ url: 'https://x.com/someone/status/7', author: 'someone', source: 'x', text: 'hiring', status: 'new' }, { url: 'hn:1', author: 'pg', source: 'hn', text: 'Acme hiring, mail jobs@acme.test', status: 'new' }]; });
  const obj = { need: 'hn_hiring_posts', status: 'fulfilled', query: { role: 'e', place: '', remote: false, since: null }, postings: [], batch: ['https://x.com/someone/status/7', 'hn:1'], outcomes: [{ url: 'https://x.com/someone/status/7', outcome: 'lead' }, { url: 'hn:1', outcome: 'lead' }] };
  const out = await ing.ingest({ obj, state: store.loadState(), profile: {}, overlay: empty, fetch: fakeFetch({}), now: NOW });
  assert.deepEqual(out.held, []);
  assert.deepEqual(store.loadState().leads.map((l) => [l.channel, l.handle || l.email]), [['x', 'someone'], ['email', 'jobs@acme.test']]);
});

test('an unreadable post is not_hiring with its reason, counted, and not shown again unless its text changes', async () => {
  reset();
  const p = { url: 'https://x.com/someone/status/8', author: 'someone', source: 'x', text: '???', status: 'new' };
  store.updateState((s) => { s.posts = [p]; });
  const obj = { need: 'hn_hiring_posts', status: 'fulfilled', query: { role: 'e', place: '', remote: false, since: null }, postings: [], batch: [p.url], outcomes: [{ url: p.url, outcome: 'not_hiring', reason: 'unreadable' }] };
  await ing.ingest({ obj, state: store.loadState(), profile: {}, overlay: empty, fetch: fakeFetch({}), now: NOW });
  const s = store.loadState();
  assert.equal(s.postOutcomes.not_hiring, 1);
  assert.equal(s.postReasons.unreadable, 1);
  assert.match(report.renderReport(s, empty, { now: NOW }), /1 not hiring \(1 unreadable\)/);
  assert.equal(ing.postSeen(s, p), true);
  assert.equal(ing.postSeen(s, { ...p, text: 'now readable' }), false, 'a changed text comes back');
});

// ---- item 9: free web searches ------------------------------------------------------------------
test('J search plan prints the exact queries; code extracts, dedupes and sorts the raw results', async () => {
  reset();
  runJobs(home, ['profile', 'set', JSON.stringify({ search: { role: 'software engineer', place: 'Berlin', remote: true } })]);
  const plan = runJobs(home, ['search', 'plan']).json;
  assert.equal(plan.queries.length, 5);
  assert.match(plan.queries[0], /^site:jobs\.ashbyhq\.com "software engineer" "Berlin" remote$/);
  assert.match(plan.queries[4], /^site:x\.com "hiring" "software engineer" "Berlin"$/);
  const gh = { jobs: [{ id: 5, title: 'Software Engineer', company_name: 'Acme', location: { name: 'Berlin' }, first_published: '2026-11-20T00:00:00Z', content: 'x' }] };
  const raw = [
    { query: plan.queries[1], results: [{ url: 'https://www.linkedin.com/jobs/view/1', title: 'Engineer', snippet: 's', company: 'Zed', city: 'Berlin', remote: false }, { url: 'https://job-boards.greenhouse.io/acme/jobs/5', title: 't' }, { url: 'https://www.indeed.com/viewjob?jk=1', title: 'no company here' }] },
    { query: plan.queries[2], results: [{ url: 'https://job-boards.greenhouse.io/acme/jobs/5/', title: 'again' }, { url: 'https://x.com/someone/status/9', title: 'p', snippet: 'we are hiring', author: 'someone' }] },
  ];
  const obj = ing.normalizeWeb({ need: 'web_search', status: 'fulfilled', query: plan.query, raw });
  assert.deepEqual(obj.results.map((r) => r.url), ['https://job-boards.greenhouse.io/acme/jobs/5', 'https://x.com/someone/status/9', 'https://www.linkedin.com/jobs/view/1'], 'deduped, sorted: board, X, platform; the result with no company is dropped');
  assert.equal(obj.droppedRaw, 1);
  const out = await ing.ingest({ obj: { need: 'web_search', status: 'fulfilled', query: plan.query, raw }, state: store.loadState(), profile: {}, overlay: empty, fetch: fakeFetch({ 'https://boards-api.greenhouse.io/v1/boards/acme/jobs': gh }), now: NOW });
  assert.deepEqual(out.held, []);
  assert.ok(out.added >= 1);
  assert.equal(web.flattenRaw(raw).length, 4);
});

// ---- item 10: contacts ------------------------------------------------------------------------------
test('J contacts route runs the router\'s people search in code, drops people outside the city, and holds a failure', async () => {
  const P = fixture('router/people-search.json');
  const job = noPosting(1, { city: 'Bengaluru', employerWebsite: 'stripe.com' });
  reset([job], { contactsRequested: [job.key] });
  const f = fake({ answers: [{ ...P.step1.json, __text: P.step1.text }, { ...P.step2_non_empty.envelope, result: JSON.stringify(P.step2_non_empty.envelope.result) }] });
  const log = await routed.routeContacts({ keys: [job.key], profile: {}, fetch: fakeFetch({}), client: client(f), now: NOW });
  assert.deepEqual(log, [{ job: job.key, ok: true, contacts: 1, searchedBy: 'website' }]);
  const s = store.loadState();
  assert.deepEqual(s.contacts[job.key].map((c) => c.name), ['Person J']);
  assert.equal(s.routed.lastSearchAt, null, 'the search clock is not touched');
  assert.equal(work.buildWorkList(s, empty, NOW, {}).items.some((i) => i.reason === 'contacts_requested'), false, 'a found contact closes the item');
  // a failure is held and never retried; the free ways stay a Haiku item
  reset([job], { contactsRequested: [job.key] });
  const g = fake({ answers: [{ status: 'failed', reason: 'down' }] });
  const bad = await routed.routeContacts({ keys: [job.key], profile: {}, fetch: fakeFetch({}), client: client(g), now: NOW });
  assert.equal(bad[0].ok, false);
  assert.equal(routed.jobNeeds(store.loadState(), {}, empty, { kinds: ['people_search'] }).length, 0, 'asked once');
  assert.equal(work.buildWorkList(store.loadState(), empty, NOW, {}).items.find((i) => i.reason === 'contacts_requested').key, job.key);
});

test('the watcher\'s round never runs the people search; it stays an attended request', () => {
  reset([noPosting(1, { employerWebsite: 'a.test' })], { contactsRequested: ['https://www.example-jobs.test/view/1'] });
  assert.equal(routed.jobNeeds(store.loadState(), {}, empty, { kinds: ['careers_page'] }).some((n) => n.kind === 'people_search'), false);
});

// ---- item 12: what brings a left item back ---------------------------------------------------------------
const due = () => work.workList({ now: NOW, commit: true }).items.map((i) => i.key).filter((k) => k !== 'search');
test('other_system comes back when a release takes the host off the deny list, and only then', () => {
  const j = noPosting(1, { otherSystem: { system: 'linkedin.com', url: 'https://www.linkedin.com/jobs/view/1' } });
  reset([j]);
  runJobs(home, ['leave', j.key, '--reason', 'other_system']);
  assert.deepEqual(due(), []);
  const h1 = work.inputsHash(store.loadState(), store.loadState().jobs[j.key], empty, {}, 'other_system');
  const gr = graphObj;
  const was = [...gr.neverHosts];
  gr.neverHosts.splice(gr.neverHosts.indexOf('linkedin.com'), 1);
  const h2 = work.inputsHash(store.loadState(), store.loadState().jobs[j.key], empty, {}, 'other_system');
  gr.neverHosts.splice(0, gr.neverHosts.length, ...was);
  assert.notEqual(h1, h2, 'a release that takes the host off the list changes the hash');
  const lowA = work.inputsHash(store.loadState(), store.loadState().jobs[j.key], empty, {}, 'low_score');
  store.updateState((s) => { s.answerV = 9; });
  assert.equal(work.inputsHash(store.loadState(), store.loadState().jobs[j.key], empty, {}, 'low_score'), lowA, 'saved answers are in no leave reason\'s hash');
  assert.notEqual(work.inputsHash(store.loadState(), store.loadState().jobs[j.key], empty, { search: { role: 'chef' } }, 'low_score'), lowA, 'a role change is');
  assert.notEqual(work.inputsHash(store.loadState(), store.loadState().jobs[j.key], empty, { unattended: { minScore: 80 } }, 'low_score'), lowA, 'the score floor is');
});
const graphObj = (await import('../../skills/loop-base/lib/graph.mjs')).graph();

test('sign_in comes back when the person says they have an account on that host: J fact set account', () => {
  const j = noPosting(1, { otherSystem: { system: 'Workday', url: 'https://acme.wd1.test/jobs' } });
  const k = noPosting(2);
  reset([j, k]);
  runJobs(home, ['leave', j.key, '--reason', 'sign_in']);
  runJobs(home, ['leave', k.key, '--reason', 'no_match']);
  assert.deepEqual(due(), []);
  assert.equal(runJobs(home, ['fact', 'set', 'account', 'other.test']).code, 0);
  assert.deepEqual(due(), [], 'another host changes nothing');
  assert.equal(runJobs(home, ['fact', 'set', 'account', 'acme.wd1.test']).json.saved, 'account');
  assert.deepEqual(due(), [j.key], 'only the sign_in item comes back; account is not a general answer');
  assert.equal(store.loadState().jobs[k.key].left.reason, 'no_match');
});

test('J leave takes every work-list key; search items come back at the next period, a post batch is never left', () => {
  const T0 = Date.now(); // `J leave` stamps the period with the real clock
  const c = noPosting(3);
  reset([c], { contactsRequested: [c.key], posts: [{ url: 'https://x.com/a/status/1', author: 'a', source: 'x', text: 't', status: 'new' }] });
  store.updateState((s) => { s.search.needPending = [{ kind: 'x_hiring_posts', text: 't', query: {}, round: 0, at: new Date(T0).toISOString() }]; });
  runJobs(home, ['profile', 'set', JSON.stringify({ search: { role: 'e', place: '' } })]);
  const keys = () => work.buildWorkList(store.loadState(), empty, T0, store.loadState() && JSON.parse(fs.readFileSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), 'utf8'))).items.map((i) => i.key);
  assert.ok(keys().includes('need:x_hiring_posts') && keys().includes('search'));
  assert.equal(runJobs(home, ['leave', 'search', 'need:x_hiring_posts', '--reason', 'no_web_search']).code, 0);
  assert.ok(!keys().includes('search') && !keys().includes('need:x_hiring_posts'));
  assert.equal(work.buildWorkList(store.loadState(), empty, T0 + 86400000 * 2, { search: { role: 'e', place: '' } }).items.some((i) => i.key === 'need:x_hiring_posts'), true, 'comes back at the next period');
  assert.equal(runJobs(home, ['leave', `contacts:${c.key}`, '--reason', 'none_found']).code, 0);
  assert.ok(!keys().includes(c.key) || !work.buildWorkList(store.loadState(), empty, T0, {}).items.some((i) => i.reason === 'contacts_requested'));
  assert.equal(runJobs(home, ['leave', `contacts:${c.key}`, '--reason', 'low_score']).code, 2, 'a reason from another kind is refused');
  const batch = work.buildWorkList(store.loadState(), empty, T0, {}).items.find((i) => i.reason === 'post_review').key;
  const r = runJobs(home, ['leave', batch, '--reason', 'no_match']);
  assert.equal(r.code, 2);
  assert.match(r.json.error, /never left/);
});

// ---- item 13: the log -------------------------------------------------------------------------------------
test('subagent runs are logged where their result is recorded, and the report shows the day\'s wakes and runs', () => {
  reset([mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/91', status: 'new', hash: 'h' })]);
  const k = 'https://boards.greenhouse.io/acme/jobs/91';
  assert.equal(runJobs(home, ['ops', JSON.stringify([{ op: 'rank', key: k, fit: 70, line: 'ok' }])]).code, 0);
  const s = store.loadState();
  assert.deepEqual(s.runs.map((r) => [r.kind, r.items]), [['review', 1]]);
  const text = report.renderReport(s, empty, { now: Date.parse(s.runs[0].at) + 1000 });
  assert.match(text, /Subagent runs in the last day: 1 \(1 review\)/);
  assert.doesNotMatch(report.renderReport(s, empty, { now: Date.parse(s.runs[0].at) + 3 * 86400000 }), /Subagent runs in the last day/);
});

test('watch: with no sub-command it is the watcher, watch list is the board list', () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'scripts', 'jobs.mjs'), 'utf8');
  assert.equal((text.match(/^  async watch\(/gm) || []).length, 1, 'one watch command, not two');
  reset();
  assert.ok(runJobs(home, ['watch', 'list']).json.watch);
});
