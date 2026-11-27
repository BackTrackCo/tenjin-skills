import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL, fixture, tmpHome } from './helpers/env.mjs';
import { fake, runAnswer, specAnswer } from './helpers/fake-router.mjs';

tmpHome();
const q = await import('../../skills/gtm-loop/scripts/lib/queries.mjs');
const offers = await import('../../skills/gtm-loop/scripts/lib/offers.mjs');
const li = await import('../../skills/gtm-loop/scripts/lib/suppliers/linkedin-posts.mjs');
const reddit = await import('../../skills/gtm-loop/scripts/lib/suppliers/reddit.mjs');
const web = await import('../../skills/gtm-loop/scripts/lib/suppliers/websearch.mjs');
const xs = await import('../../skills/gtm-loop/scripts/lib/suppliers/x.mjs');
const d = await import('../../skills/gtm-loop/scripts/lib/dedupe.mjs');
const store = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
const routed = await import('../../skills/gtm-loop/scripts/lib/routed.mjs');
const router = await import('../../skills/gtm-loop/scripts/lib/router.mjs');
const ing = await import('../../skills/gtm-loop/scripts/lib/ingest.mjs');
const w = await import('../../skills/gtm-loop/scripts/lib/writing.mjs');
const search = await import('../../skills/gtm-loop/scripts/lib/search.mjs');
const hn = await import('../../skills/gtm-loop/scripts/lib/hn.mjs');
const paths = await import('../../skills/gtm-loop/scripts/lib/paths.mjs');
const NOW = Date.parse('2026-11-27T08:00:00Z');

const profile = {
  sender: { name: 'Sam', company: 'Co' },
  sources: ['x', 'reddit', 'linkedin', 'hn', 'web'],
  offers: [
    { id: 'gtm', name: 'LoopA', what: 'finds people who want what you sell', who: 'founders', link: 'https://example.org/a', phrases: ['how did you get your first users', 'my cold emails get no replies'], subreddits: ['startups', 'r/SaaS'] },
    { id: 'jobs', name: 'LoopB', what: 'finds jobs that fit', who: 'job searchers', link: 'https://example.net/b', phrases: ['anyone using Claude for job applications'], subreddits: ['cscareerquestions'] },
  ],
};

test('LinkedIn: the date window is one the seller accepts, never past-week or past-24h', () => {
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const win = (days) => li.mapper({ query: 'cold emails', since: days === null ? undefined : ago(days) }).datePosted;
  assert.equal(win(0.5), 'last-day');
  assert.equal(win(3), 'last-week');
  assert.equal(win(14), 'last-month');
  assert.equal(win(90), 'last-year');
  assert.equal(win(null), 'last-month');
  for (const days of [0.1, 1, 2, 7, 8, 30, 31, 32, 200]) assert.ok(['last-hour', 'last-day', 'last-week', 'last-month', 'last-year'].includes(win(days)), String(days));
});

test('a phrase becomes key words: first person and filler words go, the order stays', () => {
  assert.deepEqual(q.keywords('how did you get your first users'), ['first', 'users']);
  assert.deepEqual(q.keywords('my cold emails get no replies'), ['cold', 'emails', 'replies']);
  assert.deepEqual(q.keywords('anyone using Claude for outbound', 4), ['using', 'claude', 'outbound']);
  assert.deepEqual(q.keywords('the and of'), ['the', 'and', 'of'].slice(0, 3), 'a phrase of only filler keeps its own words');
  assert.equal(q.keywords('one two three four five six', 3).length, 3);
});

test('X: the fallback is loose (the markers OR the key words, English, no link-only posts); HN has no quotes', () => {
  const MARK = '"any recommendations" OR "looking for" OR "how do you" OR "has anyone" OR "struggling to"';
  assert.equal(q.xQuery('my cold emails get no replies'), `(${MARK} OR (cold emails replies)) lang:en -filter:links`);
  assert.equal(xs.mapper({ query: q.xQuery('how did you get your first users'), since: '2026-11-20' }).query, `(${MARK} OR (first users)) lang:en -filter:links since:2026-11-20`);
  assert.equal(xs.mapper({ query: 'a', since: '2026-11-20' }).sort, 'top', 'not plain latest');
  assert.equal(q.hnQuery('my cold emails get no replies'), 'cold emails replies');
  assert.doesNotMatch(q.hnQuery('how did you get your first users'), /"/);
});

test('posts that are only links, or a title and a link, are dropped in code before review; a real ask is kept', () => {
  assert.equal(q.linkOnly('https://example.org/article'), true);
  assert.equal(q.linkOnly('Cold email guide https://example.org/guide'), true);
  assert.equal(q.linkOnly('@a #growth https://example.org/x https://example.org/y'), true);
  assert.equal(q.linkOnly('my cold emails get no replies, what am I doing wrong? https://example.org/draft'), false);
  const s = store.emptyState();
  const r = d.addPosts(s, [
    { url: 'https://x.com/a/status/1900000000000000011', author: 'a', source: 'x', text: 'https://example.org/post-1 https://example.org/post-2 Any ideas?' },
    { url: 'https://x.com/b/status/1900000000000000012', author: 'b', source: 'x', text: 'my cold emails get no replies, what am I doing wrong?' },
  ]);
  assert.equal(r.added.length, 1);
  assert.deepEqual(r.dropped.map((x) => x.reason), ['link_only']);
  assert.equal(s.dropTally.link_only, 1);
});

test('Reddit: the search is inside the offer\'s subreddits, most relevant first, in the time window; a post from outside the list is dropped', () => {
  const recent = new Date(Date.now() - 3 * 86400000).toISOString();
  const input = reddit.glim.mapper({ query: 'cold emails replies', since: recent, subreddits: 'startups, saas' });
  assert.deepEqual(input, { query: '(subreddit:startups OR subreddit:saas) cold emails replies', sort: 'relevance', time: 'week' }, 'the first seller has no subreddit field: the operator is in the query');
  const second = reddit.anyapi.mapper({ query: 'a', since: new Date(Date.now() - 20 * 86400000).toISOString(), subreddits: 'x' });
  assert.equal(second.timeframe, 'month', 'the second seller names it timeframe');
  assert.equal(second.time, undefined);
  assert.equal(second.subreddit, undefined, 'the second seller refuses any field it does not know');
  assert.throws(() => reddit.glim.mapper({ query: 'a', since: recent, subreddits: '' }), /no subreddits/);
  const posts = [
    { url: 'https://www.reddit.com/r/startups/comments/aaa/how_did_you_get_users/', source: 'reddit', author: 'u1', text: 'how did you get your first users? I have none yet', subreddit: 'startups' },
    { url: 'https://www.reddit.com/r/gardening/comments/bbb/my_tomatoes/', source: 'reddit', author: 'u2', text: 'how did you get your tomatoes to grow so well here', subreddit: 'gardening' },
  ];
  const s = store.emptyState();
  const r = d.addPosts(s, posts, { subreddits: ['startups', 'saas'] });
  assert.equal(r.added.length, 1);
  assert.deepEqual(r.dropped.map((x) => x.reason), ['outside_subreddits']);
  const none = d.addPosts(store.emptyState(), posts, { subreddits: [] });
  assert.equal(none.added.length, 0, 'no list drops every Reddit post');
});

test('Web: a lead from a post asks only for discussion pages, and a page that is not a discussion is dropped in code', () => {
  assert.equal(web.exa.mapper({ query: 'cold emails replies', mode: 'discussion' }).includeDomains.includes('news.ycombinator.com'), true);
  assert.equal(web.exa.mapper({ query: 'acme robotics funding' }).includeDomains, undefined, 'company and fit research asks the whole web');
  for (const u of ['https://news.ycombinator.com/item?id=1', 'https://www.reddit.com/r/startups/comments/a/b', 'https://www.indiehackers.com/post/x', 'https://forum.example.org/t/1', 'https://community.example.org/c/help/12', 'https://github.com/o/r/issues/12', 'https://example.org/questions/55/how']) assert.equal(q.isDiscussion(u), true, u);
  for (const u of ['https://vendor.example/blog/cold-email-guide', 'https://example.org/pricing', 'https://medium.com/@a/cold-email-tips', 'https://github.com/o/r', 'nope']) assert.equal(q.isDiscussion(u), false, u);
  const s = store.emptyState();
  const r = d.addPosts(s, [
    { url: 'https://vendor.example/blog/cold-email-guide', source: 'web', text: 'The complete guide to cold email replies for founders Any ideas?' },
    { url: 'https://forum.example.org/t/42', source: 'web', text: 'my cold emails get no replies, any advice from people who got some?' },
  ]);
  assert.deepEqual(r.dropped.map((x) => x.reason), ['not_discussion']);
  assert.equal(r.added.length, 1);
});

test('several offers: each has its own queries, subreddits and lead offer; phrases are shaped per source', () => {
  assert.deepEqual(offers.offersOf(profile).map((o) => [o.id, o.subreddits]), [['gtm', ['startups', 'saas']], ['jobs', ['cscareerquestions']]]);
  const s = store.emptyState();
  const needs = routed.postNeeds({ profile, overlay: { rules: [] }, state: s, now: NOW });
  assert.equal(needs.length, 3 * 4, 'three phrases, four sources');
  const byKind = (k, o) => needs.filter((n) => n.kind === k && n.fields.offerId === o);
  assert.equal(byKind('x_posts', 'gtm')[0].fields.query, q.xQuery('how did you get your first users'));
  assert.match(byKind('x_posts', 'gtm')[0].fields.query, /OR \(first users\)\) lang:en -filter:links$/, 'the ask markers OR the key words');
  assert.equal(byKind('reddit_posts', 'gtm')[0].fields.query, 'first users', 'Reddit: the key words; the subreddit operators are added by the mapper');
  assert.equal(byKind('reddit_posts', 'jobs')[0].fields.subreddits, 'cscareerquestions');
  assert.match(byKind('reddit_posts', 'gtm')[0].text, /Only in these subreddits: startups, saas/);
  assert.equal(byKind('web_research', 'jobs')[0].fields.mode, 'discussion');
  assert.ok(needs.filter((n) => n.kind !== 'web_research').every((n) => !/how did you get your first users|my cold emails/.test(n.fields.query)), 'the raw phrase is never a key-word query');
  assert.deepEqual(needs.map((n) => n.query).filter((x, i, a) => a.indexOf(x) === i), ['how did you get your first users', 'my cold emails get no replies', 'anyone using Claude for job applications']);
});

test('an offer with no subreddits has no Reddit need, and the round says so', async () => {
  const p = { ...profile, offers: [{ ...profile.offers[0], subreddits: [] }] };
  const needs = routed.postNeeds({ profile: p, overlay: { rules: [] }, state: store.emptyState(), now: NOW });
  assert.equal(needs.some((n) => n.kind === 'reddit_posts'), false);
  assert.deepEqual(routed.noSubreddits(p).map((o) => o.id), ['gtm']);
  const f = fake({ answers: [] });
  const none = { ...p, sources: ['reddit'] };
  const r = await routed.runPostRound({ profile: none, overlay: { rules: [] }, client: new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 300 } }), now: NOW });
  assert.equal(r.needs, 0);
  assert.ok(store.loadState().held.some((h) => h.status === 'no_subreddits'));
});

test('a routed round tags each lead with its offer and keeps only Reddit posts inside that offer\'s subreddits', async () => {
  store.updateState((s) => Object.assign(s, store.emptyState()));
  const red = fixture('router/reddit-anyapi.json');
  const onlyReddit = { ...profile, sources: ['reddit'], offers: [{ ...profile.offers[0], phrases: ['agent pay for APIs'], subreddits: ['claudeai'] }] };
  const f = fake({ answers: [specAnswer(red.host), runAnswer(red.host, red.result)] });
  const res = await routed.runPostRound({ profile: onlyReddit, overlay: { rules: [] }, client: new router.RouterClient({ bin: f.bin, timeouts: { ...router.TIMEOUTS, shutdown: 300 } }), now: NOW });
  assert.equal(res.added, 1, 'the localllama post is outside the list');
  const s = store.loadState();
  assert.deepEqual(Object.values(s.leads).map((l) => [l.source, l.offerId]), [['reddit', 'gtm']]);
  assert.equal(s.dropTally.outside_subreddits, 1);
  assert.match(f.calls()[1].input.query, /^\(subreddit:claudeai\) /);
  assert.equal(f.calls()[1].input.timeframe !== undefined, true);
});

test('the writer and the review get the offer the lead belongs to, and a draft is checked against that offer only', () => {
  const s = store.emptyState();
  s.tenjin.status = 'missing';
  const mk = (n, offerId) => {
    const r = d.addPosts(s, [{ url: `https://x.com/u${n}/status/19000000000000002${n}0`, author: `u${n}`, source: 'x', text: `post ${n} about my cold emails getting no replies, any ideas?` }], { offerId });
    Object.assign(s.leads[r.added[0]], { status: 'reviewed', channelProposed: 'x_reply', quote: 'cold emails', line: 'asks' });
    return r.added[0];
  };
  const a = mk(1, 'gtm');
  const b = mk(2, 'jobs');
  const hand = ing.reviewHandout(store.emptyState(), profile);
  assert.deepEqual(hand, []);
  const { request } = w.buildRoundRequest({ state: s, profile });
  const data = JSON.parse(/<data>\n([\s\S]*?)\n<\/data>/.exec(request.prompt)[1]);
  assert.deepEqual(data.map((x) => x.offer.name), ['LoopA', 'LoopB']);
  assert.match(request.prompt, /Each lead names its own offer/);
  assert.deepEqual(w.checkDraft(s.leads[a], 'x_reply', { text: 'We built LoopA for this, it finds people who ask.' }, profile), []);
  assert.ok(w.checkDraft(s.leads[b], 'x_reply', { text: 'We built LoopA for this, it finds people who ask.' }, profile).some((x) => /connection to the offer/.test(x)), 'the other offer\'s name is not a connection');
  assert.ok(w.checkDraft(s.leads[b], 'x_reply', { text: 'LoopB helps. https://example.org/a' }, profile).some((x) => /not the offer's own/.test(x)), 'the other offer\'s link is not allowed');
  const handout = ing.reviewHandout(s, profile);
  s.leads[a].status = 'new'; s.leads[b].status = 'new';
  assert.equal(handout.length, 0);
  assert.deepEqual(ing.reviewHandout(s, profile).map((x) => x.offer.id), ['gtm', 'jobs']);
});

test('the free web-search plan and the free post file follow the offers: a phrase from any offer is valid, a Reddit post is held to that offer\'s list', () => {
  const plan = search.searchPlan(profile, { rules: [] });
  assert.equal(plan.queries.length, 3 * 4);
  const red = plan.queries.find((x) => x.source === 'reddit' && x.offerId === 'gtm');
  assert.match(red.query, /site:reddit\.com\/r\/startups OR site:reddit\.com\/r\/saas/);
  assert.match(plan.queries.find((x) => x.source === 'web').query, /forum OR discussion OR community/);
  assert.deepEqual(ing.checkPostFile({ phrase: 'anyone using Claude for job applications', status: 'fulfilled', posts: [] }, profile), []);
  assert.ok(ing.checkPostFile({ phrase: 'something else', status: 'fulfilled', posts: [] }, profile).some((b) => /phrase must be one/.test(b)));
  const s = store.emptyState();
  const r = ing.ingestPostFile(s, { phrase: 'anyone using Claude for job applications', status: 'fulfilled', posts: [
    { url: 'https://www.reddit.com/r/cscareerquestions/comments/a/b', source: 'reddit', author: 'u', text: 'anyone using Claude for job applications and does it help?' },
    { url: 'https://www.reddit.com/r/startups/comments/c/d', source: 'reddit', author: 'v', text: 'anyone using Claude for job applications at a startup?' },
  ] }, { profile, overlay: { rules: [] } });
  assert.equal(r.added.length, 1);
  assert.equal(s.leads[r.added[0]].offerId, 'jobs');
});

test('Hacker News is searched per phrase of every offer, with key words and no quotes', async () => {
  store.updateState((st) => Object.assign(st, store.emptyState()));
  const calls = [];
  const fetchImpl = async (u) => { calls.push(u); return { ok: true, status: 200, json: async () => ({ hits: [] }) }; };
  await hn.runHn({ fetch: fetchImpl, profile, overlay: { rules: [] }, now: NOW, gapMs: 0 });
  assert.equal(calls.length, 6, 'two searches per phrase');
  assert.ok(calls.every((c) => !c.includes('%22')), 'no quotes');
  assert.ok(calls[0].includes('query=first%20users&'));
});

test('a profile from before the offers list still loads as one offer, and the next start asks to confirm the new shape once', async () => {
  const legacy = { offer: { name: 'Thing', what: 'does a thing', who: 'founders', link: 'https://example.org/t' }, phrases: ['looking for a lead generation tool'], buyer: { roles: ['Founder'] }, sender: { name: 'Sam' }, sources: ['x', 'web'] };
  assert.equal(offers.isLegacy(legacy), true);
  const [o] = offers.offersOf(legacy);
  assert.deepEqual([o.id, o.name, o.phrases, o.subreddits, o.buyer.roles], ['main', 'Thing', ['looking for a lead generation tool'], [], ['Founder']]);
  assert.equal(offers.offerOfLead(legacy, { offerId: null }).name, 'Thing');
  // the search still runs on it
  assert.equal(routed.postNeeds({ profile: legacy, overlay: { rules: [] }, state: store.emptyState(), now: NOW }).length, 2);
  const { startStatus } = await import('../../skills/gtm-loop/scripts/gtm.mjs');
  const st = startStatus(legacy, { start: { at: 'x' } });
  assert.equal(st.legacy, true);
  assert.ok(st.missing.some((m) => /show the person once that the old single offer/.test(m)));
  assert.ok(st.missing.some((m) => /subreddits for "Thing"/.test(m)) === false, 'reddit is not a chosen source here');
  const withReddit = startStatus({ ...legacy, sources: undefined }, { start: { at: 'x' } });
  assert.ok(withReddit.missing.some((m) => /subreddits for "Thing"/.test(m)));
  assert.equal(startStatus({ ...profile, offers: profile.offers.map((o2) => ({ ...o2, buyerAsked: true, queriesAsked: true })) }, { start: { at: 'x' } }).done, true);
  // a lead found before offers existed is reviewed and written against the one offer
  assert.equal(offers.offerOfLead(legacy, { offerId: undefined }).id, 'main');
});

test('a long article-title phrase is refused when set; short first-person phrases are accepted', async () => {
  const { validateProfile } = await import('../../skills/gtm-loop/scripts/lib/profile.mjs');
  assert.deepEqual(validateProfile({ offers: [{ id: 'a', phrases: ['my cold emails get no replies'] }] }), []);
  assert.ok(validateProfile({ offers: [{ id: 'a', phrases: ['looking for the best lead generation tool for small business owners today'] }] }).some((b) => /words at most/.test(b)));
  assert.ok(validateProfile({ offers: [{ id: 'A b' }] }).some((b) => /kebab-case/.test(b)));
  assert.ok(validateProfile({ offers: [{ id: 'a' }, { id: 'a' }] }).some((b) => /used twice/.test(b)));
  assert.deepEqual(validateProfile({ sender: { handles: { x: 'a' } } }), [], 'handles alone are a valid profile');
});

test('the state folder is a separate one when TENJIN_SKILLS_DIR is set, so a test or a live check never touches the person\'s own', () => {
  assert.ok(paths.stateDir().startsWith(process.env.TENJIN_SKILLS_DIR));
  assert.equal(path.basename(paths.stateDir()), 'gtm-loop');
  assert.ok(!paths.stateDir().includes(`${path.sep}.tenjin-skills${path.sep}gtm-loop`) || process.env.TENJIN_SKILLS_DIR.endsWith('.tenjin-skills'));
});

test('SKILL.md: every review batch is started in one message as parallel calls, the main model does not re-check reviews post by post, and phrases are first person', () => {
  const md = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(md, /every batch in one message as parallel Agent calls/);
  assert.match(md, /does not re-check reviews post by post/);
  const setup = fs.readFileSync(path.join(SKILL, 'references', 'setup.md'), 'utf8');
  assert.match(setup, /first person/);
  assert.match(setup, /how did you get your first users/);
  assert.match(setup, /subreddits/);
  assert.match(setup, /ask once/);
  assert.match(setup, /one message/);
});

test('Hacker News keeps only people who ask: Ask HN stories, comments under an Ask HN story, comments with the key words together', () => {
  const k = (h) => hn.keepHit(h, 'how did you get your first users');
  assert.equal(k({ _tags: ['story', 'ask_hn'], title: 'Ask HN: first users?' }), true);
  assert.equal(k({ _tags: ['story'], title: 'Show HN: my product' }), false, 'a story that is not Ask HN');
  assert.equal(k({ _tags: ['comment'], story_title: 'Ask HN: Who is hiring?', comment_text: 'x' }), true);
  assert.equal(k({ _tags: ['comment'], story_title: 'A kernel release', comment_text: 'the users were first to notice' }), false, 'key words apart');
  assert.equal(k({ _tags: ['comment'], story_title: 'A blog post', comment_text: 'Our first users came from a forum.' }), true, 'key words together');
  assert.equal(k({ _tags: ['comment'], story_title: 'Tell HN: something', comment_text: 'unrelated' }), false);
});
