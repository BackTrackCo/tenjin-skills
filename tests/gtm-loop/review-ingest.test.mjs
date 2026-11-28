import test from 'node:test';
import assert from 'node:assert/strict';
import { mkLead, tmpHome } from './helpers/env.mjs';

tmpHome();
const ing = await import('../../skills/gtm-loop/scripts/lib/ingest.mjs');
const store = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
const d = await import('../../skills/gtm-loop/scripts/lib/dedupe.mjs');

const profile = { phrases: ['agent pay for APIs'] };
const file = (posts, o = {}) => ({ need: 'web_search', phrase: 'agent pay for APIs', status: 'fulfilled', posts, ...o });
const P = (n, o = {}) => ({ url: `https://forum.example.org/t/${n}`, author: `user${n}`, source: 'web', text: `Anyone found a way for an agent to pay for APIs? ${n}`, postedAt: '2026-11-25T10:00:00Z', ...o });

test('a post file is checked by shape and every problem is named', () => {
  assert.deepEqual(ing.checkPostFile(file([P(1)]), profile), []);
  const bad = ing.checkPostFile(file([{ url: 'http://x', source: 'myspace', text: '' }], { phrase: 'other', status: 'partial' }), profile);
  assert.ok(bad.some((b) => /status must/.test(b)));
  assert.ok(bad.some((b) => /phrase must be one/.test(b)));
  assert.ok(bad.some((b) => /url must be an https/.test(b)));
  assert.ok(bad.some((b) => /source must be/.test(b)));
  assert.ok(bad.some((b) => /text is required/.test(b)));
  assert.deepEqual(ing.checkPostFile('x'), ['the file must be a JSON object']);
});

test('ingesting a post file adds leads once, counts yield per phrase and source, and honours the leads-per-round cap only as the person\'s rule', () => {
  const s = store.emptyState();
  const r = ing.ingestPostFile(s, file([P(1), P(2), P(1)]), { profile, overlay: { rules: [] } });
  assert.equal(r.added.length, 2);
  assert.equal(r.repeated, 1);
  assert.deepEqual(s.phraseYield['agent pay for APIs'], { web: 2 });
  const t = store.emptyState();
  const capped = ing.ingestPostFile(t, file([P(1), P(2), P(3)]), { profile, overlay: { rules: [{ effect: 'leads_per_round', value: 2 }] } });
  assert.equal(capped.added.length, 2);
  assert.equal(capped.dropped.length, 1);
});

function seeded() {
  const s = store.emptyState();
  d.addPosts(s, [P(1), P(2), P(3, { source: 'x', url: 'https://x.com/user3/status/2000000000031', author: 'user3' })], { profile });
  return s;
}
const review = (s, over = {}) => Object.keys(s.leads).map((key) => ({ key, fit: 70, intent: 90, timing: 40, quote: 'a way for an agent to pay for APIs', line: 'Asks for a way for an agent to pay', channel: s.leads[key].source === 'x' ? 'x_reply' : 'email', keep: true, ...over }));

test('review handout gives every new lead at once, in batches of 25, each with its offer; a file must cover every lead of the batch it touches', () => {
  const s = seeded();
  const hand = ing.reviewHandout(s, { offers: [{ id: 'main', name: 'PayRouter', what: 'lets an agent pay', phrases: ['agent pay for APIs'] }] });
  assert.equal(hand.length, 3);
  assert.deepEqual(hand.find((h) => h.source === 'x').channels, ['x_reply', 'x_dm', 'email']);
  assert.equal(hand[0].offer.name, 'PayRouter');
  assert.deepEqual(ing.checkReview({ reviews: review(s) }, s), []);
  const missing = ing.checkReview({ reviews: review(s).slice(0, 2) }, s);
  assert.ok(missing.some((m) => /same batch and has no review/.test(m)));
  assert.ok(ing.checkReview({ reviews: [] }, s).some((m) => /reviews must be a list with a review/.test(m)));
  const many = store.emptyState();
  d.addPosts(many, Array.from({ length: 30 }, (_, i) => P(100 + i)), { profile });
  const all = ing.reviewHandout(many, profile);
  assert.equal(all.length, 30, 'every lead is handed out, none waits for a later call');
  assert.deepEqual(ing.batchesOf(all).map((b) => b.leads.length), [25, 5]);
  // the second batch can be reviewed alone, in its own file, and the first stays handed out
  const second = all.filter((l) => l.batch === 1).map((l) => ({ key: l.key, fit: 70, intent: 70, timing: 70, quote: 'a way for an agent to pay for APIs', line: 'asks', channel: 'email', keep: true }));
  assert.deepEqual(ing.checkReview({ reviews: second }, many), []);
  const out = ing.applyReview(many, { reviews: second }, { overlay: { rules: [] } });
  assert.equal(many.reviewHand.length, 25);
  assert.deepEqual(ing.summarizeReview(many, out), { kept: 5, left: 0, stopped: 0, dropped_since: 0, left_reasons: {}, still_waiting: 25 });
});

test('the review checks scores, the channel for the source, and that the quote is the post\'s own words', () => {
  const s = seeded();
  ing.reviewHandout(s);
  const base = review(s);
  const bad = ing.checkReview({ reviews: [{ ...base[0], fit: 101 }, { ...base[1], quote: 'words that are not in the post at all' }, { ...base[2], channel: 'reddit_comment' }] }, s);
  assert.ok(bad.some((b) => /fit must be 0 to 100/.test(b)));
  assert.ok(bad.some((b) => /quote must be words that appear in the post/.test(b)));
  assert.ok(bad.some((b) => /channel must be one of/.test(b)));
  assert.ok(ing.checkReview({ reviews: [{ ...base[0], keep: true, channel: null }, base[1], base[2]] }, s).some((b) => /needs a channel/.test(b)));
  assert.ok(ing.checkReview({ reviews: [{ ...base[0], quote: undefined }, base[1], base[2]] }, s).some((b) => /quote is required/.test(b)));
  assert.ok(ing.checkReview({ reviews: [{ ...base[0], key: 'nope' }] }, s).some((b) => /unknown lead/.test(b)));
});

test('applying a review ranks, keeps or skips, honours the person\'s min_score, stops an injection and drops a person suppressed since', () => {
  const s = seeded();
  const keys = Object.keys(s.leads);
  ing.reviewHandout(s);
  d.suppressPerson(s, s.leads[keys[2]].personKey, 'opt_out');
  s.leads[keys[2]].status = 'new'; // suppressPerson already moved it: put it back to prove the review's own check
  const rs = review(s);
  rs[0] = { ...rs[0], fit: 20, intent: 20, timing: 20 };
  rs[1] = { ...rs[1], injection_suspected: true };
  const out = ing.applyReview(s, { reviews: rs }, { overlay: { rules: [{ effect: 'min_score', value: 50 }] } });
  assert.deepEqual(out.skipped, [keys[0]]);
  assert.deepEqual(out.stopped, [keys[1]]);
  assert.deepEqual(out.suppressed, [keys[2]]);
  assert.equal(s.leads[keys[0]].skipReason, 'below_min_score');
  assert.equal(s.leads[keys[1]].status, 'stopped');
  assert.deepEqual(s.reviewHand, []);
  const t = seeded();
  ing.reviewHandout(t);
  const ok = ing.applyReview(t, { reviews: review(t) }, { overlay: { rules: [] } });
  assert.equal(ok.kept.length, 3);
  assert.equal(Object.values(t.leads)[0].status, 'reviewed');
  assert.equal(Object.values(t.leads)[0].scores.avg, 67);
  assert.equal(Object.values(t.leads)[0].channelProposed !== undefined, true);
  const u = seeded();
  ing.reviewHandout(u);
  const mixed = review(u);
  mixed[0] = { ...mixed[0], keep: false };
  mixed[1] = { ...mixed[1], fit: 10, intent: 10, timing: 10 };
  const o2 = ing.applyReview(u, { reviews: mixed }, { overlay: { rules: [{ effect: 'min_score', value: 50 }] } });
  assert.deepEqual(ing.summarizeReview(u, o2).left_reasons, { not_a_real_ask: 1, below_min_score: 1 });
});

test('a fit lead with no recent post is reviewed with no quote and "no signal"', () => {
  const s = store.emptyState();
  const person = d.resolvePerson(s, ['linkedin:pat-lee-123'], { name: 'Pat Lee' });
  d.addFitLead(s, { key: 'fit:acme.example:pat-lee-123', person, source: 'people', text: '' });
  ing.reviewHandout(s);
  assert.deepEqual(ing.checkReview({ reviews: [{ key: 'fit:acme.example:pat-lee-123', fit: 80, intent: 20, timing: 20, quote: null, line: 'no signal', channel: 'linkedin_note', keep: true }] }, s), []);
  assert.ok(ing.checkReview({ reviews: [{ key: 'fit:acme.example:pat-lee-123', fit: 80, intent: 20, timing: 20, quote: 'invented words', line: 'no signal', channel: 'linkedin_note', keep: true }] }, s).some((b) => /no quote/.test(b)));
});
void mkLead;
