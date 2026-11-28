import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL, tmpHome } from './helpers/env.mjs';
import { fakeBins } from './helpers/fakebin.mjs';

tmpHome();
const q = await import('../../skills/gtm-loop/scripts/lib/queries.mjs');
const d = await import('../../skills/gtm-loop/scripts/lib/dedupe.mjs');
const store = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
const ing = await import('../../skills/gtm-loop/scripts/lib/ingest.mjs');
const rep = await import('../../skills/gtm-loop/scripts/lib/report.mjs');
const offers = await import('../../skills/gtm-loop/scripts/lib/offers.mjs');
const o = await import('../../skills/gtm-loop/scripts/lib/outreach.mjs');
const open = await import('../../skills/gtm-loop/scripts/lib/open.mjs');

test('a post is an ask when its own text has a short first-person question or a request marker; announcements, pitches and essays are not', () => {
  const asks = [
    'Anyone know how to get my first users?',
    'How do you get replies to cold emails when nobody answers?',
    'Looking for a way to let my agent pay for APIs.',
    "I'm struggling to get anyone to answer my cold emails",
    'Any recommendations for a tool that finds leads',
    'Has anyone used Claude for outbound sales',
    'I need a way to follow up without being annoying',
    'Wish my agent could pay for APIs by itself.',
    'Is there a service that does this',
  ];
  const notAsks = [
    'We just launched our new product. Sign up today and grow your business.',
    'Ready to grow your business? Our platform helps you scale. Book a demo today.',
    'What would you do with an extra 10 hours a week? Our tool gives them back.',
    '7 rules I gave my AI after its mistakes cost me. Each rule came from a real failure.',
    'A study of 58 companies found only 2 where AI fully eliminated a job.',
    `Anyone know how to do this? ${'filler words '.repeat(80)}`,
  ];
  for (const t of asks) assert.equal(q.isAsk(t), true, t);
  for (const t of notAsks) assert.equal(q.isAsk(t), false, t);
  assert.ok(q.REQUEST_MARKERS.length >= 8, 'the list is in code');
});

test('the fallback query is loose on purpose: it keeps the ask markers or the key words, never both, and no negations', () => {
  const x = q.xQuery('my cold emails get no replies');
  for (const m of q.ASK_MARKERS) assert.ok(x.includes(`"${m}"`), m);
  assert.match(x, /OR \(cold emails replies\)\) lang:en -filter:links$/);
  assert.doesNotMatch(x, /-"|retweets|replies -/);
  assert.equal(q.redditQuery('how did you get your first users'), 'first users', 'no marker group for Reddit');
  assert.equal(q.hnQuery('how did you get your first users'), 'first users', 'Hacker News is narrowed by the Ask HN tag, not by markers');
});

test('a post with no ask shape is dropped in code before review, and the drop is counted and shown in the report', () => {
  const s = store.emptyState();
  const r = d.addPosts(s, [
    { url: 'https://x.com/a/status/1900000000000000101', author: 'a', source: 'x', text: 'We just launched our new agent platform, sign up today for early access' },
    { url: 'https://x.com/b/status/1900000000000000102', author: 'b', source: 'x', text: 'Anyone know how to let my agent pay for APIs?' },
    { url: 'https://www.linkedin.com/posts/c_activity-1-ab', author: 'c', source: 'linkedin', text: '7 lessons from building a startup. Lesson one: ship early. Lesson two: talk to users.' },
  ]);
  assert.equal(r.added.length, 1);
  assert.deepEqual(r.dropped.map((x) => x.reason), ['not_an_ask', 'not_an_ask']);
  assert.equal(s.dropTally.not_an_ask, 2);
  assert.match(rep.report(s, {}, Date.now()).text, /Dropped before review by code filters, all time: not an ask 2\./);
});

test('a discussion page with no date is not rejected: it is shown as undated, with its way to reply', () => {
  const s = store.emptyState();
  const r = d.addPosts(s, [{ url: 'https://forum.example.org/t/77', author: '', source: 'web', text: 'How do you get replies to cold emails when nobody answers?' }]);
  assert.equal(r.added.length, 1);
  const [h] = ing.reviewHandout(s, {});
  assert.equal(h.dated, false);
  assert.equal(h.reply, 'the person opens the page and answers there');
  assert.deepEqual(h.channels, ['web_reply', 'email']);
  const review = { reviews: [{ key: h.key, fit: 70, intent: 80, timing: 40, quote: 'How do you get replies to cold emails', line: 'Asks how to get replies; undated page', channel: 'web_reply', keep: true }] };
  assert.deepEqual(ing.checkReview(review, s), [], 'a page with no date is reviewable and keepable');
  ing.applyReview(s, review, { overlay: { rules: [] } });
  assert.equal(s.leads[h.key].status, 'reviewed');
});

test('a reply on a discussion page opens that page in the person\'s own Chrome with the text on the clipboard; only a link that passes the open checks', () => {
  assert.equal(open.checkOpenUrl('https://forum.example.org/t/77'), 'only X, LinkedIn, Reddit and Hacker News pages open');
  assert.equal(open.checkOpenUrl('https://forum.example.org/t/77', { web: true }), null);
  assert.notEqual(open.checkOpenUrl('http://forum.example.org/t/77', { web: true }), null);
  assert.notEqual(open.checkOpenUrl('https://127.0.0.1/t/1', { web: true }), null);
  assert.notEqual(open.checkOpenUrl('https://user:pw@forum.example.org/t/1', { web: true }), null);
  const bins = fakeBins();
  const r = open.openPage('https://forum.example.org/t/77', { web: true, env: bins.env });
  assert.equal(r.ok, true);
  assert.deepEqual(bins.opened(), ['https://forum.example.org/t/77']);
  assert.equal(open.openPage('https://forum.example.org/t/77', { env: bins.env }).ok, false, 'without the web flag the four sites only');
  const s = store.emptyState();
  const p = d.resolvePerson(s, ['web:someone']);
  const lead = { key: 'L', url: 'https://forum.example.org/t/77', source: 'web', personKey: p.key, status: 'picked', pick: { channel: 'web_reply' }, drafts: { web_reply: { text: 'We built LoopA for this.' } } };
  s.leads.L = lead;
  const plan = o.openPlan(s, 'L');
  assert.deepEqual([plan.channel, plan.url], ['web_reply', 'https://forum.example.org/t/77']);
  assert.equal(o.CHANNEL_LABEL.web_reply, 'Reply on the page');
  assert.ok(o.SOCIAL.includes('web_reply'));
});

test('the report drops held lines for phrases and offers that no longer exist, and shows how many were skipped and why', () => {
  const profile = { offers: [{ id: 'gtm', name: 'LoopA', phrases: ['my cold emails get no replies'], subreddits: [] }] };
  const s = store.emptyState();
  s.held = [
    { key: 'need:x_posts:an old phrase', reason: 'need_held', detail: 'x_posts (an old phrase): refused' },
    { key: 'need:x_posts:my cold emails get no replies', reason: 'need_held', detail: 'x_posts (my cold emails get no replies): refused' },
    { key: 'need:reddit_posts:old-offer', reason: 'need_held', detail: 'reddit_posts (old-offer): no subreddits' },
    { key: 'need:reddit_posts:gtm', reason: 'need_held', detail: 'reddit_posts (LoopA): no subreddits' },
    { key: 'need:people_search:acme.example', reason: 'need_held', detail: 'people_search (acme.example): over budget' },
    { reason: 'source_empty', detail: 'fit: x' },
  ];
  s.leads.a = { key: 'a', status: 'skipped', skipReason: 'not_a_real_ask', firstSeen: 'x' };
  s.leads.b = { key: 'b', status: 'skipped', skipReason: 'not_a_real_ask', firstSeen: 'x' };
  s.leads.c = { key: 'c', status: 'skipped', skipReason: 'below_min_score', firstSeen: 'x' };
  const text = rep.report(s, profile, Date.now()).text;
  assert.doesNotMatch(text, /an old phrase|old-offer/);
  assert.match(text, /Held: x_posts \(my cold emails get no replies\)/);
  assert.match(text, /Held: reddit_posts \(LoopA\)/);
  assert.match(text, /Held: people_search \(acme\.example\)/);
  assert.match(text, /Skipped: 3 \(not a real ask 2, below min score 1\)\./);
  assert.equal(offers.liveHeld(s.held, profile).length, 4);
});

test('the review rules in the text say so: an undated page is shown as undated, and a discussion page has a public way to reply', () => {
  const md = fs.readFileSync(path.join(SKILL, 'references', 'review.md'), 'utf8');
  assert.match(md, /undated/);
  assert.match(md, /public way to reply/);
  assert.match(md, /web_reply/);
  assert.match(md, /not a reason to leave a lead/);
});
