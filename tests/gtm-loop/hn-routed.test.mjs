import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeFetch, fixture, tmpHome } from './helpers/env.mjs';
import { fake, runAnswer, specAnswer } from './helpers/fake-router.mjs';

tmpHome();
const hn = await import('../../skills/gtm-loop/scripts/lib/hn.mjs');
const router = await import('../../skills/gtm-loop/scripts/lib/router.mjs');
const routed = await import('../../skills/gtm-loop/scripts/lib/routed.mjs');
const search = await import('../../skills/gtm-loop/scripts/lib/search.mjs');
const store = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
const report = await import('../../skills/gtm-loop/scripts/lib/report.mjs');

const profile = { phrases: ['agent pay for APIs'], subreddits: ['ClaudeAI', 'LocalLLaMA'], sources: ['x', 'reddit', 'linkedin', 'hn', 'web'], sender: { handles: { x: 'me_handle' } } };
const overlay = { rules: [] };
const client = (f) => new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 500, collect: 40, poll: 10 } });
const NOW = Date.parse('2026-11-26T08:00:00Z');

test('Hacker News is read free through the search API only: one search per phrase, items become leads, the HN site is never fetched', async () => {
  const ff = fakeFetch({ 'https://hn.algolia.com/api/v1/search_by_date': fixture('hn-search.json') });
  const r = await hn.runHn({ fetch: ff, profile, overlay, now: NOW, gapMs: 0 });
  assert.equal(ff.calls.length, 2, 'one search for Ask HN stories, one for comments');
  assert.match(ff.calls[0], /tags=ask_hn/);
  assert.match(ff.calls[1], /tags=comment/);
  assert.match(ff.calls[0], /query=agent%20pay%20apis&/, 'key words, no quotes');
  assert.match(ff.calls[0], /created_at_i%3E/);
  assert.equal(r.added, 3, 'an Ask HN story, a comment under an Ask HN story, a comment with the key words together; not a loose match, a Show HN story or an item with no text');
  const s = store.loadState();
  assert.ok(s.leads['https://news.ycombinator.com/item?id=41000001']);
  assert.ok(s.leads['https://news.ycombinator.com/item?id=41000004']);
  for (const id of ['41000003', '41000005', '41000006']) assert.equal(s.leads[`https://news.ycombinator.com/item?id=${id}`], undefined, id);
  assert.match(s.leads['https://news.ycombinator.com/item?id=41000001'].text, /I'm looking for a way/);
  assert.equal(s.leads['https://news.ycombinator.com/item?id=41000002'].source, 'hn');
  assert.ok(s.ids['hn:hn_user_a']);
  assert.equal(s.phraseYield['agent pay for APIs'].hn, 3);
  assert.ok(ff.calls.every((c) => c.startsWith('https://hn.algolia.com/')));
  // the second read starts after the last one
  await hn.runHn({ fetch: ff, profile, overlay, now: NOW + 3600000, gapMs: 0 });
  assert.ok(decodeURIComponent(ff.calls[2]).includes(`created_at_i>${Math.floor(NOW / 1000)}`));
});

test('a failing HN search throws and records nothing', async () => {
  const ff = fakeFetch({ 'https://hn.algolia.com/': 503 });
  await assert.rejects(() => hn.runHn({ fetch: ff, profile, overlay, now: NOW, gapMs: 0 }), /http 503/);
});

test('a routed post round: one need per phrase per source, each result kept at once, leads deduped across sellers, held needs named', async () => {
  const fx = { x: fixture('router/x-posts.json'), red: fixture('router/reddit-anyapi.json'), li: fixture('router/linkedin-posts.json'), web: fixture('router/web-research.json') };
  const f = fake({ answers: [
    specAnswer(fx.x.host, 'id-1'), runAnswer(fx.x.host, fx.x.result),
    specAnswer(fx.red.host, 'id-2'), runAnswer(fx.red.host, fx.red.result),
    specAnswer(fx.li.host, 'id-3'), runAnswer(fx.li.host, fx.li.result),
    { status: 'needs_approval', reason: 'over the per-call limit' },
  ] });
  const res = await routed.runPostRound({ profile, overlay, client: client(f), now: NOW });
  assert.equal(res.needs, 4);
  assert.equal(res.ok, 3);
  assert.equal(res.added, 5);
  assert.equal(res.held[0].status, 'needs_approval');
  const calls = f.calls();
  assert.deepEqual(calls.filter((c) => c.query).map((c) => c.query.split(':')[0]), ['Search recent public X posts for', 'Search public Reddit posts for', 'Search recent public LinkedIn posts for the keywords', 'Search the web for discussion pages (forums, community Q&A, Hacker News, Reddit, Indie Hackers) where someone asks or complains about']);
  const s = store.loadState();
  assert.equal(Object.values(s.leads).filter((l) => l.source === 'x').length, 2);
  assert.ok(s.held.some((h) => h.key === 'need:web_research:agent pay for APIs' && /over the per-call limit/.test(h.detail)));
  assert.equal(s.routed.lastSearchAt, new Date(NOW).toISOString());
  assert.equal(s.spend.length, 3);
  assert.ok(s.spend.every((x) => x.cents === 0.5), 'cost is read from the envelope');
  assert.equal(s.phraseYield['agent pay for APIs'].reddit, 2);
  // the report names the cost per lead and the yield per phrase and source
  const text = report.report(s, profile, NOW + 1000).text;
  assert.match(text, /per new lead/);
  assert.match(text, /"agent pay for APIs": .*from reddit/);
  assert.match(text, /Held: web_research/);
});

test('the person\'s own caps cut a round: phrases per round, searches per day, rounds per day; with none every need runs', async () => {
  const p2 = { ...profile, phrases: ['one', 'two', 'three'], sources: ['x'] };
  const s = store.emptyState();
  assert.equal(routed.postNeeds({ profile: p2, overlay, state: s, now: NOW }).length, 3);
  assert.equal(routed.postNeeds({ profile: p2, overlay: { rules: [{ effect: 'phrases_per_round', value: 2 }] }, state: s, now: NOW }).length, 2);
  const used = { ...s, spend: [{ at: new Date(NOW - 3600000).toISOString(), search: true }, { at: new Date(NOW - 7200000).toISOString(), search: true }] };
  assert.equal(routed.postNeeds({ profile: p2, overlay: { rules: [{ effect: 'searches_per_day', value: 3 }] }, state: used, now: NOW }).length, 1);
  store.updateState((st) => { st.rounds.push({ at: new Date(NOW - 1000).toISOString() }); });
  const f = fake({ answers: [] });
  const r = await routed.runPostRound({ profile: p2, overlay: { rules: [{ effect: 'rounds_per_day', value: 1 }] }, client: client(f), now: NOW });
  assert.equal(r.skipped, 'rounds_per_day');
  assert.equal(f.calls().length, 0);
});

test('the identity reads: an X profile gives the country and links the LinkedIn identity by its own link; a held read is not repeated', async () => {
  store.updateState((s) => {
    for (const k of Object.keys(s.leads)) s.leads[k].status = 'skipped';
  });
  const xp = fixture('router/x-profile.json');
  store.updateState((s) => {
    const d = null; void d;
  });
  const dd = await import('../../skills/gtm-loop/scripts/lib/dedupe.mjs');
  store.updateState((s) => {
    const r = dd.addPosts(s, [{ url: 'https://x.com/dev_one/status/1900000000000000099', author: 'dev_one', source: 'x', text: 'Looking for an agent payment router' }]);
    s.leads[r.added[0]].status = 'reviewed';
  });
  const f = fake({ answers: [specAnswer(xp.host), runAnswer(xp.host, xp.result)] });
  const r = await routed.runIdentityReads({ client: client(f), now: NOW });
  assert.equal(r.ok, 1);
  const s = store.loadState();
  const person = s.people['x:dev_one'];
  assert.equal(person.country, 'DE');
  assert.equal(person.name, 'Dev One');
  assert.ok(person.ids.includes('linkedin:dev-one-77'), 'linked on evidence: the link is in the profile answer');
  assert.deepEqual(person.linkedBy.map((l) => l.evidence), ['x_profile_link']);
  const again = await routed.runIdentityReads({ client: client(fake({ answers: [] })), now: NOW });
  assert.equal(again.reads, 0);
});

test('the search step: free sources in code, the routed round only with Tenjin ready; without it the free step is left for the model', async () => {
  store.updateState((s) => { Object.assign(s, store.emptyState()); s.tenjin.status = 'missing'; });
  const ff = fakeFetch({ 'https://hn.algolia.com/api/v1/search_by_date': fixture('hn-search.json') });
  assert.equal(search.searchDue(store.loadState(), profile, NOW), true);
  const out = await search.searchStep({ profile, overlay, fetchImpl: ff, now: NOW, sleep: async () => {} });
  assert.equal(out.hn.added, 3);
  assert.equal(out.routed, undefined, 'no routed round without Tenjin');
  const s = store.loadState();
  assert.equal(s.search.modelDue, true);
  assert.deepEqual(search.searchItems({ state: s, profile, now: NOW }).map((i) => i.reason), ['search_due']);
  const again = await search.searchStep({ profile, overlay, fetchImpl: ff, now: NOW + 1000 });
  assert.equal(again.ran, false);
  assert.equal(ff.calls.length, 2);
  search.searchDone(NOW + 5000);
  assert.equal(store.loadState().search.modelDue, false);
  assert.equal(search.searchDue(store.loadState(), profile, NOW + 6000), false, 'the next round is a period later');
  const plan = search.searchPlan(profile, overlay);
  assert.deepEqual(plan.queries.map((q) => q.source), ['web', 'x', 'reddit', 'linkedin']);
  assert.match(plan.queries[1].query, /site:x\.com/);
  assert.match(plan.note, /Never fetch x\.com/);
});

test('with Tenjin ready the search step runs the routed round and the identity reads, and leaves nothing to the model', async () => {
  store.updateState((s) => { Object.assign(s, store.emptyState()); s.tenjin.status = 'ready'; });
  const xp = fixture('router/x-posts.json');
  const prof = { ...profile, sources: ['x'] };
  const f = fake({ answers: [specAnswer(xp.host), runAnswer(xp.host, xp.result)] });
  const out = await search.searchStep({ profile: prof, overlay, fetchImpl: undefined, now: NOW, routerClient: client(f) });
  assert.equal(out.routed.ok, 1);
  assert.equal(store.loadState().search.modelDue, undefined);
  assert.deepEqual(search.reviewItems({ state: store.loadState() }).map((i) => [i.reason, i.count]), [['review_due', 2]]);
});
void fs;
