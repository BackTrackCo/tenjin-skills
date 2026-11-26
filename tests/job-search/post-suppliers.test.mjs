import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, mkJob, tmpHome } from './helpers/env.mjs';

tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const sup = await import(`${S}suppliers/index.mjs`);
const routed = await import(`${S}routed.mjs`);
const router = await import(`${S}router.mjs`);
const net = await import(`${S}net.mjs`);
const rj = (f) => JSON.parse(fs.readFileSync(path.join(FIX, 'router', f), 'utf8'));
const LSEARCH = rj('linkedin-search-posts.json');
const LAUTHOR = rj('linkedin-author-posts.json');
const XSEARCH = rj('x-search.json');
const NOW = Date.parse('2026-11-25T12:00:00Z');
const empty = { rules: [], lessons: [] };

test('the LinkedIn post search adapter keeps the post link, a short text, links in the text and no counts or author names; one page, the cursor is not followed', () => {
  const s = sup.pickTool('anyapi-linkedin-search-posts', 'event_posts_linkedin');
  assert.ok(s && s.host === 'api.getanyapi.com');
  assert.deepEqual(s.mapper({ company: 'Placeholder Co' }), { query: '"Placeholder Co" (meetup OR talk OR hackathon OR "office hours" OR "demo day")', datePosted: 'last-month' });
  assert.throws(() => s.mapper({}), /no company/);
  const r = s.adapter(LSEARCH);
  assert.equal(r.posts.length, 2);
  assert.deepEqual(r.posts[0].links, ['https://luma.com/placeholder-meetup']);
  assert.equal(r.posts[0].author, 'placeholder-author-a');
  assert.equal(r.more, true);
  assert.deepEqual(Object.keys(r.posts[0]).sort(), ['author', 'links', 'postedAt', 'source', 'text', 'url']);
  assert.doesNotMatch(JSON.stringify(r), /Placeholder Author|reaction|comment/i);
  assert.deepEqual(s.adapter({ output: { found: false } }).posts, []);
  assert.throws(() => s.adapter({ output: { found: true, data: {} } }), /no posts list/);
  assert.throws(() => s.adapter({ output: { found: true, data: { posts: [{ url: 'x' }] } } }), /no url or text/);
});

test('the author posts adapter takes a profile link only, joins a repost text and keeps the article link', () => {
  const s = sup.pickTool('anyapi-linkedin-author-posts', 'event_posts_people');
  assert.deepEqual(s.mapper({ url: 'https://www.linkedin.com/in/placeholder-person/' }), { url: 'https://www.linkedin.com/in/placeholder-person/' });
  for (const bad of ['https://example.test/in/x', 'https://www.linkedin.com/company/acme', '', 'http://www.linkedin.com/in/x']) assert.throws(() => s.mapper({ url: bad }), /not a LinkedIn profile link/, bad);
  const r = s.adapter(LAUTHOR);
  assert.deepEqual(r.posts[0].links, ['https://luma.com/placeholder-demo']);
  assert.match(r.posts[0].text, /original post text/);
  assert.deepEqual(r.posts[1].links, ['https://example.test/article']);
  assert.equal(r.more, true);
  assert.doesNotMatch(JSON.stringify(r), /Placeholder Person|reactions|engagement/i);
});

test('the X search shape is picked by its host for both X needs; the glim.sh supplier still wins on its own host', () => {
  const anyapi = 'POST https://api.getanyapi.com/v1/run/twitter.search';
  for (const kind of ['x_hiring_posts', 'event_posts_x']) {
    const s = sup.pickSupplier(anyapi, kind);
    assert.ok(s, `${kind} is not held as no_adapter`);
    assert.equal(s.host, 'api.getanyapi.com');
    const input = s.mapper({ role: 'engineer', place: 'San Francisco, CA', company: 'Placeholder Co', since: '2026-11-25' });
    assert.equal(input.queryType, 'Latest');
    assert.match(input.query, /since:2026-11-25/);
    assert.deepEqual(Object.keys(input).sort(), ['query', 'queryType']);
    const r = s.adapter(XSEARCH);
    assert.deepEqual(r.posts.map((p) => p.url), ['https://x.com/placeholder_user/status/1', 'https://x.com/placeholder_user/status/2']);
    assert.deepEqual(r.posts[0].links, ['https://luma.com/placeholder-hack']);
    assert.equal(r.posts[0].author, 'placeholder_user');
    assert.equal(r.posts[0].source, 'x');
    assert.throws(() => s.adapter({ output: { found: true, data: {} } }), /no items list/);
    assert.equal(sup.pickSupplier('POST https://glim.sh/x/search', kind).host, 'glim.sh');
  }
});

function fakeRouter(log) {
  const specs = { 'anyapi-linkedin-search-posts': ['o-ls', LSEARCH], 'anyapi-linkedin-author-posts': ['o-la', LAUTHOR] };
  const byOffer = { 'o-ls': LSEARCH, 'o-la': LAUTHOR, 'o-x': XSEARCH };
  return {
    timeouts: router.TIMEOUTS,
    async start() {},
    async close() {},
    async request(args) {
      log.push(args);
      if (args.tool && specs[args.tool]) return { status: 'spec', id: specs[args.tool][0], __text: 'POST https://api.getanyapi.com/v1/run' };
      if (args.tool) return { status: 'spec', id: 'o-web', __text: 'web' };
      if (typeof args.query === 'string') return { status: 'spec', id: 'o-x', __text: 'POST https://api.getanyapi.com/v1/run/twitter.search' };
      if (args.id === 'o-web') return { status: 'fulfilled', supplier: 'api.exa.ai', result: JSON.stringify({ results: [] }), cost: ['x'] };
      return { status: 'fulfilled', supplier: 'api.getanyapi.com', result: JSON.stringify(byOffer[args.id]), cost: ['x'] };
    },
  };
}

test('routeEvents runs the LinkedIn post search and the key people\'s posts by tool id, one page each; the event is confirmed on its own page and the post text stays a short quote', async () => {
  store.updateState((s) => {
    Object.assign(s, store.emptyState());
    const j = mkJob({ key: 'https://jobs.site.test/ph/jobs/1', status: 'apply_ready', company: 'Placeholder Co', title: 'Engineer', city: 'San Francisco', employerPosting: { url: 'https://jobs.site.test/ph/jobs/1', system: 'employer_site', token: null, jobId: null, source: 'careers_page', confidence: 'confirmed' } });
    s.jobs[j.key] = j;
    s.contacts[j.key] = [
      { name: 'Person A', title: 'CTO', sourceUrl: 'https://www.linkedin.com/in/placeholder-person/', how: 'LinkedIn', cares: 'x', channel: 'linkedin' },
      { name: 'Person B', title: 'CEO', sourceUrl: 'https://example.test/not-linkedin', how: 'web', cares: 'x', channel: 'web' },
    ];
  });
  const log = [];
  const fetched = [];
  const page = (u) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Event', name: `Placeholder Co ${u.split('/').pop()}`, url: u, startDate: '2026-12-03T17:00:00.000-08:00', eventStatus: 'https://schema.org/EventScheduled', location: { '@type': 'Place', name: 'San Francisco, CA' }, organizer: [{ '@type': 'Organization', name: 'Placeholder Co' }] })}</script></head></html>`;
  const f = async (url) => { fetched.push(url); return { ok: true, status: 200, text: async () => page(url) }; };
  const r = await routed.routeEvents({ profile: { search: { place: 'San Francisco, CA' }, events: true }, overlay: empty, client: fakeRouter(log), fetch: f, sleep: async () => {}, now: NOW });
  assert.ok(r.added >= 1, JSON.stringify(r));
  const tools = log.filter((a) => a.tool).map((a) => a.tool);
  assert.equal(tools.filter((t) => t === 'anyapi-linkedin-search-posts').length, 1);
  assert.equal(tools.filter((t) => t === 'anyapi-linkedin-author-posts').length, 1, 'one need per LinkedIn profile link, none for the other contact');
  const runs = log.filter((a) => a.id && a.input);
  assert.ok(runs.every((a) => !('cursor' in a.input)), 'no cursor: one page per need per round');
  assert.deepEqual(runs.find((a) => a.id === 'o-la').input, { url: 'https://www.linkedin.com/in/placeholder-person/' });
  const items = Object.values(store.loadState().events.items);
  assert.deepEqual(items.map((i) => i.event.url).sort(), ['https://luma.com/placeholder-demo', 'https://luma.com/placeholder-hack', 'https://luma.com/placeholder-meetup']);
  assert.ok(items.every((i) => i.event.pageConfirmed && i.event.quote && i.event.quote.length <= 200));
  assert.ok(fetched.every((u) => /^https:\/\/luma\.com\/[A-Za-z0-9_-]+$/.test(u)), 'only event pages are read, never a LinkedIn page');
  assert.doesNotMatch(JSON.stringify(fetched), /linkedin/);
  for (const u of fetched) assert.doesNotThrow(() => net.assertEventRead(u));
});

test('the X search answer for the hiring need goes through the same ingest: the posts are kept for review, text capped', async () => {
  const ingestMod = await import(`${S}ingest.mjs`);
  store.updateState((s) => { Object.assign(s, store.emptyState()); });
  const s = sup.pickSupplier('POST https://api.getanyapi.com/v1/run/twitter.search', 'x_hiring_posts');
  const obj = { need: 'x_hiring_posts', query: { role: 'engineer', place: 'San Francisco, CA', remote: false, since: '2026-11-20' }, status: 'fulfilled', fullResultPath: null, cost: null, ...s.adapter(XSEARCH) };
  await ingestMod.ingest({ obj, state: store.loadState(), profile: { search: { role: 'engineer', place: 'San Francisco, CA' } }, overlay: empty, fetch: async () => ({ ok: false, status: 404, text: async () => '' }), now: NOW });
  const posts = store.loadState().posts || [];
  assert.deepEqual(posts.map((p) => p.url).sort(), ['https://x.com/placeholder_user/status/1', 'https://x.com/placeholder_user/status/2']);
});
