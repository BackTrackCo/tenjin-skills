import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, runGtm, tmpHome } from './helpers/env.mjs';
import { fake, runAnswer, specAnswer } from './helpers/fake-router.mjs';

const home = tmpHome();
const qc = await import('../../skills/gtm-loop/scripts/lib/querycheck.mjs');
const store = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
const routed = await import('../../skills/gtm-loop/scripts/lib/routed.mjs');
const router = await import('../../skills/gtm-loop/scripts/lib/router.mjs');
const qtest = await import('../../skills/gtm-loop/scripts/lib/qtest.mjs');
const rep = await import('../../skills/gtm-loop/scripts/lib/report.mjs');
const work = await import('../../skills/gtm-loop/scripts/lib/work.mjs');
await import('../../skills/gtm-loop/scripts/lib/steps.mjs');
const { validateProfile } = await import('../../skills/gtm-loop/scripts/lib/profile.mjs');

const NOW = Date.parse('2026-11-27T10:00:00Z');
const OFFER = { id: 'gtm', name: 'LoopA', who: 'founders', phrases: ['how did you get your first customers'], subreddits: ['startups', 'SaaS'] };
const X_OK = '("any recommendations" OR "looking for") first customers lang:en -filter:retweets -filter:links';
const RD_OK = '(subreddit:startups OR subreddit:saas) ("looking for" OR "how did") first customers';
const WEB_OK = 'A forum or community post where someone asks: how did you get your first customers? They are a founder looking for help with outbound.';
const client = (f) => new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 300, collect: 40, poll: 10 } });
const profileWith = (queries, extra = {}) => ({ sources: ['x', 'reddit', 'linkedin', 'web'], offers: [{ ...OFFER, queries, ...extra }] });

test('X queries: English, no retweets, only operators the seller supports, no account targeting, no window of their own', () => {
  assert.deepEqual(qc.checkQuery('x', X_OK, OFFER), []);
  const has = (q, re) => qc.checkQuery('x', q, OFFER).some((b) => re.test(b));
  assert.ok(has('first customers -filter:retweets', /lang:en/));
  assert.ok(has('first customers lang:en', /-filter:retweets/));
  assert.ok(has('first customers lang:fr -filter:retweets', /English only/));
  assert.ok(has('first customers lang:en -filter:retweets site:example.org', /site: is not supported/));
  assert.ok(has('first customers lang:en -filter:retweets since:2026-11-01', /added by code/));
  assert.ok(has('first customers lang:en -filter:retweets from:someone', /aims at one account/));
  assert.ok(has('first customers lang:en -filter:retweets min_faves:lots', /takes a number/));
  assert.ok(has('"first customers lang:en -filter:retweets', /not closed/));
  assert.ok(has(`${X_OK} https://example.org`, /no link/));
  assert.ok(has(`${X_OK} ${'x'.repeat(400)}`, /400 characters at most/));
  assert.deepEqual(qc.checkQuery('x', 'first customers min_faves:5 lang:en -filter:retweets -filter:replies', OFFER), []);
});

test('Reddit queries: subreddit operators only from the offer\'s own list, at least one, title: allowed, no other operator', () => {
  assert.deepEqual(qc.checkQuery('reddit', RD_OK, OFFER), []);
  const has = (q, re) => qc.checkQuery('reddit', q, OFFER).some((b) => re.test(b));
  assert.ok(has('(subreddit:startups OR subreddit:gardening) first customers', /subreddit:gardening is not in this offer's list/));
  assert.ok(has('first customers', /use subreddit:name/));
  assert.ok(has('subreddit:startups author:someone first customers', /author: is not used/));
  assert.ok(has('subreddit:startups site:x.com first customers', /site: is not used/));
  assert.deepEqual(qc.checkQuery('reddit', 'subreddit:startups title:"first customers"', OFFER), []);
  assert.ok(has(`${RD_OK} ${'x'.repeat(300)}`, /300 characters/));
});

test('web, LinkedIn and Hacker News queries: plain description, or key words, and no operators', () => {
  assert.deepEqual(qc.checkQuery('web', WEB_OK, OFFER), []);
  const has = (src, q, re) => qc.checkQuery(src, q, OFFER).some((b) => re.test(b));
  assert.ok(has('web', 'where someone asks "how did you" get (first) customers OR users site:reddit.com', /no quotes/));
  assert.ok(has('web', 'first customers', /at least six words/));
  assert.ok(has('web', 'a post where someone asks how to get users lang:en for help', /no operators/));
  assert.ok(has('web', 'a post where someone asks how to get users (for help) really', /no parentheses/));
  assert.deepEqual(qc.checkQuery('linkedin', 'first customers outbound', OFFER), []);
  assert.ok(has('linkedin', '"first customers" OR outbound', /key words/));
  assert.ok(has('linkedin', 'one two three four five six seven eight nine', /8 words at most/));
  assert.deepEqual(qc.checkQuery('hn', 'first customers', OFFER), []);
  assert.ok(has('hn', 'first customers site:x.com', /no operators/));
  assert.ok(has('hn', 'one two three four five six seven', /6 words at most/));
  assert.ok(has('hn', '', /empty/));
  assert.deepEqual(qc.checkQuery('nope', 'x', OFFER), ['unknown source: nope']);
});

test('a profile with a bad stored query is refused with the reason; a good one saves; queries come only through the attended command', () => {
  assert.deepEqual(validateProfile(profileWith({ x: X_OK, reddit: RD_OK, web: WEB_OK, linkedin: 'first customers', hn: 'first customers' })), []);
  assert.ok(validateProfile(profileWith({ reddit: '(subreddit:gardening) first customers' })).some((b) => /offers\[0\]\.queries\.reddit: subreddit:gardening is not in this offer's list/.test(b)));
  const G = (...a) => runGtm(home, a);
  assert.equal(G('profile', 'set', '--json', JSON.stringify({ offers: [OFFER] })).code, 0);
  const refused = G('queries', 'set', '--offer', 'gtm', '--json', JSON.stringify({ x: 'first customers', web: 'first customers' }));
  assert.equal(refused.code, 1);
  assert.match(refused.json.error, /refused, rewrite: x: X needs lang:en/);
  assert.equal(Object.keys(G('queries').json.offers[0].queries).length, 0, 'nothing is saved when one fails');
  const ok = G('queries', 'set', '--offer', 'gtm', '--json', JSON.stringify({ x: X_OK, reddit: RD_OK }));
  assert.deepEqual(Object.keys(ok.json.queries), ['x', 'reddit']);
  assert.equal(G('queries', 'set', '--offer', 'nope', '--json', '{}').code, 1);
  store.updateState((s) => { s.batch = { mode: 'unattended', openedAt: new Date().toISOString(), touchedAt: new Date().toISOString() }; });
  for (const a of [['queries', 'set', '--offer', 'gtm', '--json', '{}'], ['queries', 'decline', '--offer', 'gtm'], ['query', 'test', 'gtm', 'x']]) assert.match(G(...a).json.error, /a batch is open/, a.join(' '));
  store.updateState((s) => { s.batch = null; });
  assert.equal(G('queries', 'decline', '--offer', 'gtm').json.declined, 'gtm');
});

test('the daily round runs the stored queries in code: one need per source per offer, the stored text as it is, a refused one skipped and named', async () => {
  store.updateState((s) => Object.assign(s, store.emptyState()));
  const p = profileWith({ x: X_OK, reddit: RD_OK, web: WEB_OK });
  const needs = routed.postNeeds({ profile: p, overlay: { rules: [] }, state: store.emptyState(), now: NOW });
  const by = Object.fromEntries(needs.map((n) => [n.kind, n]));
  assert.equal(needs.length, 4, 'three stored, one built for LinkedIn (no stored query)');
  assert.equal(by.x_posts.fields.query, X_OK);
  assert.equal(by.x_posts.fields.phrase, 'query:gtm:x');
  assert.equal(by.reddit_posts.fields.query, RD_OK);
  assert.equal(by.web_research.fields.query, WEB_OK);
  assert.equal(by.web_research.fields.mode, 'discussion');
  assert.equal(by.linkedin_posts.fields.phrase, 'how did you get your first customers', 'no stored query: the code builds one from the phrase');
  const bad = profileWith({ x: 'first customers' });
  assert.equal(routed.postNeeds({ profile: bad, overlay: { rules: [] }, state: store.emptyState(), now: NOW }).some((n) => n.kind === 'x_posts'), false);
  assert.deepEqual(routed.queryRefusals(bad).map((r) => [r.offerId, r.src]), [['gtm', 'x']]);
  const f = fake({ answers: [] });
  await routed.runPostRound({ profile: { ...bad, sources: ['x'] }, overlay: { rules: [] }, client: client(f), now: NOW });
  assert.match(store.loadState().held.find((h) => h.status === 'query_refused').detail, /the x query gtm:x was refused: X needs lang:en/);
});

test('a profile with no stored queries keeps the queries code builds, and the report says they were never tried live', () => {
  const p = { sources: ['x', 'hn'], offers: [OFFER] };
  const needs = routed.postNeeds({ profile: p, overlay: { rules: [] }, state: store.emptyState(), now: NOW });
  assert.equal(needs.length, 1);
  assert.match(needs[0].fields.query, /^\("any recommendations" OR .* OR \(first customers\)\) lang:en -filter:links$/);
  const text = rep.report(store.emptyState(), p, NOW).text;
  assert.match(text, /Untested live: these use the queries code builds, not a query the model wrote and tested: gtm x, gtm hn\./);
  assert.doesNotMatch(rep.report(store.emptyState(), profileWith({ x: X_OK }), NOW).text.match(/Untested live[^\n]*/)[0], /gtm x(,|\.)/);
});

test('G query test runs one query once: the count, what each filter drops, three short samples with no handles, and the cost; nothing is stored', async () => {
  store.updateState((s) => Object.assign(s, store.emptyState()));
  const rd = fixture('router/reddit-anyapi.json');
  const result = { output: { found: true, data: { posts: [
    { title: 'Looking for how to get my first customers', selftext: 'I have none, any ideas? Ask me @someone at https://example.org/x', subreddit: 'startups', author: 'a1', url: 'https://www.reddit.com/r/startups/comments/a/b/', permalink: '/r/startups/comments/a/b/', createdUtc: 1795596000 },
    { title: 'Weekly promo thread', selftext: 'Show us what you built this week', subreddit: 'startups', author: 'a2', url: 'https://www.reddit.com/r/startups/comments/c/d/', permalink: '/r/startups/comments/c/d/', createdUtc: 1795596000 },
    { title: 'How to garden', selftext: 'How do I grow tomatoes in my garden?', subreddit: 'gardening', author: 'a3', url: 'https://www.reddit.com/r/gardening/comments/e/f/', permalink: '/r/gardening/comments/e/f/', createdUtc: 1795596000 },
  ], nextCursor: null } } };
  const p = profileWith({ reddit: RD_OK });
  const f = fake({ answers: [specAnswer(rd.host), runAnswer(rd.host, result, { cost: ['provider price 0.0134 USD'] })] });
  const r = await qtest.testQuery({ profile: p, overlay: { rules: [] }, offerId: 'gtm', source: 'reddit', client: client(f), now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.returned, 3);
  assert.equal(r.passFilters, 1);
  assert.equal(r.dropped.not_an_ask, 1);
  assert.equal(r.dropped.outside_subreddits, 1);
  assert.equal(r.samples.length, 1);
  assert.doesNotMatch(r.samples[0], /@someone|https?:/);
  assert.ok(r.samples[0].length <= 90);
  assert.equal(r.cents, 1.34);
  assert.match(r.cost, /0\.0134 USD/);
  assert.match(f.calls()[1].input.query, /^\(subreddit:startups OR subreddit:saas\)/);
  assert.deepEqual(Object.keys(store.loadState().leads), [], 'a test stores no lead');
  assert.equal(store.loadState().queryTests['query:gtm:reddit'].returned, 3);
  assert.equal(store.loadState().spend.at(-1).kind, 'query_test');
  assert.equal(store.loadState().spend.at(-1).search, undefined, 'a test is not one of the day\'s searches');
});

test('a query test of an empty answer says to rewrite; a refused query runs nothing; with no stored query it says so', async () => {
  const x = fixture('router/x-posts.json');
  const p = profileWith({ x: X_OK });
  const f = fake({ answers: [specAnswer(x.host), runAnswer(x.host, { tweets: [], count: 0, suggestions: ['Try fewer keywords'] })] });
  const r = await qtest.testQuery({ profile: p, overlay: { rules: [] }, offerId: 'gtm', source: 'x', client: client(f), now: NOW });
  assert.equal(r.returned, 0);
  assert.match(r.verdict, /^empty: rewrite it/);
  const none = fake({ answers: [] });
  const bad = await qtest.testQuery({ profile: p, overlay: { rules: [] }, offerId: 'gtm', source: 'x', query: 'first customers', client: client(none), now: NOW });
  assert.equal(bad.ran, false);
  assert.ok(bad.refused.some((b) => /lang:en/.test(b)));
  assert.equal(none.calls().length, 0);
  await assert.rejects(() => qtest.testQuery({ profile: p, overlay: { rules: [] }, offerId: 'gtm', source: 'web', client: client(none), now: NOW }), /no stored web query/);
  const noise = fake({ answers: [specAnswer(x.host), runAnswer(x.host, { tweets: [{ url: 'https://x.com/a/status/1900000000000000901', text: 'We just launched our new platform, sign up today for early access', author: { username: 'a' }, created_at: '2026-11-26T10:00:00Z', entities: { urls: [] } }] })] });
  const n = await qtest.testQuery({ profile: p, overlay: { rules: [] }, offerId: 'gtm', source: 'x', client: client(noise), now: NOW });
  assert.match(n.verdict, /only noise/);
});

test('a Hacker News query test is free and uses the stored key words as they are', async () => {
  const calls = [];
  const fetchImpl = async (u) => { calls.push(u); return { ok: true, status: 200, json: async () => ({ hits: [{ objectID: '1', _tags: ['story', 'ask_hn'], title: 'Ask HN: how did you get your first customers?', author: 'x', created_at_i: 1795596000 }] }) }; };
  const r = await qtest.testQuery({ profile: profileWith({ hn: 'first customers' }), overlay: { rules: [] }, offerId: 'gtm', source: 'hn', fetch: fetchImpl, now: NOW });
  assert.equal(r.cost, 'free');
  assert.equal(r.passFilters, 1);
  assert.ok(calls[0].includes('query=first%20customers&'));
});

test('the report shows the funnel per source and a Queries section; where no query kept a lead the model is due to write variants, with no yes', async () => {
  store.updateState((s) => Object.assign(s, store.emptyState()));
  const x = fixture('router/x-posts.json');
  const p = { ...profileWith({ x: X_OK }), sources: ['x'] };
  const f = fake({ answers: [specAnswer(x.host), runAnswer(x.host, x.result)] });
  await routed.runPostRound({ profile: p, overlay: { rules: [] }, client: client(f), now: NOW });
  let s = store.loadState();
  assert.equal(s.queryYield['query:gtm:x'].found, 2);
  assert.equal(s.queryYield['query:gtm:x'].kept, 2);
  assert.equal(s.funnel.sources.x.returned, 2);
  assert.equal(s.funnel.sources.x.toReview, 2);
  let text = rep.report(s, p, NOW).text;
  assert.match(text, /Last round, x: 1 search, 2 returned; 2 sent to review, 0 kept\./);
  assert.match(text, /Queries, x: best: gtm:x kept 0 of 2 results\./);
  assert.doesNotMatch(text, /rewrite|for the person's yes/);
  assert.equal(work.itemsOf(s, p, { rules: [] }, NOW).some((i) => i.reason === 'queries_due'), false, 'leads wait for review: no variants yet');
  // review leaves them all: no query kept a lead, so the model is due to write variants, and it does not wait for a yes
  store.updateState((st) => { for (const l of Object.values(st.leads)) { l.status = 'skipped'; l.skipReason = 'not_a_real_ask'; } });
  s = store.loadState();
  const item = work.itemsOf(s, p, { rules: [] }, NOW).find((i) => i.reason === 'queries_due');
  assert.equal(item.waitsForPerson, undefined, 'it wakes the model in a woken turn, with no yes');
  assert.equal(item.detail, 'gtm:x');
  assert.equal(work.itemsOf(s, p, { rules: [] }, NOW).some((i) => i.reason === 'rewrite_due'), false);
  // a second round where the same posts come back: nothing new goes to review
  const g = fake({ answers: [specAnswer(x.host), runAnswer(x.host, x.result)] });
  await routed.runPostRound({ profile: p, overlay: { rules: [] }, client: client(g), now: NOW + 3600000 });
  s = store.loadState();
  assert.equal(s.queryYield['query:gtm:x'].lastKept, 0);
  assert.equal(s.funnel.sources.x.duplicate, 2);
  assert.equal(s.queryYield['query:gtm:x'].rounds, 2);
  assert.deepEqual(s.queryYield['query:gtm:x'].history.map((h) => h.toReview), [2, 0]);
  assert.equal(s.queryYield['query:gtm:x'].passed.duplicate, 2);
  text = rep.report(s, p, NOW + 3600000).text;
  assert.match(text, /Last round, x: 1 search, 2 returned, dropped: duplicate 2; 0 sent to review, 0 kept\./);
});

test('the funnel counts every filter by source: link-only, not an ask, not a discussion, outside the list, too old', async () => {
  store.updateState((s) => Object.assign(s, store.emptyState()));
  const w = fixture('router/web-research.json');
  const result = { results: [
    { url: 'https://vendor.example/blog/guide', title: 'Guide', text: 'How do you get your first customers? Our complete guide explains it for founders.' },
    { url: 'https://forum.example.org/t/9', title: 'Q', text: 'How did you get your first customers? I have none yet.', publishedDate: '2026-11-25T10:00:00Z' },
    { url: 'https://forum.example.org/t/8', title: 'Old', text: 'How did you get your first customers? Asked long ago.', publishedDate: '2024-01-01T10:00:00Z' },
    { url: 'https://forum.example.org/t/7', title: 'Link', text: 'https://example.org/a https://example.org/b' },
  ] };
  store.updateState((s) => { s.routed.lastSearchAt = new Date(NOW - 5 * 86400000).toISOString(); });
  const p = { ...profileWith({ web: WEB_OK }), sources: ['web'] };
  const f = fake({ answers: [specAnswer(w.host), runAnswer(w.host, result)] });
  await routed.runPostRound({ profile: p, overlay: { rules: [] }, client: client(f), now: NOW });
  const web = store.loadState().funnel.sources.web;
  assert.deepEqual([web.returned, web.not_discussion, web.too_old, web.link_only, web.toReview], [4, 1, 1, 1, 1]);
});

test('G search route --need runs that one search only, whatever it was held for, and leaves the round\'s schedule alone', async () => {
  store.updateState((s) => Object.assign(s, store.emptyState()));
  const x = fixture('router/x-posts.json');
  const p = { ...profileWith({ x: X_OK, linkedin: 'first customers' }), sources: ['x', 'linkedin'] };
  const key = 'need:x_posts:query:gtm:x';
  store.updateState((s) => { s.held.push({ key, reason: 'need_held', status: 'failed', detail: 'x_posts: the seller was busy' }); });
  const f = fake({ answers: [specAnswer(x.host), runAnswer(x.host, x.result)] });
  const r = await routed.runPostRound({ profile: p, overlay: { rules: [] }, client: client(f), now: NOW, only: key });
  assert.equal(r.needs, 1);
  assert.equal(f.calls().filter((c) => c.query).length, 1, 'LinkedIn was not searched');
  const s = store.loadState();
  assert.equal(s.held.some((h) => h.key === key), false, 'the hold is cleared by the retry');
  assert.equal(s.routed.lastSearchAt, null);
  assert.equal(s.rounds.length, 0);
  await assert.rejects(() => routed.runPostRound({ profile: p, overlay: { rules: [] }, client: client(fake({ answers: [] })), now: NOW, only: 'need:x_posts:nope' }), /no search has the key/);
  const text = rep.report({ ...store.emptyState(), held: [{ key, reason: 'need_held', status: 'failed', detail: 'x_posts: the seller was busy' }] }, p, NOW).text;
  assert.match(text, new RegExp(`Retry only this search: G search route --need "${key}"\\.`));
});

test('a paid post search that answers 404 is empty for the day: held with that reason and not run again until the next day', async () => {
  store.updateState((s) => Object.assign(s, store.emptyState()));
  const x = fixture('router/x-posts.json');
  const p = { ...profileWith({ x: X_OK }), sources: ['x'] };
  const day1 = new Date(2026, 10, 27, 10, 0, 0).getTime();
  const f = fake({ answers: [specAnswer(x.host), { status: 'failed', reason: 'the seller answered http 404' }] });
  await routed.runPostRound({ profile: p, overlay: { rules: [] }, client: client(f), now: day1 });
  let s = store.loadState();
  const h = s.held.find((y) => y.key === 'need:x_posts:query:gtm:x');
  assert.equal(h.status, 'empty_404');
  assert.match(h.detail, /counted as empty for today and not run again until the next round/);
  assert.ok(Date.parse(h.skipUntil) > day1 && Date.parse(h.skipUntil) <= day1 + 86400000);
  assert.equal(s.queryYield['query:gtm:x'].lastKept, 0, 'counted as empty');
  const again = fake({ answers: [] });
  const r2 = await routed.runPostRound({ profile: p, overlay: { rules: [] }, client: client(again), now: day1 + 3600000 });
  assert.equal(r2.needs, 0, 'not run again the same day');
  assert.equal(again.calls().length, 0);
  const g = fake({ answers: [specAnswer(x.host), runAnswer(x.host, x.result)] });
  const r3 = await routed.runPostRound({ profile: p, overlay: { rules: [] }, client: client(g), now: day1 + 86400000 + 3600000 });
  assert.equal(r3.needs, 1, 'the next day\'s round runs it');
  s = store.loadState();
  assert.equal(s.held.some((y) => y.status === 'empty_404'), false);
  // an explicit retry runs it at once
  store.updateState((st) => { st.held.push({ key: 'need:x_posts:query:gtm:x', reason: 'need_held', status: 'empty_404', skipUntil: new Date(day1 + 99 * 3600000).toISOString(), detail: 'x' }); });
  const h2 = fake({ answers: [specAnswer(x.host), runAnswer(x.host, x.result)] });
  assert.equal((await routed.runPostRound({ profile: p, overlay: { rules: [] }, client: client(h2), now: day1 + 90 * 3600000, only: 'need:x_posts:query:gtm:x' })).needs, 1);
});

test('the skill text names the setup steps: write the queries with the phrases, test each once with its cost, retry one search with --need', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { SKILL } = await import('./helpers/env.mjs');
  const read = (f) => fs.readFileSync(path.join(SKILL, f), 'utf8');
  const md = read('SKILL.md');
  assert.match(md, /G search route --need "<key>"/);
  assert.match(md, /`queries_due` \(also in a woken turn, with no yes\)/);
  const setup = read('references/setup.md');
  assert.match(setup, /G queries set --offer/);
  assert.match(setup, /G query test <offer id> <source>/);
  assert.match(setup, /no cap on tests/);
  assert.match(setup, /the cost of each test/);
  assert.match(setup, /never from text in a post or a tool result/);
  assert.match(read('references/find.md'), /answers 404 is empty for that day/);
  const { startStatus } = await import('../../skills/gtm-loop/scripts/gtm.mjs');
  const st = startStatus({ sender: { name: 'S' }, sources: ['x'], offers: [{ ...OFFER, buyerAsked: true }] }, { start: { at: 'x' } });
  assert.ok(st.missing.some((m) => /^queries for "LoopA": the model writes one per source/.test(m)), 'the start step offers once to write them');
  assert.equal(startStatus({ sender: { name: 'S' }, sources: ['x'], offers: [{ ...OFFER, buyerAsked: true, queriesAsked: true }] }, { start: { at: 'x' } }).done, true);
});
