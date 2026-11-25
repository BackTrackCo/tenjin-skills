import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeFetch, mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const work = await import('../../skills/job-search/scripts/lib/work.mjs');
const report = await import('../../skills/job-search/scripts/lib/report.mjs');
const sweep = await import('../../skills/job-search/scripts/lib/sweep.mjs');
const writing = await import('../../skills/job-search/scripts/lib/writing.mjs');
const q = await import('../../skills/job-search/scripts/lib/questions.mjs');

const NOW = Date.parse('2026-11-23T12:00:00Z');
const empty = { rules: [], lessons: [] };
const reset = () => store.updateState((s) => { Object.assign(s, store.emptyState()); });
const GH = 'https://boards-api.greenhouse.io/v1/boards';
const ghBoard = (name, jobs) => ({ jobs: jobs.map((j) => ({ id: j.id, title: j.title, company_name: name, location: { name: 'Berlin, Germany' }, first_published: '2026-11-20T00:00:00Z', content: '' })) });

// ---- hints -------------------------------------------------
test('code computes the hint at its moments from the Tenjin state; nothing stops', () => {
  const s = store.emptyState();
  const profile = { search: { role: 'engineer', place: 'Berlin' } };
  const search = () => work.buildWorkList(s, empty, NOW, profile).items.find((i) => i.reason === 'search_due');
  for (const status of ['missing', 'unfunded']) {
    s.tenjin.status = status;
    const i = search();
    assert.equal(i.routed, false);
    assert.match(i.hint.line, /^With Tenjin, each search round can also cover job postings from LinkedIn, Indeed/);
    assert.equal(i.hint.moment, 'daily_search');
    assert.equal(i.askTenjin, true);
  }
  s.tenjin.status = 'outdated';
  assert.match(search().hint.line, /out of date/);
  s.tenjin.status = 'ready';
  const ready = search();
  assert.equal(ready.hint, null);
  assert.equal(ready.routed, true);
  assert.equal(ready.askTenjin, false);
  assert.equal(work.tenjinHint({ tenjin: { status: 'missing' } }, 'writing'), null, 'no writing hint in this round');
  for (const m of ['employer_posting', 'contacts']) assert.ok(work.tenjinHint({ tenjin: { status: 'missing' } }, m).line.startsWith('With Tenjin, I can'), m);
});

test('the ask: at most once per session, a recorded no with its date, only a mention in an unattended run', () => {
  reset();
  store.updateState((s) => { s.tenjin.status = 'missing'; s.lease = { holder: 'sess1', heartbeat: new Date().toISOString() }; });
  const ask = (o) => work.tenjinAsk(store.loadState(), o);
  assert.equal(ask({}), true);
  assert.equal(ask({ unattended: true }), false, 'nobody can answer in an unattended run');
  assert.equal(runJobs(home, ['tenjin', 'ask-done', 'no']).code, 0);
  assert.equal(ask({}), false, 'no more asks after a no');
  const t = store.loadState().tenjin;
  assert.match(t.declinedAt, /^\d{4}-\d{2}-\d{2}T/);
  store.updateState((s) => { s.lease = { holder: 'sess2', heartbeat: new Date().toISOString() }; });
  assert.equal(ask({}), false, 'a recorded no is honoured: a new watcher lease is not a new session');
  store.updateState((s) => { s.tenjin.declinedAt = null; s.tenjin.askedAt = new Date(Date.now() - 13 * 3600000).toISOString(); });
  assert.equal(ask({}), true, 'an ask that was not a no may come once more after twelve hours');
  assert.equal(work.tenjinAsk({ tenjin: { status: 'ready' } }, {}), false);
});

test('the start never stops for Tenjin: with none installed, the work-list still runs', () => {
  reset();
  runJobs(home, ['profile', 'set', JSON.stringify({ search: { role: 'engineer', place: 'Berlin' } })]);
  const t = runJobs(home, ['tenjin']);
  assert.equal(t.code, 0);
  assert.equal(t.json.status, 'missing');
  const w = runJobs(home, ['work']);
  assert.ok(w.json.items.some((i) => i.reason === 'search_due' && i.routed === false && i.hint));
  assert.equal(w.json.notify, null, 'a missing Tenjin is a hint, not something that waits on the person');
});

test('the report mentions the hint for a job with no employer posting', () => {
  const s = store.emptyState();
  s.tenjin.status = 'missing';
  const j = mkJob({ employerPosting: null, openConfirmed: false, unresolved: 'no_board', applyLinks: ['https://x.test/1'] });
  s.jobs[j.key] = j;
  assert.match(report.renderReport(s, empty, { now: NOW }), /With Tenjin, I can look up this company's careers page/);
  s.tenjin.status = 'ready';
  assert.doesNotMatch(report.renderReport(s, empty, { now: NOW }), /With Tenjin I can/);
});

// ---- the first report says what was searched ---------------------------
test('the first report line says what was searched, with its source', () => {
  const profile = { search: { role: 'software engineer', roleWords: ['backend', 'platform'], place: 'New York', remote: false, sources: { role: 'resume', place: 'resume' } } };
  const text = report.renderReport(store.emptyState(), empty, { now: NOW, profile });
  assert.match(text, /Searched for software engineer \(backend, platform\) in New York, from your resume; tell me to change it\./);
  const noRemote = report.renderReport(store.emptyState(), empty, { now: NOW, profile: { search: { ...profile.search, remote: true, sources: { role: 'person' } } } });
  assert.match(noRemote, /in New York and remote, from what you told me/);
  assert.equal(runJobs(home, ['profile', 'set', JSON.stringify({ search: { role: 'x', sources: { role: 7 } } })]).code, 2);
});

// ---- facts and EEO hold at their trigger ---------------------------------
test('a missing form fact holds only its job as needs_facts, names what is missing, and resumes after the answer', () => {
  const j = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/60', status: 'prepared', company: 'Globex' });
  const other = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/61', status: 'prepared' });
  reset();
  store.updateState((s) => { s.jobs[j.key] = j; s.jobs[other.key] = other; });
  runJobs(home, ['profile', 'set', JSON.stringify({ facts: { first_name: 'Ada' }, eeoText: 'Decline every voluntary demographic question (test placeholder).', applyMode: 'auto_no_new' })]); // an auto mode holds the job; attended asks in the approval
  const qf = path.join(home, 'qf.json');
  fs.writeFileSync(qf, JSON.stringify([{ label: 'First Name', required: true, type: 'input_text' }, { label: 'Phone', required: true, type: 'input_text' }, { label: 'Are you legally authorized to work in the US?', required: true, type: 'input_text' }]));
  runJobs(home, ['sheet', 'build', j.key, '--questions', qf]);
  assert.equal(runJobs(home, ['sheet', 'check', j.key]).code, 4);
  const held = store.loadState().jobs[j.key];
  assert.deepEqual(held.parked.reasons, ['needs_facts']);
  assert.deepEqual(held.missingFacts.sort(), ['authorized_to_work', 'phone']);
  assert.equal(store.loadState().jobs[other.key].parked, null, 'only its own job holds');
  const w = runJobs(home, ['work', '--commit']);
  assert.match(w.json.notify, /needs facts: authorized to work, phone|needs facts: phone, authorized to work/);
  assert.equal(runJobs(home, ['work', '--commit']).json.notify, null, 'one notification');
  // the answer comes, and the job goes back in the queue by itself
  assert.equal(runJobs(home, ['fact', 'set', 'phone', '+49 151 0000000']).json.resumed, 0, 'one fact is not enough');
  const done = runJobs(home, ['fact', 'set', 'authorized_to_work', 'Yes']);
  assert.equal(done.json.resumed, 1);
  assert.equal(store.loadState().jobs[j.key].parked, null);
  runJobs(home, ['sheet', 'build', j.key, '--questions', qf]);
  assert.equal(runJobs(home, ['sheet', 'check', j.key]).code, 0);
});

test('the voluntary demographic answers are asked at the first form that has them, and the held job resumes once the person\'s text is saved', () => {
  const j = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/62', status: 'prepared' });
  reset();
  store.updateState((s) => { s.jobs[j.key] = j; });
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), { force: true });
  runJobs(home, ['profile', 'set', JSON.stringify({ facts: { first_name: 'Ada' } })]);
  const qf = path.join(home, 'qe.json');
  fs.writeFileSync(qf, JSON.stringify([{ label: 'First Name', required: true, type: 'input_text' }, { label: 'Gender', required: false, type: 'input_text' }]));
  runJobs(home, ['sheet', 'build', j.key, '--questions', qf]);
  assert.equal(runJobs(home, ['sheet', 'check', j.key]).code, 4);
  assert.deepEqual(store.loadState().jobs[j.key].parked.reasons, ['eeo_missing']);
  const r = runJobs(home, ['profile', 'set', JSON.stringify({ eeoText: 'Decline every voluntary demographic question (test placeholder).' })]);
  assert.equal(r.json.resumed, 1);
  assert.equal(store.loadState().jobs[j.key].parked, null);
});

test('no question can only be answered inside an open batch: every answer command works outside, and the batch closes first', () => {
  const b = awaitBatch();
  assert.equal(b, true);
});
function awaitBatch() {
  reset();
  runJobs(home, ['batch', 'open', '--unattended']);
  const refused = runJobs(home, ['fact', 'set', 'phone', '1']);
  runJobs(home, ['batch', 'close']);
  const ok = runJobs(home, ['fact', 'set', 'phone', '1']);
  return refused.code === 4 && ok.code === 0;
}

// ---- the watch list only on the person's own request ------------------------
const watchSrc = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'scripts', 'lib', 'store.mjs'), 'utf8');
const profileOf = () => JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.tenjin-skills', 'job-search', 'profile.json'), 'utf8'));

test('a job passing review with an exact or confirmed posting adds no board', () => {
  reset();
  const ok = mkJob({ key: 'https://boards.greenhouse.io/figma/jobs/1', status: 'new', company: 'Figma', employerPosting: { url: 'https://boards.greenhouse.io/figma/jobs/1', system: 'greenhouse', token: 'figma', jobId: '1', confidence: 'exact' } });
  store.updateState((s) => { s.jobs[ok.key] = ok; });
  store.applyOps([{ op: 'transition', key: ok.key, to: 'reviewed' }]);
  const s = store.loadState();
  assert.equal(s.found, undefined);
  assert.equal(sweep.resolveWatchList({}).entries.length, 0);
  assert.doesNotMatch(watchSrc, /addFoundBoard/);
});

test('J watch add: a pasted link joins profile.watch, once; remove takes it off; nothing else changes the list', () => {
  reset();
  const a = runJobs(home, ['watch', 'add', 'https://boards.greenhouse.io/figma/jobs/77']);
  assert.equal(a.json.added, 'figma');
  assert.deepEqual(profileOf().watch.map((w) => w.url), ['https://boards.greenhouse.io/figma/jobs/77']);
  assert.equal(runJobs(home, ['watch', 'add', 'https://job-boards.greenhouse.io/figma']).json.already, 'figma');
  assert.equal(profileOf().watch.length, 1);
  assert.equal(runJobs(home, ['watch', 'list']).json.watch.length, 1);
  const needs = runJobs(home, ['watch', 'add', 'https://example.com/careers?gh_jid=5']);
  assert.match(needs.json.line, /no board link/);
  assert.equal(runJobs(home, ['watch', 'remove', 'Figma']).json.removed, 1);
  assert.deepEqual(profileOf().watch, []);
});

test('J watch add with a company name uses the employer resolution; with no board it says so in one plain line', async () => {
  const wl = await import('../../skills/job-search/scripts/lib/watchlist.mjs');
  const f = fakeFetch({ [`${GH}/stripe/`]: ghBoard('Stripe', [{ id: 1, title: 'Engineer' }]) });
  const hit = await wl.addWatch('Stripe', [], { fetch: f });
  assert.equal(hit.added, 'Stripe');
  assert.deepEqual(hit.watch.map((w) => [w.ats, w.token]), [['greenhouse', 'stripe']]);
  const miss = await wl.addWatch('Nowhere Inc', [], { fetch: fakeFetch({}) });
  assert.match(miss.line, /^I found no Greenhouse, Lever or Ashby board for Nowhere Inc/);
  assert.equal(miss.watch, undefined);
  assert.doesNotMatch(miss.line, /\?/, 'a statement, not a question');
});

test('the sweep reads every listed board, no cap; a board with no role job never drops; the report section shows only with a board', async () => {
  reset();
  const watch = Array.from({ length: 60 }, (_, i) => ({ url: `https://boards.greenhouse.io/co${i}` }));
  assert.equal(sweep.resolveWatchList({ watch }).entries.length, 60);
  assert.equal(fs.existsSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'data')), false, 'no list is shipped');
  const profile = { search: { role: 'software engineer' }, watch: [{ url: 'https://boards.greenhouse.io/stale' }], includeOld: true };
  const f = fakeFetch({ [`${GH}/stale/`]: ghBoard('Stale', [{ id: 1, title: 'Account Executive' }]) });
  const later = NOW + 200 * 86400000;
  sweep.persist(await sweep.runSweep({ state: store.loadState(), profile, overlay: empty, fetch: f, now: later }));
  assert.equal(sweep.resolveWatchList(profile).entries.length, 1, 'still listed after 200 days');
  assert.match(report.renderReport(store.loadState(), empty, { now: later, profile }), /## Watched boards checked/);
  assert.doesNotMatch(report.renderReport(store.loadState(), empty, { now: later, profile: { search: profile.search } }), /Watched boards checked/);
});

test('old automatic state is refused with the field named; no tip, no question asks for watched companies', () => {
  reset();
  const file = path.join(process.env.HOME, '.tenjin-skills', 'job-search', 'state.json');
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...st, found: [], removedBoards: ['x'] }));
  const r = runJobs(home, ['report', '--all']);
  assert.equal(r.code, 2);
  assert.match(r.json.error, /state\.json has old fields the skill no longer reads: found \(.*\); removedBoards/);
  fs.writeFileSync(file, JSON.stringify(st));
  assert.doesNotMatch(runJobs(home, ['report', '--all']).stdout, /Tip: you can paste/);
  const all = fs.readdirSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'references')).map((f) => fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'references', f), 'utf8')).join('\n');
  assert.doesNotMatch(all, /which companies|companies (do you|to) watch|watch list question/i);
});

// ---- intros -------------------------------------------------------------------
test('intros: one writer call per job for the contacts with a channel, checked per channel, never sent, no consent gate', () => {
  reset();
  const j = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/70', company: 'Acme', status: 'reviewed' });
  store.updateState((s) => { s.jobs[j.key] = j; });
  const c = (over) => ({ op: 'contact', key: j.key, name: 'Bo', title: 'VP', sourceUrl: 'https://acme.test/team', how: 'X DM', cares: 'dev tools', channel: 'x', ...over });
  store.applyOps([c({}), c({ name: 'Cy', channel: 'email', how: 'cy@acme.test' }), c({ name: 'Di', channel: undefined, how: 'unknown' })]);
  const profile = { facts: { first_name: 'Ada', email: 'ada@example.com' }, resumeText: 'Ada builds compilers.' };
  const req = writing.buildIntroRequest({ job: j, profile, contacts: store.loadState().contacts[j.key], rulesText: '' });
  assert.equal(req.model, 'opus');
  assert.match(req.prompt, /"name":"Bo"/);
  assert.match(req.prompt, /"name":"Cy"/);
  assert.doesNotMatch(req.prompt, /"name":"Di"/, 'a contact with no channel gets no intro');
  assert.match(req.prompt, /under 300 characters/);
  assert.match(req.prompt, /subject line and about 120 words/);
  assert.throws(() => writing.buildIntroRequest({ job: j, profile, contacts: [{ name: 'Di' }], rulesText: '' }), /no contact with a channel/);
  const r = writing.parseIntroResult('```json\n{"Bo": {"text": "Hi Bo, I like your dev tools work."}, "Cy": {"subject": "Dev tools", "text": "Hello Cy, a short note."}}\n```');
  const ops = Object.entries(r).map(([name, v]) => ({ op: 'intro', key: j.key, name, subject: v.subject, text: v.text }));
  store.applyOps(ops);
  const contacts = store.loadState().contacts[j.key];
  assert.deepEqual(contacts[0].intro.channel, 'x');
  assert.equal(contacts[1].intro.subject, 'Dev tools');
  assert.equal(contacts[2].intro, undefined);
  assert.ok(contacts[0].intro.writtenAt && contacts[0].intro.sources[0] === 'https://acme.test/team');
  assert.match(report.renderReport(store.loadState(), empty, { now: NOW }), /Intro to copy \(x\), you send it yourself: Hi Bo/);
});

test('intro length checks per channel; no consent gate and no writing_needs_yes', () => {
  reset();
  const j = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/71' });
  store.updateState((s) => { s.jobs[j.key] = j; });
  store.applyOps([{ op: 'contact', key: j.key, name: 'Bo', sourceUrl: 'https://a.test/b', how: 'x', cares: 'y', channel: 'x' }, { op: 'contact', key: j.key, name: 'Cy', sourceUrl: 'https://a.test/c', how: 'x', cares: 'y', channel: 'email' }]);
  assert.throws(() => store.applyOps([{ op: 'intro', key: j.key, name: 'Bo', text: 'x'.repeat(301) }]), /under 300 characters/);
  assert.throws(() => store.applyOps([{ op: 'intro', key: j.key, name: 'Cy', text: 'short' }]), /subject line/);
  assert.throws(() => store.applyOps([{ op: 'intro', key: j.key, name: 'Cy', subject: 's', text: Array(121).fill('w').join(' ') }]), /120 words/);
  assert.throws(() => store.applyOps([{ op: 'intro', key: j.key, name: 'Nobody', text: 'x' }]), /no such contact/);
  store.applyOps([{ op: 'intro', key: j.key, name: 'Cy', subject: 's', text: Array(120).fill('w').join(' ') }, { op: 'intro', key: j.key, name: 'Bo', text: 'x'.repeat(300) }]);
  assert.ok(store.loadState().contacts[j.key].every((c) => c.intro));
  assert.equal(store.loadState().held.length, 0);
  assert.equal(JSON.stringify(store.loadState().parked || null), 'null');
  assert.throws(() => store.applyOps([{ op: 'contact', key: j.key, name: 'Z', sourceUrl: 'https://a.test/z', how: 'x', cares: 'y', channel: 'carrier pigeon' }]), /channel/);
});

// ---- consent changes are visible (safety without a hook) -----------------------------------
test('every consent change and writing approval gets a notification and a report line', () => {
  reset();
  runJobs(home, ['profile', 'set', JSON.stringify({ eeoText: 'Decline every voluntary demographic question (test placeholder).', unattended: { roles: ['engineer'], places: ['Berlin'], minScore: 70, hosts: ['greenhouse'] } })]);
  runJobs(home, ['consent', 'record', 'writing']);
  runJobs(home, ['consent', 'record', 'unattended', '--optional-writing', 'wait']);
  const w = runJobs(home, ['work', '--commit']);
  assert.match(w.json.notify, /consent changed: writing consent recorded; unattended consent recorded/);
  assert.equal(runJobs(home, ['work', '--commit']).json.notify, null, 'once');
  runJobs(home, ['consent', 'revoke', 'writing']);
  assert.match(runJobs(home, ['work', '--commit']).json.notify, /writing consent revoked/);
  const text = runJobs(home, ['report']).stdout;
  assert.match(text, /## Consent changes/);
  assert.match(text, /writing consent recorded/);
  assert.match(text, /writing consent revoked/);
  assert.doesNotMatch(runJobs(home, ['report']).stdout, /## Consent changes/, 'shown once, then acknowledged');
});

// ---- no DeepSeek, no guard, no model switch, one Fable line ------------------------------------
test('the skill asks nothing about DeepSeek, reads no Tenjin setting, and has no hook', () => {
  const root = path.join(import.meta.dirname, '..', '..');
  const files = ['README.md', 'skills/job-search/SKILL.md', ...fs.readdirSync(path.join(root, 'skills/job-search/references')).map((f) => `skills/job-search/references/${f}`), ...fs.readdirSync(path.join(root, 'skills/job-search/scripts/lib'), { recursive: true }).filter((f) => f.endsWith('.mjs')).map((f) => `skills/job-search/scripts/lib/${f}`), 'skills/job-search/scripts/jobs.mjs'];
  for (const f of files) {
    const t = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(t, /deepseek_on|subagents off|config subagents|DeepSeek subagents/i, f);
    assert.doesNotMatch(t, /guard_missing|guard install|guard selftest|guard uninstall|settings hook|PreToolUse/i, f.endsWith('CHANGES.md') ? '' : f);
  }
  assert.equal(fs.existsSync(path.join(root, 'skills/job-search/scripts/lib/guard.mjs')), false);
  assert.equal(fs.existsSync(path.join(root, 'skills/job-search/scripts/lib/batch.mjs')), true);
});

test('SKILL.md: no model or effort in the frontmatter; one Fable line, once per session, never unattended; the question tool rule', () => {
  const skill = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'SKILL.md'), 'utf8');
  const fm = /^---\n([\s\S]*?)\n---/.exec(skill)[1];
  assert.doesNotMatch(fm, /^(model|effort):/m);
  assert.match(skill, /Fable 5\.2 at high effort/);
  assert.match(skill, /`\/model fable`/);
  assert.match(skill, /`\/effort high`/);
  assert.match(skill, /AskUserQuestion/);
  assert.match(skill, /never in an unattended turn/i);
  assert.match(skill, /rule in the browser subagent|browser subagent's task/i);
});
