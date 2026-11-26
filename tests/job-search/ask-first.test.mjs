import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const work = await import(`${S}work.mjs`);
const report = await import(`${S}report.mjs`);
const empty = { rules: [], lessons: [] };
const NOW = Date.now();
const dir = () => path.join(process.env.TENJIN_SKILLS_DIR, 'job-search');
const J = (...a) => runJobs(home, a);
const reset = (tenjin, jobs = [], extra = {}) => {
  fs.rmSync(path.join(dir(), 'rules.json'), { force: true });
  fs.rmSync(path.join(dir(), 'profile.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState(), { tenjin }, extra); for (const j of jobs) s.jobs[j.key] = j; });
  J('profile', 'set', JSON.stringify({ search: { role: 'software engineer', place: 'Berlin' } }));
};
const noPosting = (i) => mkJob({ key: `https://www.example-jobs.test/view/${i}`, status: 'reviewed', employerPosting: null, openConfirmed: false, unresolved: 'no_board', company: `Co${i}`, employerWebsite: `co${i}.test`, v: 1 });

test('askDue: Tenjin not ready, attended, and the session\'s ask unanswered; one answer clears every moment', () => {
  const st = (tenjin, extra = {}) => ({ ...store.emptyState(), tenjin, ...extra });
  assert.equal(work.askDue(st({ status: 'missing' })), true);
  assert.equal(work.askDue(st({ status: 'outdated' })), true);
  assert.equal(work.askDue(st({ status: 'unfunded' })), true);
  assert.equal(work.askDue(st({ status: 'ready' })), false);
  assert.equal(work.askDue(st({ status: 'missing' }), { unattended: true }), false, 'nobody there: no ask');
  assert.equal(work.askDue(st({ status: 'missing', askedAt: new Date().toISOString() })), false, 'answered this session');
  assert.equal(work.askFirst(st({ status: 'missing' }), 'daily_search').moment, 'daily_search');
  assert.equal(work.askFirst(st({ status: 'ready' }), 'daily_search'), null);
});

test('J search plan prints the ask in place of the free queries until the ask is answered', () => {
  reset({ status: 'missing' });
  const a = J('search', 'plan').json;
  assert.deepEqual([a.ask, a.moment], ['tenjin', 'daily_search']);
  assert.equal(a.queries, undefined, 'no free query is handed out before the ask');
  assert.match(a.hint.line, /^With Tenjin, each search round can also cover job postings from LinkedIn, Indeed and other job boards/);
  assert.equal(a.question.questions[0].options[0].label, 'Set up Tenjin (Recommended)');
  assert.equal(J('search', 'plan').json.ask, 'tenjin', 'still due until answered');
  J('tenjin', 'ask-done', 'no');
  assert.equal(J('search', 'plan').json.queries.length, 5, 'Not now: the free search runs, and no second ask');
  // Tenjin ready: no ask
  reset({ status: 'ready' });
  assert.equal(J('search', 'plan').json.queries.length, 5);
});

test('unattended: no ask that waits, the free path runs', () => {
  reset({ status: 'missing' });
  assert.equal(J('search', 'plan', '--unattended').json.queries.length, 5);
  assert.equal(store.loadState().tenjin.askedHolder, undefined, 'the ask waits for the next attended moment');
});

test('a yes holds the round as tenjin_setup until Tenjin is ready; the next period runs the free path with no new ask', () => {
  reset({ status: 'missing' }, [noPosting(1)]);
  const before = work.buildWorkList(store.loadState(), empty, NOW, { search: { role: 'se' } }).items.map((i) => i.reason).sort();
  assert.deepEqual(before, ['employer_page', 'search_due']);
  assert.equal(J('tenjin', 'ask-done', 'yes').code, 0);
  const s = store.loadState();
  assert.ok(s.held.some((h) => h.reason === 'tenjin_setup'));
  assert.deepEqual(work.buildWorkList(s, empty, NOW, { search: { role: 'se' } }).items, [], 'held: neither the search round nor the careers read runs');
  assert.match(report.renderReport(s, empty, { now: NOW }), /## Waiting for Tenjin/);
  assert.equal(work.askDue(s), false, 'a yes is an answer');
  // ready: the hold ends and the round runs through the router
  store.updateState((x) => { x.tenjin.status = 'ready'; });
  assert.ok(work.buildWorkList(store.loadState(), empty, NOW, { search: { role: 'se' } }).items.some((i) => i.reason === 'search_due'));
  // still not ready at the next period: the free path runs, with its hint and no new ask
  store.updateState((x) => { x.tenjin.status = 'missing'; });
  const next = work.buildWorkList(store.loadState(), empty, NOW + 2 * 86400000, { search: { role: 'se' } });
  assert.ok(next.items.some((i) => i.reason === 'search_due'));
  assert.equal(work.askDue(store.loadState()), false);
});

test('J work prints the ask in place of the careers-page task text; contacts keep their free ways and ask when a job is left with none', () => {
  const j = noPosting(2);
  reset({ status: 'missing' }, [j], { contactsRequested: [j.key] });
  const w = J('work').json;
  const page = w.items.find((i) => i.reason === 'employer_page');
  assert.deepEqual([page.ask.ask, page.ask.moment], ['tenjin', 'employer_posting']);
  assert.equal(page.gate, undefined, 'no free-path task text before the ask');
  const c = w.items.find((i) => i.reason === 'contacts_requested');
  assert.ok(c.gate && !c.ask, 'the free ways come first, with their task text');
  const left = J('leave', `contacts:${j.key}`, '--reason', 'none_found').json;
  assert.deepEqual([left.askTenjin.ask, left.askTenjin.moment], ['tenjin', 'contacts']);
  // answered once: nothing asks again, at any moment
  J('tenjin', 'ask-done', 'no');
  const after = J('work').json.items.find((i) => i.reason === 'employer_page');
  assert.ok(after.gate && !after.ask);
  assert.equal(J('leave', `contacts:${j.key}`, '--reason', 'none_found').json.askTenjin, null);
  // unattended: the free path runs
  reset({ status: 'missing' }, [noPosting(3)]);
  const un = J('work', '--unattended').json.items.find((i) => i.reason === 'employer_page');
  assert.ok(un.gate && !un.ask);
});

test('Tenjin outdated gets the same ask, naming the update', () => {
  reset({ status: 'outdated', version: '0.1.0-alpha.20' });
  const a = J('search', 'plan').json;
  assert.equal(a.ask, 'tenjin');
  assert.equal(a.hint.line, 'Your Tenjin (0.1.0-alpha.20) is out of date. Update it to turn these on again.');
  const l = work.askFirst(store.loadState(), 'linkedin_resume');
  assert.match(l.hint.line, /is out of date/);
});

test('SKILL.md: run a free path only from what those commands printed', () => {
  const skill = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'SKILL.md'), 'utf8');
  assert.match(skill, /only from what `J search plan`, `J resume set --url` and `J work` printed/);
});

// ---- the ask lists everything, with each price ---------------------------------------------------
const graph = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'graph.json'), 'utf8'));
const FIXTURE_FOR = { board_search: ['exa-search', 'step2'], job_postings: ['job-postings', 'step2'], x_hiring_posts: ['x-posts', 'step2'], careers_page: ['careers-page', 'step2'], people_search: ['people-search', 'step2'], company_lookup: ['company-lookup', 'step2'], linkedin_profile: ['linkedin-profile', 'step2'] };

test('each price estimate equals its fixture\'s recorded cost, plus 15% for a routed query only, rounded up to a tenth of a cent', () => {
  assert.equal(graph.prices.checkedAt, '2026-11-25');
  assert.equal(graph.prices.routingFeeShare, 0.15);
  for (const [need, [name, key]] of Object.entries(FIXTURE_FOR)) {
    const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'router', `${name}.json`), 'utf8'));
    const cost = fx[key].envelope.cost[0];
    const usd = Number(/([\d.]+) USD/.exec(cost)[1]);
    const entry = graph.prices.needs[need];
    assert.equal(entry.providerUsd, usd, `${need}: the recorded provider price`);
    const fee = entry.via === 'tool_id' ? 1 : 1.15;
    assert.equal(entry.estimateCents, Math.ceil(usd * 100 * fee * 10 - 1e-9) / 10, `${need}: ${entry.via}, rounded up`);
  }
});

test('a call by catalog tool id carries no routing fee: the board search and the company lookup are the only two', () => {
  const toolId = Object.entries(graph.prices.needs).filter(([, v]) => v.via === 'tool_id').map(([k]) => k).sort();
  assert.deepEqual(toolId, ['board_search', 'company_lookup']);
  assert.equal(graph.prices.needs.board_search.estimateCents, 0.4, 'the provider price, no fee');
  assert.equal(graph.prices.needs.company_lookup.estimateCents, 1.3, '1.225 rounded up to a tenth');
  assert.equal(graph.prices.needs.people_search.estimateCents, 1.2, 'a routed query keeps the 15%');
  for (const [k, v] of Object.entries(graph.prices.needs)) if (v.via !== 'tool_id') assert.equal(v.via, 'routed_query', k);
  assert.match(graph.prices.note, /no routing fee/);
});

test('the hint lines are the approved copy, built from the prices; one line each, once; none for writing', () => {
  assert.equal(work.HINT_LINES.daily_search, 'With Tenjin, each search round can also cover job postings from LinkedIn, Indeed and other job boards, and hiring posts on X, and search company job boards directly, without using your Claude usage. About 1.4¢ a round.');
  assert.equal(work.HINT_LINES.employer_posting, 'With Tenjin, I can look up this company\'s careers page to find its own application page, for about 0.6¢.');
  assert.equal(work.HINT_LINES.contacts, 'With Tenjin, I can search for a hiring manager or team lead for the jobs where I found nobody: about 1.2¢ a job, or about 2.5¢ when I first need to look up the company\'s website.');
  assert.equal(work.HINT_LINES.linkedin_resume, 'With Tenjin, I can read your LinkedIn profile from this link, once, for about 2.3¢.');
  assert.equal(work.tenjinHint({ tenjin: { status: 'outdated', version: '1.2.3' } }, 'contacts').line, 'Your Tenjin (1.2.3) is out of date. Update it to turn these on again.');
  assert.equal(Object.keys(work.HINT_LINES).some((k) => /writ/i.test(k)), false, 'no writing line until the Neon switch');
  for (const m of ['daily_search', 'employer_posting', 'contacts', 'linkedin_resume']) {
    const h = work.tenjinHint({ tenjin: { status: 'missing' } }, m);
    assert.ok(!h.line.includes('\n') && h.line === work.HINT_LINES[m]);
    assert.match(h.line, /\d(\.\d)?¢/, `${m}: names its price`);
  }
});

test('the ask is the approved copy word for word, the moment\'s line first, with the pace from the frequency', () => {
  const LIST = `Set up Tenjin? It adds these to Job Search. You pay per use from a funded wallet, within your spending limits:
- More job sources: postings from LinkedIn, Indeed and other job boards across the web, and hiring posts on X
- A direct search of company job boards (Greenhouse, Lever, Ashby)
  These two run in each search round, for about 1.4¢ a round.
- The company's own application page for a job you saw on another site: about 0.6¢ a job
- A hiring manager or team lead to contact when the free search finds nobody: about 1.2¢ a job, or about 2.5¢ when the company's website must be looked up first
- Your LinkedIn profile link read as your resume: about 2.3¢, once
- These searches run in the background, so they use none of your Claude usage
`;
  const tail = (pace) => `${pace}, plus any lookups and contact searches. Prices are estimates, checked on 2026-11-25.`;
  const missing = { tenjin: { status: 'missing' } };
  assert.equal(work.tenjinOffer('daily_search', missing), `${work.HINT_LINES.daily_search}\n\n${LIST}${tail('At one search round a day, that is about 1.4¢ a day')}`);
  assert.equal(work.tenjinOffer('contacts', missing, 'twice_daily'), `${work.HINT_LINES.contacts}\n\n${LIST}${tail('At two search rounds a day, that is about 2.8¢ a day')}`);
  assert.equal(work.tenjinOffer('linkedin_resume', missing, 'weekly'), `${work.HINT_LINES.linkedin_resume}\n\n${LIST}${tail('At one search round a week, that is about 1.4¢ a week')}`);
  // out of date: the out-of-date line first, the list and the pace line unchanged
  assert.equal(work.tenjinOffer('daily_search', { tenjin: { status: 'outdated', version: '0.9.0' } }), `Your Tenjin (0.9.0) is out of date. Update it to turn these on again.\n\n${LIST}${tail('At one search round a day, that is about 1.4¢ a day')}`);
});

test('every hint and offer line names its price, no seller name appears, and every routed need has a line', () => {
  const offer = work.tenjinOffer('daily_search', { tenjin: { status: 'missing' } });
  for (const bullet of offer.split('\n').filter((l) => /^- (The company's|A hiring manager|Your LinkedIn)/.test(l))) assert.match(bullet, /\d(\.\d)?¢/, bullet);
  const text = Object.values(work.HINT_LINES).join(' ') + offer;
  assert.doesNotMatch(text, /orthogonal|icypeas|exa\b|agentsearch|brave|companyenrich|x402|apollo|blockrun/i);
  assert.doesNotMatch(text, /Neon|writing/);
  // every routed need has a price in graph.json, so it has a figure in the ask
  const PRICE_KEY = { event_web: 'board_search', event_posts_x: 'x_hiring_posts', job_postings: 'job_postings', x_hiring_posts: 'x_hiring_posts', web_search: 'board_search', careers_page: 'careers_page', people_search: 'people_search', company_lookup: 'company_lookup', linkedin_profile: 'linkedin_profile' };
  for (const kind of [...Object.keys(graph.needTemplates), 'web_search', 'company_lookup']) assert.ok(graph.prices.needs[PRICE_KEY[kind]], `${kind} has a price`);
  for (const need of Object.keys(graph.prices.needs)) assert.ok(graph.prices.needs[need].estimateCents > 0, need);
  const a = work.askFirst({ tenjin: { status: 'missing' }, lease: null }, 'contacts');
  assert.equal(a.question.questions[0].question, work.tenjinOffer('contacts', { tenjin: { status: 'missing' } }));
  assert.deepEqual(a.question.questions[0].options.map((x) => x.label), ['Set up Tenjin (Recommended)', 'Not now']);
  const f = work.askFirst({ tenjin: { status: 'unfunded' }, lease: null }, 'contacts');
  assert.deepEqual(f.question.questions[0].options.map((x) => x.label), ['Add funds (Recommended)', 'Not now'], 'the funded-but-empty variant stays');
});
