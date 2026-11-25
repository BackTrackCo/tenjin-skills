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

// ---- hints (v0-12, v0-13) -------------------------------------------------
test('code computes the hint at its moments from the Tenjin state; nothing stops', () => {
  const s = store.emptyState();
  const profile = { search: { role: 'engineer', place: 'Berlin' } };
  const search = () => work.buildWorkList(s, empty, NOW, profile).items.find((i) => i.reason === 'search_due');
  for (const status of ['missing', 'unfunded']) {
    s.tenjin.status = status;
    const i = search();
    assert.equal(i.routed, false);
    assert.match(i.hint.line, /router's job-posting search and a live X search/);
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
  for (const m of ['employer_posting', 'contacts']) assert.ok(work.tenjinHint({ tenjin: { status: 'missing' } }, m).line.startsWith('With Tenjin I can'), m);
});

test('the ask: at most once per session, a recorded no with its date, only a mention in an unattended run', () => {
  reset();
  store.updateState((s) => { s.tenjin.status = 'missing'; s.lease = { holder: 'sess1', heartbeat: new Date().toISOString() }; });
  const ask = (o) => work.tenjinAsk(store.loadState(), o);
  assert.equal(ask({}), true);
  assert.equal(ask({ unattended: true }), false, 'nobody can answer in an unattended run');
  assert.equal(runJobs(home, ['tenjin', 'ask-done', 'no']).code, 0);
  assert.equal(ask({}), false, 'no more asks in this session');
  const t = store.loadState().tenjin;
  assert.match(t.declinedAt, /^\d{4}-\d{2}-\d{2}T/);
  store.updateState((s) => { s.lease = { holder: 'sess2', heartbeat: new Date().toISOString() }; });
  assert.equal(ask({}), true, 'a new session may ask once more');
  assert.equal(work.tenjinAsk({ tenjin: { status: 'ready' } }, {}), false);
});

test('the start never stops for Tenjin: with none installed, setup check and the work-list still run', () => {
  reset();
  runJobs(home, ['profile', 'set', JSON.stringify({ search: { role: 'engineer', place: 'Berlin' } })]);
  const t = runJobs(home, ['tenjin']);
  assert.equal(t.code, 0);
  assert.equal(t.json.status, 'missing');
  assert.equal(runJobs(home, ['setup', 'check']).code, 0);
  const w = runJobs(home, ['work']);
  assert.ok(w.json.items.some((i) => i.reason === 'search_due' && i.routed === false && i.hint));
  assert.equal(w.json.notify, null, 'a missing Tenjin is a hint, not something that waits on the person');
});

test('the report mentions the hint for a job with no employer posting', () => {
  const s = store.emptyState();
  s.tenjin.status = 'missing';
  const j = mkJob({ employerPosting: null, openConfirmed: false, unresolved: 'no_board', applyLinks: ['https://x.test/1'] });
  s.jobs[j.key] = j;
  assert.match(report.renderReport(s, empty, { now: NOW }), /With Tenjin I can look up this employer's careers page/);
  s.tenjin.status = 'ready';
  assert.doesNotMatch(report.renderReport(s, empty, { now: NOW }), /With Tenjin I can/);
});

// ---- the first report says what was searched (v0-18) ---------------------------
test('the first report line says what was searched, with its source', () => {
  const profile = { search: { role: 'software engineer', roleWords: ['backend', 'platform'], place: 'New York', remote: false, sources: { role: 'resume', place: 'resume' } } };
  const text = report.renderReport(store.emptyState(), empty, { now: NOW, profile });
  assert.match(text, /Searched for software engineer \(backend, platform\) in New York, from your resume; tell me to change it\./);
  const noRemote = report.renderReport(store.emptyState(), empty, { now: NOW, profile: { search: { ...profile.search, remote: true, sources: { role: 'person' } } } });
  assert.match(noRemote, /in New York and remote, from what you told me/);
  assert.equal(runJobs(home, ['profile', 'set', JSON.stringify({ search: { role: 'x', sources: { role: 7 } } })]).code, 2);
});

// ---- facts and EEO hold at their trigger (v0-17) ---------------------------------
test('a missing form fact holds only its job as needs_facts, names what is missing, and resumes after the answer', () => {
  const j = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/60', status: 'prepared', company: 'Globex' });
  const other = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/61', status: 'prepared' });
  reset();
  store.updateState((s) => { s.jobs[j.key] = j; s.jobs[other.key] = other; });
  runJobs(home, ['profile', 'set', JSON.stringify({ facts: { first_name: 'Ada' }, eeo: 'decline_all' })]);
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

test('the EEO choice is asked at the first form that has it, and the held job resumes', () => {
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
  const r = runJobs(home, ['profile', 'set', JSON.stringify({ eeo: 'decline_all' })]);
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
  return refused.code === 4 && ok.code === 0 && runJobs(home, ['ask', 'eeo']).code === 0;
}

// ---- the watch list builds itself (v0-20) --------------------------------------------
test('a board joins the list when one of its jobs passes review with an exact or confirmed posting', () => {
  reset();
  const ok = mkJob({ key: 'https://boards.greenhouse.io/figma/jobs/1', status: 'new', company: 'Figma', employerPosting: { url: 'https://boards.greenhouse.io/figma/jobs/1', system: 'greenhouse', token: 'figma', jobId: '1', source: 'apply_link', confidence: 'exact', checkedAt: '' } });
  const unconfirmed = mkJob({ key: 'https://boards.greenhouse.io/zed/jobs/2', status: 'new', company: 'Zed', employerPosting: { url: 'https://boards.greenhouse.io/zed/jobs/2', system: 'greenhouse', token: 'zed', jobId: '2', source: 'board_probe', confidence: 'unconfirmed', checkedAt: '' } });
  store.updateState((s) => { s.jobs[ok.key] = ok; s.jobs[unconfirmed.key] = unconfirmed; });
  store.applyOps([{ op: 'transition', key: unconfirmed.key, to: 'reviewed' }, { op: 'transition', key: ok.key, to: 'reviewed', at: '2026-11-23T00:00:00Z' }]);
  const found = store.loadState().found;
  assert.deepEqual(found.map((b) => [b.board, b.source, b.job, b.date]), [['greenhouse:figma', 'found', ok.key, '2026-11-23T00:00:00Z']]);
  store.applyOps([{ op: 'transition', key: ok.key, to: 'shortlisted' }]);
  assert.equal(store.loadState().found.length, 1, 'once');
});

test('the sweep reads found boards, with no list shipped and no cap', async () => {
  reset();
  store.updateState((s) => { s.found = Array.from({ length: 60 }, (_, i) => ({ board: `greenhouse:co${i}`, ats: 'greenhouse', token: `co${i}`, region: 'us', name: `Co${i}`, source: 'found', job: 'x', date: '2026-11-20T00:00:00Z', lastRoleJobAt: '2026-11-20T00:00:00Z' })); });
  const r = sweep.resolveWatchList({ watch: [{ url: 'https://boards.greenhouse.io/pasted' }] }, store.loadState());
  assert.equal(r.entries.length, 61);
  assert.equal(r.entries.filter((e) => e.found).length, 60);
  assert.equal(fs.existsSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'data')), false, 'no list is shipped');
});

test('a found board with no job in the role for 90 days drops off with a report line; a pasted board never drops', async () => {
  reset();
  const profile = { search: { role: 'software engineer' }, watch: [{ url: 'https://boards.greenhouse.io/pasted' }], includeOld: true };
  store.updateState((s) => { s.found = [
    { board: 'greenhouse:stale', ats: 'greenhouse', token: 'stale', region: 'us', name: 'Stale', source: 'found', job: 'x', date: '2026-07-01T00:00:00Z', lastRoleJobAt: '2026-07-01T00:00:00Z' },
    { board: 'greenhouse:fresh', ats: 'greenhouse', token: 'fresh', region: 'us', name: 'Fresh', source: 'found', job: 'x', date: '2026-07-01T00:00:00Z', lastRoleJobAt: '2026-07-01T00:00:00Z' },
  ]; });
  const f = fakeFetch({
    [`${GH}/stale/`]: ghBoard('Stale', [{ id: 1, title: 'Account Executive' }]),
    [`${GH}/fresh/`]: ghBoard('Fresh', [{ id: 2, title: 'Software Engineer' }]),
    [`${GH}/pasted/`]: ghBoard('Pasted', [{ id: 3, title: 'Cook' }]),
  });
  const payload = await sweep.runSweep({ state: store.loadState(), profile, overlay: empty, fetch: f, now: NOW });
  sweep.persist(payload);
  const s = store.loadState();
  assert.deepEqual(s.found.map((b) => b.name), ['Fresh']);
  assert.equal(s.found[0].lastRoleJobAt, payload.at);
  assert.match(s.dropLines[0], /Dropped Stale \(greenhouse:stale\) from the watch list: no job in your role for 90 days/);
  assert.match(report.renderReport(s, empty, { now: NOW }), /Dropped Stale/);
  // the pasted board has no role job and is still read the next time
  assert.ok(sweep.resolveWatchList(profile, s).entries.some((e) => e.token === 'pasted'));
});

test('a removed company is never added again; one report tip says a careers link can be pasted, once', () => {
  reset();
  store.updateState((s) => { s.found = [{ board: 'greenhouse:figma', ats: 'greenhouse', token: 'figma', region: 'us', name: 'Figma', source: 'found', job: 'x', date: 'd', lastRoleJobAt: 'd' }]; });
  assert.equal(runJobs(home, ['watch', 'remove', 'Figma']).json.removed, 1);
  assert.deepEqual(store.loadState().found, []);
  const j = mkJob({ key: 'https://boards.greenhouse.io/figma/jobs/9', status: 'new', company: 'Figma', employerPosting: { url: 'https://boards.greenhouse.io/figma/jobs/9', system: 'greenhouse', token: 'figma', jobId: '9', source: 'apply_link', confidence: 'exact', checkedAt: '' } });
  store.updateState((s) => { s.jobs[j.key] = j; });
  store.applyOps([{ op: 'transition', key: j.key, to: 'reviewed' }]);
  assert.deepEqual(store.loadState().found, [], 'not added again');
  store.updateState((s) => { s.found = [{ board: 'greenhouse:other', ats: 'greenhouse', token: 'other', region: 'us', name: 'Other', source: 'found', job: 'x', date: 'd', lastRoleJobAt: 'd' }]; });
  const first = runJobs(home, ['report']).stdout;
  assert.match(first, /Tip: you can paste a company's careers link/);
  assert.doesNotMatch(runJobs(home, ['report']).stdout, /Tip: you can paste/, 'said once');
  assert.equal(runJobs(home, ['watch', 'list']).json.removed.includes('greenhouse:figma'), true);
  // no question asks for watched companies
  const all = fs.readdirSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'references')).map((f) => fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'references', f), 'utf8')).join('\n');
  assert.doesNotMatch(all, /which companies|companies (do you|to) watch|watch list question/i);
});

// ---- intros (v0-14) -------------------------------------------------------------------
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
  runJobs(home, ['profile', 'set', JSON.stringify({ eeo: 'decline_all', unattended: { roles: ['engineer'], places: ['Berlin'], minScore: 70, hosts: ['greenhouse'] } })]);
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
