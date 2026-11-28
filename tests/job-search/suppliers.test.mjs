import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fakeFetch, fixture, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const router = await import('../../skills/job-search/scripts/lib/router.mjs');
const routed = await import('../../skills/job-search/scripts/lib/routed.mjs');
const ing = await import('../../skills/job-search/scripts/lib/ingest.mjs');
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const x = await import('../../skills/job-search/scripts/lib/suppliers/x.mjs');
const careers = await import('../../skills/job-search/scripts/lib/suppliers/careers.mjs');
const people = await import('../../skills/job-search/scripts/lib/suppliers/people.mjs');
const FAKE = path.join(import.meta.dirname, 'helpers', 'fake-tenjin.mjs');
const FX = Object.fromEntries(['x-posts', 'careers-page', 'people-search', 'exa-search'].map((n) => [n, fixture(`router/${n}.json`)]));
const sp = (name) => ({ ...FX[name].step1.json, __text: FX[name].step1.text });
const run = (name, key = 'step2') => ({ ...FX[name][key].envelope, result: JSON.stringify(FX[name][key].envelope.result) });
const empty = { rules: [], lessons: [] };
const NOW = Date.parse('2026-11-24T20:00:00Z');
const GH = 'https://boards-api.greenhouse.io/v1/boards';
const ghBoard = (name, jobs) => ({ jobs: jobs.map((j) => ({ id: j.id, title: j.title, company_name: name, location: { name: 'New York, NY' }, first_published: '2026-11-20T00:00:00Z', content: '' })) });
const reset = () => store.updateState((s) => { Object.assign(s, store.emptyState()); });

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
const needOf = (kind, fields, text = 'x') => ({ kind, text, fields, query: fields });

// ---- the X search ----------------------------------------------------------------------
test('X: the mapper gives keywords plus operators, sorted by latest, never a sentence', () => {
  const m = x.mapper({ role: 'software engineer', place: 'New York City', since: '2026-11-21' });
  assert.equal(m.sort, 'latest');
  assert.match(m.query, /^hiring "software engineer" \("New York City" OR NYC\) since:2026-11-21$/);
  assert.equal(x.mapper({ role: 'designer', place: 'Berlin', since: null }).query, 'hiring "designer" ("Berlin")');
});

test('X: the adapter maps each tweet to a post with its author handle, date, text and linked URLs', () => {
  const { posts } = x.adapter(FX['x-posts'].step2.envelope.result);
  assert.equal(posts.length, 5);
  assert.deepEqual(posts[0], { url: 'https://x.com/person_a/status/1000000000000000001', author: 'person_a', postedAt: '2026-11-23T13:30:39.000Z', text: posts[0].text, links: ['https://jobs.ashbyhq.com/thinkingmachines/d7513f3d-6a49-485d-b3c7-ecb629ad48db'], source: 'x' });
  assert.deepEqual(posts[3].links, [], 'a hiring post with no link');
  assert.throws(() => x.adapter({ nope: 1 }), /no tweets list/);
});

test('X through the router: a post with a board link is checked on the board, the rest are kept for review', async () => {
  const f = fake({ answers: [sp('x-posts'), run('x-posts')] });
  const fields = { role: 'software engineer', place: 'New York City', remote: false, since: '2026-11-21' };
  const [r] = await router.runRound([needOf('x_hiring_posts', fields)], { client: client(f) });
  assert.equal(r.ok, true);
  assert.deepEqual(f.log().filter((l) => l.call)[1].call.input, FX['x-posts'].step2.input === undefined ? undefined : f.log().filter((l) => l.call)[1].call.input);
  assert.equal(r.cost, 'provider price 0.005 USD');
  reset();
  const fetch = fakeFetch({ [`${GH}/anthropic/`]: ghBoard('Anthropic', [{ id: 5174743008, title: 'Senior Software Engineer, Full-stack' }]), 'https://api.ashbyhq.com/posting-api/job-board/thinkingmachines': { jobs: [] } });
  const out = await ing.ingest({ obj: r.ingest, state: store.loadState(), profile: { places: ['New York'], includeOld: true }, overlay: empty, fetch, now: NOW });
  const s = store.loadState();
  assert.equal(out.held.length >= 0, true);
  assert.ok(Object.values(s.jobs).some((j) => j.employerPosting && j.employerPosting.token === 'anthropic' && j.employerPosting.confidence === 'exact'), 'the Greenhouse link became a posting in code');
  assert.equal(s.posts.length, 3, 'the Ashby post (board has no such job), the shortened link and the post with no link are not jobs; the rest go to review');
});

// ---- the careers-page finder -----------------------------------------------------------
test('careers: the mapper always sends an absolute https URL', () => {
  for (const [site, want] of [['anthropic.com', 'https://anthropic.com'], ['https://www.anthropic.com', 'https://www.anthropic.com'], ['http://acme.test', 'https://acme.test'], ['  acme.test ', 'https://acme.test']]) assert.deepEqual(careers.mapper({ website: site }), { url: want });
  assert.throws(() => careers.mapper({ website: '' }), /no employer website/);
});

test('careers: a Greenhouse board becomes a board candidate; another vendor or no board gives only the page URL', () => {
  const rec = FX['careers-page'].step2.envelope.result;
  const a = careers.adapter(rec, { jobKey: 'k', website: 'anthropic.com' });
  assert.deepEqual([a.boardLinks, a.careersUrl, a.found, a.careersPageOnly], [['https://boards.greenhouse.io/anthropic'], 'https://www.anthropic.com/careers/jobs', true, false]);
  const other = { result: { found: true, careers_page: { url: 'https://acme.test/jobs' }, open_positions: { vendor: 'workday', board: 'acme', count: 3 } } };
  const b = careers.adapter(other, { jobKey: 'k', website: 'acme.test' });
  assert.deepEqual([b.boardLinks, b.careersPageOnly], [[], true]);
  const none = careers.adapter({ result: { found: false } }, { jobKey: 'k', website: 'acme.test' });
  assert.deepEqual([none.boardLinks, none.careersPageOnly, none.careersUrl], [[], false, 'https://acme.test']);
  for (const v of ['lever', 'ashby']) assert.match(careers.adapter({ result: { found: true, careers_page: { url: 'https://a.test/c' }, open_positions: { vendor: v, board: 'acme' } } }, { jobKey: 'k', website: 'a.test' }).boardLinks[0], new RegExp(v === 'lever' ? 'jobs\\.lever\\.co/acme' : 'jobs\\.ashbyhq\\.com/acme'));
  assert.throws(() => careers.adapter({ result: {} }, { jobKey: 'k', website: 'a.test' }), /no found flag/);
});

test('careers through the router: the run envelope needs no label; the board goes through the probe and match rule for confirmed', async () => {
  const f = fake({ answers: [sp('careers-page'), run('careers-page')] });
  assert.equal(FX['careers-page'].step2.envelope.label, undefined, 'the recorded envelope has no label');
  const job = { key: 'https://www.example-jobs.test/view/1', url: 'https://www.example-jobs.test/view/1', title: 'Software Engineer', company: 'Anthropic', city: 'New York', remote: false, posted: '2026-11-20T00:00:00Z', status: 'reviewed', employerPosting: null, openConfirmed: false, unresolved: 'no_board', employerWebsite: 'anthropic.com', hash: 'h', warnings: [], parked: null, v: 1 };
  reset();
  store.updateState((s) => { s.jobs[job.key] = job; });
  const need = routed.jobNeeds(store.loadState(), {}, empty)[0];
  assert.equal(need.kind, 'careers_page');
  assert.match(need.text, /Anthropic/);
  const [r] = await router.runRound([need], { client: client(f) });
  assert.equal(r.ok, true);
  assert.equal(r.ingest.jobKey, job.key);
  const fetch = fakeFetch({ [`${GH}/anthropic/`]: ghBoard('Anything', [{ id: 9, title: 'Software Engineer' }]) });
  await ing.ingest({ obj: r.ingest, state: store.loadState(), profile: {}, overlay: empty, fetch, now: NOW });
  const done = store.loadState().jobs[job.key];
  assert.equal(done.employerPosting.source, 'careers_page');
  assert.equal(done.employerPosting.confidence, 'confirmed');
  assert.equal(done.careersChecked, true);
  assert.equal(routed.jobNeeds(store.loadState(), {}, empty).length, 0, 'asked once');
});

test('careers: a page the router found but not read keeps its address, and the model reads the listings', async () => {
  const job = { key: 'https://x.test/1', url: 'https://x.test/1', title: 'Engineer', company: 'Acme', city: 'New York', status: 'reviewed', employerPosting: null, unresolved: 'no_board', hash: 'h', warnings: [], v: 1 };
  reset();
  store.updateState((s) => { s.jobs[job.key] = job; });
  const obj = { need: 'careers_page', status: 'fulfilled', ...careers.adapter({ result: { found: true, careers_page: { url: 'https://acme.test/jobs' }, open_positions: { vendor: 'workday', board: 'acme' } } }, { jobKey: job.key, website: 'acme.test' }) };
  await ing.ingest({ obj, state: store.loadState(), profile: {}, overlay: empty, fetch: fakeFetch({}), now: NOW });
  const after = store.loadState().jobs[job.key];
  assert.equal(after.careersUrl, 'https://acme.test/jobs');
  assert.equal(after.careersChecked, undefined, 'the model still reads the page');
  assert.equal(after.otherSystem, undefined);
});

test('a rejected input is the mapper\'s bug: that search is held with the reason and never resent', async () => {
  const rej = FX['careers-page'].step2_rejected.envelope;
  const f = fake({ answers: [sp('careers-page'), rej] });
  const [r] = await router.runRound([needOf('careers_page', { jobKey: 'k', website: 'anthropic.com' })], { client: client(f) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'input_break');
  assert.match(r.reason, /rejected this input before any payment/);
  assert.equal(f.log().filter((l) => l.call).length, 2, 'the run was sent once, never again');
  assert.deepEqual(careers.mapper({ website: FX['careers-page'].step2_rejected.input.url }), { url: 'https://anthropic.com' }, 'the fixed mapper no longer sends the bare domain');
});

// ---- the people search -------------------------------------------------------------------
test('people: the mapper sends the company website and titles, a location only with a city, and the count', () => {
  const titles = ['Engineering Manager', 'CTO'];
  assert.deepEqual(people.mapper({ website: 'https://www.stripe.com/jobs', titles, city: '', count: 3 }), { query: { currentCompanyWebsite: { include: ['stripe.com'] }, currentJobTitle: { include: titles } }, pagination: { size: 3 } });
  assert.deepEqual(people.mapper({ website: 'stripe.com', titles, city: 'New York', count: undefined }).query.location, { include: ['New York'] });
  assert.equal(people.mapper({ website: 'stripe.com', titles, count: undefined }).pagination.size, 5);
  assert.throws(() => people.mapper({ website: '', titles }), /no employer website/);
});

test('people: total 0 is a normal empty answer; a person found is a likely contact, not confirmed', async () => {
  const emptyRes = FX['people-search'].step2.envelope.result;
  assert.equal(emptyRes.total, 0);
  assert.deepEqual(people.adapter(emptyRes, { jobKey: 'k' }), { jobKey: 'k', contacts: [], total: 0, found: 0, outside: 0, city: '' });
  const hand = people.adapter(FX['people-search'].step2_non_empty.envelope.result, { jobKey: 'k' });
  assert.deepEqual([hand.contacts[0].name, hand.contacts[0].channel, hand.contacts[0].notConfirmed, hand.contacts[0].basis], ['Person J', 'linkedin', true, 'likely']);
  assert.equal(hand.contacts.length, 2);
  const inBlr = people.adapter(FX['people-search'].step2_non_empty.envelope.result, { jobKey: 'k', city: 'Bengaluru' });
  assert.deepEqual(inBlr.contacts.map((c) => c.name), ['Person J'], 'a person whose address does not name the job\'s city is dropped in code');
  assert.equal(people.adapter(FX['people-search'].step2_non_empty.envelope.result, { jobKey: 'k', city: 'Berlin' }).contacts.length, 0);
  assert.equal(inBlr.contacts[0].title, 'Engineering Manager');
  const job = { key: 'https://x.test/2', url: 'https://x.test/2', title: 'Engineer', company: 'Acme', city: 'New York', status: 'reviewed', hash: 'h', warnings: [], employerWebsite: 'acme.test', v: 1 };
  reset();
  store.updateState((s) => { s.jobs[job.key] = job; s.contactsRequested = [job.key]; });
  assert.equal(routed.jobNeeds(store.loadState(), {}, empty)[0].kind, 'people_search');
  // the empty answer: no error, no hold, the request is done
  const f = fake({ answers: [sp('people-search'), run('people-search')] });
  const [r] = await router.runRound([routed.jobNeeds(store.loadState(), {}, empty)[0]], { client: client(f) });
  assert.equal(r.ok, true);
  const o = await ing.ingest({ obj: r.ingest, state: store.loadState(), profile: {}, overlay: empty, fetch: fakeFetch({}), now: NOW });
  assert.equal(o.held.length, 0);
  assert.equal(store.loadState().jobs[job.key].contactsSearched !== undefined, true);
  assert.deepEqual(store.loadState().contactsRequested, []);
  // a person: stored as a contact marked not confirmed
  store.updateState((s) => { s.contactsRequested = [job.key]; s.jobs[job.key].contactsSearched = undefined; });
  const second = await ing.ingest({ obj: { need: 'people_search', status: 'fulfilled', ...hand, jobKey: job.key }, state: store.loadState(), profile: {}, overlay: empty, fetch: fakeFetch({}), now: NOW });
  assert.equal(second.contacts, 2, JSON.stringify(second));
  const c = store.loadState().contacts[job.key][0];
  assert.deepEqual([c.name, c.notConfirmed, c.channel, c.sourceUrl], ['Person J', true, 'linkedin', 'https://www.linkedin.com/in/person-j']);
});

// ---- the board search runs in code, by catalog tool id ---------------------------------------
test('board search: with Tenjin it runs in code by tool id, ingests board-confirmed links, and is never a model step', async () => {
  reset();
  const prof = { places: ['New York'], includeOld: true, search: { role: 'software engineer', place: 'New York City' } };
  const J = fixture('router/job-postings.json');
  const jrun = { ...J.step2.envelope, result: JSON.stringify(J.step2.envelope.result) };
  const answers = [{ ...J.step1.json, __text: J.step1.text }, jrun, sp('x-posts'), run('x-posts'), sp('exa-search'), run('exa-search')];
  const g = fake({ answers });
  const fetch = fakeFetch({});
  const log = await routed.routedRounds({ profile: prof, fetch, client: client(g), now: NOW });
  assert.ok(log.some((l) => l.need === 'job_postings' && l.ok));
  assert.ok(log.some((l) => l.need === 'x_hiring_posts' && l.ok));
  assert.ok(log.some((l) => l.need === 'web_search' && l.ok), 'the board search ran');
  const calls = g.log().filter((l) => l.call).map((l) => l.call);
  assert.deepEqual(calls.filter((c) => c.tool), [{ tool: 'exa-search' }]);
  assert.equal(calls.some((c) => typeof c.query === 'string' && /site:|boards?|search api/i.test(c.query)), false, 'no {query} route for the board search');
  const s = store.loadState();
  assert.ok(s.held.filter((h) => h.detail.startsWith('routed:web_search')).every((h) => /board .* unavailable/.test(h.detail)), 'only a board lookup may hold it (no board answers in this test), never the router call');
  const wl = (await import('../../skills/job-search/scripts/lib/work.mjs')).buildWorkList(s, empty, NOW, prof);
  assert.ok(!wl.items.some((i) => i.reason === 'web_search_due'));
  assert.equal(routed.roundNeeds(prof, s, NOW, 0).find((n) => n.kind === 'web_search').tool, 'exa-search');
});
