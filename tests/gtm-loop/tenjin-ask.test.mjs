import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runGtm, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const G = (...args) => runGtm(home, args);
const store = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
const work = await import('../../skills/gtm-loop/scripts/lib/work.mjs');
const prices = await import('../../skills/gtm-loop/scripts/lib/prices.mjs');
const search = await import('../../skills/gtm-loop/scripts/lib/search.mjs');
const rep = await import('../../skills/gtm-loop/scripts/lib/report.mjs');

const OFFERS = [{ id: 'main', name: 'LoopA', what: 'finds warm leads', who: 'founders', phrases: ['how did you get your first users'], subreddits: ['SaaS'], buyerAsked: true, queriesAsked: true }];

const reset = (tenjin) => {
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'gtm-loop', 'profile.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState(), { tenjin }); });
  G('offers', 'set', '--json', JSON.stringify(OFFERS));
  G('start', 'record', '--email-mode', 'drafts', '--frequency', 'daily', '--sources', 'all');
};

test('tenjinAskDue and tenjinOffer name benefits and costs with no seller names', () => {
  const st = (tenjin) => ({ ...store.emptyState(), tenjin });
  assert.equal(work.tenjinAskDue(st({ status: 'missing' })), true);
  assert.equal(work.tenjinAskDue(st({ status: 'outdated' })), true);
  assert.equal(work.tenjinAskDue(st({ status: 'unfunded' })), true);
  assert.equal(work.tenjinAskDue(st({ status: 'ready' })), false);
  assert.equal(work.tenjinAskDue(st({ status: null })), false);
  assert.equal(work.tenjinAskDue(st({ status: 'missing' }), { unattended: true }), false);

  const offer = prices.tenjinOffer('search', st({ status: 'missing' }), 'daily', { offers: OFFERS });
  assert.match(offer, /Set up Tenjin\?/);
  assert.match(offer, /Live post searches on X, Reddit, LinkedIn and the web/);
  assert.match(offer, /Live query tests during setup/);
  assert.match(offer, /Buyer-fit search/);
  assert.match(offer, /Work-email lookup/);
  assert.match(offer, /cents/);
  assert.doesNotMatch(offer, /\b(glim|anyapi|getanyapi|exa|stableenrich|apollo|icypeas|hunter|scrapecreators|companyenrich|orthogonal|deepseek|neon|gemini)\b/i);

  const unfunded = prices.tenjinOffer('search', st({ status: 'unfunded' }), 'weekly', { offers: OFFERS });
  assert.match(unfunded, /Add funds to Tenjin\?/);
  assert.match(unfunded, /a week/);

  const outdated = prices.tenjinOffer('search', st({ status: 'outdated', version: '0.1.0-alpha.10' }), 'twice_daily', { offers: OFFERS });
  assert.match(outdated, /out of date/);
  assert.match(outdated, /Update Tenjin\?/);
  assert.match(outdated, /two search rounds a day/);
});

test('G search plan asks to install, update or fund Tenjin before handing out free queries, and steers to routed search when ready', () => {
  reset({ status: 'missing' });
  const a = G('search', 'plan').json;
  assert.equal(a.ask, 'tenjin');
  assert.equal(a.moment, 'search');
  assert.equal(a.queries, undefined, 'no free queries before the Tenjin ask is answered');
  assert.equal(a.question.questions[0].options[0].label, 'Set up Tenjin (Recommended)');

  reset({ status: 'unfunded' });
  const u = G('search', 'plan').json;
  assert.equal(u.ask, 'tenjin');
  assert.equal(u.question.questions[0].options[0].label, 'Add funds (Recommended)');

  reset({ status: 'outdated', version: '0.1.0-alpha.20' });
  const o = G('search', 'plan').json;
  assert.equal(o.ask, 'tenjin');
  assert.equal(o.question.questions[0].options[0].label, 'Update Tenjin (Recommended)');

  // Unattended: no ask that blocks, free queries run
  const un = G('search', 'plan', '--unattended').json;
  assert.ok(Array.isArray(un.queries) && un.queries.length > 0);

  // Declining unlocks free fallback and remembers the decline
  assert.equal(G('tenjin', 'ask-done', 'no').code, 0);
  const afterNo = G('search', 'plan').json;
  assert.ok(Array.isArray(afterNo.queries) && afterNo.queries.length > 0);
  assert.equal(afterNo.ask, undefined);

  // Ready: no setup ask, explicitly steers to routed search rather than free-first
  reset({ status: 'ready' });
  const ready = G('search', 'plan').json;
  assert.equal(ready.ask, undefined);
  assert.equal(ready.tenjinReady, true);
  assert.match(ready.note, /routed searches/i);
  assert.equal(G('ask', 'tenjin').json.ready, true);
});

test('G ask tenjin and G start status enforce Tenjin-first when ready and ask-first when unfunded or missing', () => {
  reset({ status: 'unfunded' });
  const ask = G('ask', 'tenjin').json;
  assert.equal(ask.questions[0].options[0].label, 'Add funds (Recommended)');
  assert.match(ask.questions[0].question, /Add funds to Tenjin\?/);
  const stUnfunded = G('start', 'status').json;
  assert.equal(stUnfunded.tenjin, 'unfunded');
  assert.match(stUnfunded.next, /G ask tenjin/);

  reset({ status: 'ready' });
  const stReady = G('start', 'status').json;
  assert.equal(stReady.tenjin, 'ready');
  assert.match(stReady.next, /do not offer a free-only search round first/);
  assert.match(stReady.next, /G search route/);
});

test('saying yes to Tenjin holds free search as tenjin_setup for this period until Tenjin is ready', () => {
  reset({ status: 'missing' });
  store.updateState((s) => { s.search = { modelDue: true, round: 1 }; });
  const before = search.searchItems({ state: store.loadState(), profile: { offers: OFFERS }, now: Date.now() });
  assert.equal(before.length, 1);
  assert.equal(before[0].askTenjin, true);
  assert.ok(before[0].hint);

  assert.equal(G('tenjin', 'ask-done', 'yes').code, 0);
  const s = store.loadState();
  assert.ok(s.held.some((h) => h.reason === 'tenjin_setup'));
  assert.equal(search.searchItems({ state: s, profile: { offers: OFFERS }, now: Date.now() }).length, 0, 'free search is held while waiting for Tenjin setup');
  assert.match(rep.report(s, { offers: OFFERS }).text, /waiting for Tenjin to be ready/);

  // Once Tenjin becomes ready, setupActive ends
  store.updateState((x) => { x.tenjin.status = 'ready'; });
  assert.equal(work.setupActive(store.loadState(), { offers: OFFERS }, Date.now()), false);
});
