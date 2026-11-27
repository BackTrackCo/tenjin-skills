import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tmpHome } from './helpers/env.mjs';
import { fake, runAnswer, specAnswer } from './helpers/fake-router.mjs';

tmpHome();
const q = await import('../../skills/gtm-loop/scripts/lib/queries.mjs');
const web = await import('../../skills/gtm-loop/scripts/lib/suppliers/websearch.mjs');
const routed = await import('../../skills/gtm-loop/scripts/lib/routed.mjs');
const router = await import('../../skills/gtm-loop/scripts/lib/router.mjs');
const store = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
const rep = await import('../../skills/gtm-loop/scripts/lib/report.mjs');

const offer = { id: 'gtm', name: 'LoopA', who: 'founders and GTM folks', phrases: ['how did you get your first customers'], subreddits: ['startups'] };
const NOW = Date.parse('2026-11-27T08:00:00Z');

test('the web query is a plain description of the post to find: the phrase and who asks, with no quotes and no operators', () => {
  const d = q.webDescription(offer, 'how did you get your first customers');
  assert.equal(d, 'A forum, Q&A or community post where someone asks: how did you get your first customers? The person asking is one of: founders and GTM folks, looking for help.');
  assert.doesNotMatch(d, /["'()]|site:|lang:|-filter|\bOR\b/);
  assert.doesNotMatch(q.webDescription({ who: '"a" OR (b)' }, 'my "cold" emails (OR) fail?'), /["()]|\bOR\b/);
  assert.match(q.webDescription({}, 'anyone using Claude for outbound'), /^A forum, Q&A or community post where someone asks: anyone using Claude for outbound\? The person asking is looking for help\.$/);
  assert.ok(q.webDescription({ who: 'x'.repeat(900) }, 'a phrase').length <= 400);
});

test('a discussion need sends that description, the meaning-based tier and the discussion hosts; research stays on key words and the cheap tier', () => {
  const need = routed.postNeeds({ profile: { offers: [offer], sources: ['web'] }, overlay: { rules: [] }, state: store.emptyState(), now: NOW })[0];
  assert.equal(need.kind, 'web_research');
  assert.equal(need.fields.query, q.webDescription(offer, 'how did you get your first customers'));
  assert.equal(need.fields.mode, 'discussion');
  assert.match(need.text, /the page described here: A forum, Q&A or community post where someone asks/);
  const input = web.exa.mapper(need.fields);
  assert.equal(input.type, 'auto');
  assert.equal(input.query, need.fields.query);
  assert.ok(input.includeDomains.includes('news.ycombinator.com') && input.includeDomains.length <= 20);
  assert.deepEqual(web.exa.mapper({ query: 'acme robotics funding' }), { query: 'acme robotics funding', type: 'lite', numResults: 10 });
});

const RESULTS = { results: [
  { url: 'https://forum.example.org/t/1', title: 'First customers?', text: 'How did you get your first customers? I am a founder with none.', publishedDate: '2026-11-25T10:00:00.000Z' },
  { url: 'https://forum.example.org/t/2', title: 'Old thread', text: 'How did you get your first customers in 2023? Asking for a friend.', publishedDate: '2023-03-01T10:00:00.000Z' },
  { url: 'https://forum.example.org/t/3', title: 'No date', text: 'How did you get your first customers? Any advice from founders here?' },
  { url: 'https://forum.example.org/t/4', title: 'Just outside', text: 'How did you get your first customers? Asked a week ago.', publishedDate: '2026-11-12T23:00:00.000Z' },
] };

test('a result older than the round\'s window is dropped, an undated one is kept as undated, and both are counted', () => {
  const a = web.adapter(RESULTS, { mode: 'discussion', since: '2026-11-13' });
  assert.deepEqual(a.posts.map((p) => p.url), ['https://forum.example.org/t/1', 'https://forum.example.org/t/3']);
  assert.equal(a.droppedOld, 2);
  assert.equal(a.undated, 1);
  assert.equal(a.posts[1].postedAt, null);
  const research = web.adapter(RESULTS, { since: '2026-11-13' });
  assert.equal(research.posts.length, 4, 'company and fit research keeps every result');
  assert.equal(research.droppedOld, 0);
  assert.equal(web.adapter(RESULTS, { mode: 'discussion' }).droppedOld, 0, 'no window, no drop');
});

test('a routed round applies the window to the web result, tallies it and shows the cost per source in the report', async () => {
  store.updateState((s) => Object.assign(s, store.emptyState()));
  const fx = fixture('router/web-research.json');
  const f = fake({ answers: [specAnswer(fx.host), runAnswer(fx.host, RESULTS, { cost: ['provider price 0.007 USD'] })] });
  const profile = { offers: [offer], sources: ['web'] };
  const since = new Date(NOW - 86400000).toISOString().slice(0, 10);
  store.updateState((s) => { s.routed.lastSearchAt = new Date(NOW - 5 * 86400000).toISOString(); });
  const res = await routed.runPostRound({ profile, overlay: { rules: [] }, client: new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 300 } }), now: NOW });
  assert.equal(res.added, 2);
  const call = f.calls()[1].input;
  assert.equal(call.type, 'auto');
  assert.equal(call.includeDomains.includes('reddit.com'), true);
  const s = store.loadState();
  assert.deepEqual(s.webTally, { tooOld: 2, undated: 1 });
  assert.deepEqual(Object.values(s.leads).map((l) => !!l.postedAt).sort(), [false, true]);
  assert.equal(s.spend[0].cents, 0.7);
  assert.ok(since);
  const text = rep.report(s, profile, NOW + 1000).text;
  assert.match(text, /Cost per source, last 7 days: web research 1 search, 0\.7 cents, 0\.7 cents each\./);
  assert.match(text, /Web pages, all time: 2 dropped as older than the window, 1 kept undated\./);
});
