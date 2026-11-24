import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, fakeFetch, mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const ing = await import('../../skills/job-search/scripts/lib/ingest.mjs');
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const work = await import('../../skills/job-search/scripts/lib/work.mjs');
const ap = await import('../../skills/job-search/scripts/lib/apply.mjs');
const report = await import('../../skills/job-search/scripts/lib/report.mjs');
const g = await import('../../skills/job-search/scripts/lib/batch.mjs');
const co = await import('../../skills/job-search/scripts/lib/careerops.mjs');

const NOW = Date.parse('2026-11-23T10:00:00Z');
const empty = { rules: [], lessons: [] };
const GH = 'https://boards-api.greenhouse.io/v1/boards';
const ghBoard = (name, jobs) => ({ jobs: jobs.map((j) => ({ id: j.id, title: j.title, company_name: name, location: { name: j.loc || 'Berlin, Germany' }, first_published: j.at || '2026-11-15T00:00:00Z', content: '' })) });
const reset = () => store.updateState((s) => { Object.assign(s, store.emptyState()); });
const prof = { places: ['Berlin'], search: { role: 'software engineer', place: 'Berlin', variants: ['backend engineer', 'platform engineer'] } };
const webDoc = (results, round = 0) => ({ need: 'web_search', query: { role: 'software engineer', place: 'Berlin', remote: false, since: null, variant: null, round }, status: 'ok', results });
const run = (obj, f, profile = prof) => ing.ingest({ obj, state: store.loadState(), profile, overlay: empty, fetch: f, now: NOW });

// ---- 1. free web searches ------------------------------------------------
test('web search: a board link becomes the employer posting, read from the board API', async () => {
  reset();
  const f = fakeFetch({ [`${GH}/acme/`]: ghBoard('Acme', [{ id: 77, title: 'Software Engineer' }]) });
  const r = await run(webDoc([{ url: 'https://job-boards.greenhouse.io/acme/jobs/77' }]), f);
  assert.equal(r.added, 1);
  const j = Object.values(store.loadState().jobs)[0];
  assert.equal(j.employerPosting.confidence, 'exact');
  assert.equal(j.employerPosting.source, 'apply_link');
  assert.equal(j.openConfirmed, true);
  assert.equal(j.via, 'web');
  assert.ok(f.calls.every((u) => u.startsWith('https://boards-api.greenhouse.io/')), 'only the board API is called');
});

test('web search: a LinkedIn or Indeed result is used from the result only, never fetched, and goes through the employer steps', async () => {
  reset();
  const f = fakeFetch({ [`${GH}/acme/`]: ghBoard('Acme', [{ id: 5, title: 'Software Engineer' }]) });
  const r = await run(webDoc([
    { url: 'https://www.linkedin.com/jobs/view/123', title: 'Software Engineer', company: 'Acme', city: 'Berlin', postedAt: '2026-11-20T00:00:00Z' },
    { url: 'https://de.indeed.com/viewjob?jk=9', title: 'Backend Developer', company: 'Globex', city: 'Berlin', postedAt: '2026-11-20T00:00:00Z' },
  ]), f);
  assert.equal(r.added, 2);
  assert.ok(f.calls.every((u) => !/linkedin|indeed/.test(u)));
  const jobs = Object.values(store.loadState().jobs);
  const acme = jobs.find((j) => j.company === 'Acme');
  assert.equal(acme.employerPosting.source, 'board_probe', 'the platform result resolved to the employer board');
  const globex = jobs.find((j) => j.company === 'Globex');
  assert.equal(globex.employerPosting, null);
  assert.ok(globex.warnings.includes('not confirmed open'));
});

test('web search: an X result is stored as a post for review, never fetched or opened', async () => {
  reset();
  const f = fakeFetch({});
  await run(webDoc([{ url: 'https://x.com/someone/status/1', author: 'someone', snippet: 'We are hiring a software engineer in Berlin' }]), f);
  assert.equal(f.calls.length, 0);
  const s = store.loadState();
  assert.equal(s.posts[0].source, 'x');
  assert.equal(s.posts[0].text, 'We are hiring a software engineer in Berlin');
  await run(webDoc([{ url: 'https://x.com/someone/status/1', snippet: 'again' }]), f);
  assert.equal(store.loadState().posts.length, 1, 'once');
});

test('web search: the schema is checked, and nothing is guessed', async () => {
  reset();
  assert.match((await run(webDoc([{ url: 'https://www.linkedin.com/jobs/view/1' }]), fakeFetch({}))).held[0], /needs title and company/);
  assert.match((await run(webDoc([]), fakeFetch({}))).held[0], /the list is empty/);
  assert.match((await run({ ...webDoc([{ url: 'x' }]) }, fakeFetch({}))).held[0], /url is required/);
  assert.match((await run({ ...webDoc([{ url: 'https://x.com/a/1' }]), status: 'failed' }, fakeFetch({}))).held[0], /not a delivered result/);
  assert.equal(Object.keys(store.loadState().jobs).length, 0);
});

test('web_search status: ok (the native search) or fulfilled (the router) is delivered; every other need still needs fulfilled', async () => {
  const f = fakeFetch({ [`${GH}/acme/`]: ghBoard('Acme', [{ id: 77, title: 'Software Engineer' }]) });
  const board = [{ url: 'https://boards.greenhouse.io/acme/jobs/77' }];
  reset();
  assert.equal((await run(webDoc(board), f)).added, 1, 'ok, and no fullResultPath');
  reset();
  assert.equal((await run({ ...webDoc(board), status: 'fulfilled', fullResultPath: '/x' }, f)).added, 1, 'the router word works too');
  for (const status of ['unverified', 'running', 'needs_approval', 'failed', 'completed']) {
    reset();
    const r = await run({ ...webDoc(board), status }, f);
    assert.equal(r.added, 0, status);
    assert.match(r.held[0], new RegExp(`status "${status}" is not a delivered result \\(fulfilled or ok\\)`));
  }
  reset();
  const posting = { title: 'Software Engineer', employer: 'Acme', city: 'Berlin', region: '', country: 'DE', remote: false, postedAt: null, employmentType: '', salary: null, applyLinks: [{ url: 'https://boards.greenhouse.io/acme/jobs/77', publisher: '' }], description: 'x', sourceUrl: 'https://src.test/1' };
  const jp = { need: 'job_postings', query: { role: 'r', place: '', remote: false, since: null }, fullResultPath: '/x', postings: [posting] };
  const held = await run({ ...jp, status: 'ok' }, f);
  assert.equal(held.added, 0);
  assert.match(held.held[0], /not a delivered result \(fulfilled\)/);
  assert.equal((await run({ ...jp, status: 'fulfilled' }, f)).added, 1);
  reset();
  assert.match((await run({ ...webDoc([]), status: 'ok' }, f)).held[0], /the list is empty/);
});

// ---- 2. search rounds -----------------------------------------------------
test('rounds: a round that adds a new job moves to the next variant; an empty round or the end of the variants stops', async () => {
  reset();
  const profile = prof;
  store.updateState((s) => { s.routed.lastSearchAt = null; });
  const item = () => work.buildWorkList(store.loadState(), empty, NOW, profile).items.find((i) => i.reason === 'search_due');
  assert.deepEqual([item().query.round, item().query.variant], [0, null]);
  const f = fakeFetch({ [`${GH}/acme/`]: ghBoard('Acme', [{ id: 1, title: 'Software Engineer' }, { id: 2, title: 'Backend Engineer' }]) });
  await run(webDoc([{ url: 'https://boards.greenhouse.io/acme/jobs/1' }], 0), f);
  assert.equal(store.loadState().search.session.roundAdded, 1);
  let r = store.updateState((s) => work.advanceSearch(s, profile));
  assert.deepEqual(r, { done: false, round: 1, variant: 'backend engineer' });
  store.updateState((s) => { s.routed.lastSearchAt = new Date(NOW).toISOString(); });
  assert.deepEqual([item().query.round, item().query.variant], [1, 'backend engineer'], 'the next round shows in the work-list');
  await run(webDoc([{ url: 'https://boards.greenhouse.io/acme/jobs/2' }], 1), f);
  r = store.updateState((s) => work.advanceSearch(s, profile));
  assert.deepEqual(r, { done: false, round: 2, variant: 'platform engineer' });
  await run(webDoc([{ url: 'https://boards.greenhouse.io/acme/jobs/1' }], 2), f); // nothing new: a duplicate
  r = store.updateState((s) => work.advanceSearch(s, profile));
  assert.equal(r.done, true);
  assert.match(r.reason, /no new job/);
  assert.equal(item(), undefined, 'the work-list shows no round after the search ends');
});

test('rounds: the variants running out stops the search, and a new day starts again at round 0', async () => {
  reset();
  const profile = { ...prof, search: { ...prof.search, variants: ['backend engineer'] } };
  store.updateState((s) => { s.search.session = { startedAt: 'x', round: 1, roundAdded: 3, finished: false }; });
  assert.match(store.updateState((s) => work.advanceSearch(s, profile)).reason, /variants ran out/);
  assert.equal(work.advanceSearch(store.loadState(), profile).done, true, 'nothing to advance once finished');
  store.updateState((s) => { s.routed.lastSearchAt = new Date(NOW - 27 * 3600000).toISOString(); });
  assert.equal(work.buildWorkList(store.loadState(), empty, NOW, profile).items.find((i) => i.reason === 'search_due').query.round, 0);
  const f = fakeFetch({ [`${GH}/acme/`]: ghBoard('Acme', [{ id: 1, title: 'Software Engineer' }]) });
  await run(webDoc([{ url: 'https://boards.greenhouse.io/acme/jobs/1' }], 0), f);
  assert.deepEqual([store.loadState().search.session.round, store.loadState().search.session.finished], [0, false], 'a new session');
});

test('rounds: the CLI answers search next', () => {
  reset();
  runJobs(home, ['profile', 'set', JSON.stringify(prof)]);
  assert.equal(runJobs(home, ['search', 'next']).json.done, true);
});

// ---- 4 and 5. old postings, and open state --------------------------------
test('an older routed posting stays only when its board confirms it is open, with the warning', async () => {
  reset();
  const old = { id: 3, title: 'Software Engineer', at: '2026-10-20T00:00:00Z' };
  const f = fakeFetch({ [`${GH}/acme/`]: ghBoard('Acme', [old]) });
  const posting = (over) => ({ title: 'Software Engineer', employer: 'Acme', city: 'Berlin', region: '', country: 'DE', remote: false, postedAt: '2026-10-20T00:00:00Z', employmentType: 'Full-time', salary: null, applyLinks: [{ url: 'https://boards.greenhouse.io/acme/jobs/3', publisher: 'Greenhouse' }], description: 'x', sourceUrl: 'https://src.test/3', ...over });
  const doc = (p) => ({ need: 'job_postings', query: { role: 'software engineer', place: 'Berlin', remote: false, since: null }, status: 'fulfilled', fullResultPath: '/x', postings: p });
  const kept = await run(doc([posting()]), f);
  assert.equal(kept.added, 1);
  const j = Object.values(store.loadState().jobs)[0];
  assert.ok(j.warnings.includes('posted 2026-10-20, still open'));
  reset();
  const dropped = await run(doc([posting({ applyLinks: [], title: 'Backend Developer', employer: 'Globex' })]), fakeFetch({}));
  assert.equal(dropped.added, 0);
  assert.equal(dropped.dropped, 1, 'old, and no board confirms it');
  reset();
  const fresh = await run(doc([posting({ postedAt: '2026-11-20T00:00:00Z' })]), f);
  assert.deepEqual(Object.values(store.loadState().jobs)[0].warnings.filter((w) => /still open/.test(w)), [], 'a recent posting needs no such warning');
  assert.equal(fresh.added, 1);
});

test('a job whose open state is not confirmed stays in the report and never enters the apply queue', () => {
  const j = mkJob({ status: 'apply_ready', fit: 90, sheet: { hash: 'h', passed: true, eeoMissing: false, fields: [] }, openConfirmed: false });
  const s = store.emptyState();
  s.jobs[j.key] = j;
  s.approvals[j.key] = { sheetHash: 'h' };
  const r = ap.applyNext({ state: s, profile: { eeo: 'decline_all' }, overlay: empty, mode: 'attended', now: NOW, batchOpen: true });
  assert.deepEqual(r.queue, [{ key: j.key, reason: 'not_confirmed_open' }]);
  assert.equal(r.handout, null);
  j.openConfirmed = true;
  assert.ok(ap.applyNext({ state: s, profile: { eeo: 'decline_all' }, overlay: empty, mode: 'attended', now: NOW, batchOpen: true }).handout);
  const u = mkJob({ employerPosting: null, openConfirmed: false, unresolved: 'no_board', warnings: ['not confirmed open'], applyLinks: ['https://x.test/1'] });
  const s2 = store.emptyState();
  s2.jobs[u.key] = u;
  assert.match(report.renderReport(s2, empty, { now: NOW }), /Apply yourself \(1\)/);
});

// ---- 7. contacts -----------------------------------------------------------
test('contacts: a source link, how to reach them and one thing they care about; a likely person only when not confirmed', () => {
  const j = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/50' });
  store.updateState((s) => { Object.assign(s, store.emptyState()); s.jobs[j.key] = j; });
  const c = (over) => [{ op: 'contact', key: j.key, name: 'Bo', title: 'VP Eng', sourceUrl: 'https://acme.test/team', how: 'GitHub issues', cares: 'developer tooling', ...over }];
  store.applyOps(c({}));
  assert.deepEqual(Object.keys(store.loadState().contacts[j.key][0]).sort(), ['cares', 'channel', 'how', 'name', 'notConfirmed', 'sourceUrl', 'title']);
  assert.throws(() => store.applyOps(c({ sourceUrl: undefined })), /source link/);
  assert.throws(() => store.applyOps(c({ how: '' })), /how to reach/);
  assert.throws(() => store.applyOps(c({ cares: undefined })), /one thing they care about/);
  assert.throws(() => store.applyOps(c({ sourceUrl: 'https://www.ycombinator.com/companies/acme' })), /Y Combinator page/);
  assert.throws(() => store.applyOps(c({ basis: 'likely' })), /not confirmed/);
  store.applyOps(c({ basis: 'likely', notConfirmed: true, sourceUrl: 'https://www.linkedin.com/in/bo' }));
  assert.equal(store.loadState().contacts[j.key].at(-1).notConfirmed, true);
});

test('contacts request picks the best 5 jobs by fit, or the contact_count rule', () => {
  store.updateState((s) => { Object.assign(s, store.emptyState()); for (let i = 0; i < 8; i++) { const j = mkJob({ key: `https://boards.greenhouse.io/acme/jobs/${100 + i}`, status: 'reviewed', fit: i * 10 }); s.jobs[j.key] = j; } });
  assert.equal(runJobs(home, ['contacts', 'request']).json.requested, 5);
  assert.deepEqual(store.loadState().contactsRequested.map((k) => k.slice(-3)), ['107', '106', '105', '104', '103']);
});

// ---- 8. report -------------------------------------------------------------
test('the report shows the one-line fit, the pay if shown, and the jobs that review dropped with their reasons', () => {
  const s = store.emptyState();
  const a = mkJob({ fit: 90, fitLine: 'matches your stack', salary: '90000-120000 EUR/year', title: 'Staff Engineer' });
  const b = mkJob({ status: 'skipped', statusAt: '2026-11-23T08:00:00Z', skipReason: 'the work is sales, not engineering', title: 'Sales Engineer', company: 'Globex' });
  s.jobs = { [a.key]: a, [b.key]: b };
  const text = report.renderReport(s, empty, { now: NOW });
  assert.match(text, /90 \| Staff Engineer, Acme, Berlin \| pay: 90000-120000 EUR\/year \| matches your stack/);
  assert.match(text, /## Dropped in review \(1\)\n- Sales Engineer, Globex: the work is sales, not engineering/);
  store.updateState((st) => { Object.assign(st, store.emptyState()); st.jobs[a.key] = { ...a, status: 'new' }; });
  store.applyOps([{ op: 'transition', key: a.key, to: 'skipped', reason: 'too senior' }]);
  assert.equal(store.loadState().jobs[a.key].skipReason, 'too senior');
});

// ---- 11. the Tenjin line -----------------------------------------------------
test('without Tenjin the reply ends with one line about what it adds; the report file does not carry it', () => {
  reset();
  const r = runJobs(home, ['report']);
  const lines = r.stdout.trimEnd().split('\n');
  assert.match(lines.at(-1), /^Tenjin is not installed\. With it I can also search X live, add more job-board listings and find people to write to\. Ask me to set it up\.$/);
  assert.doesNotMatch(lines.at(-1), /\$|price|cost/i);
  const file = fs.readFileSync(path.join(home, '.tenjin-skills', 'job-search', 'reports', `${new Date().toISOString().slice(0, 10)}.md`), 'utf8');
  assert.doesNotMatch(file, /Tenjin is not installed/);
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'tenjin'), '#!/bin/sh\necho "0.1.0-alpha.35"\n', { mode: 0o755 });
  assert.doesNotMatch(runJobs(home, ['report']).stdout, /Tenjin is not installed/);
  fs.rmSync(path.join(bin, 'tenjin'));
});

// ---- 10. career-ops ----------------------------------------------------------
function careerOpsDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'careerops-'));
  fs.mkdirSync(path.join(d, 'config'));
  fs.mkdirSync(path.join(d, 'data'));
  fs.writeFileSync(path.join(d, 'cv.md'), '# Ada\nCompilers, 8 years.\n');
  fs.writeFileSync(path.join(d, 'config', 'profile.yml'), 'name: Ada\nrole: software engineer\nlocation: Berlin\n');
  fs.writeFileSync(path.join(d, 'data', 'pipeline.md'), '# Pipeline\n\n## Pending\n- [ ] https://boards.greenhouse.io/old/jobs/1 | Old | Dev | Berlin\n\n## Done\n- [x] https://boards.greenhouse.io/done/jobs/9 | Done | Dev | Berlin\n');
  fs.writeFileSync(path.join(d, 'data', 'applications.md'), '| 1 | https://jobs.lever.co/applied/abc | Applied | Dev |\n');
  fs.writeFileSync(path.join(d, 'data', 'scan-history.tsv'), 'https://jobs.ashbyhq.com/scanned/uuid-1\t2026-11-01\n');
  fs.writeFileSync(path.join(d, 'notes.md'), 'unrelated\n');
  return d;
}
const snapshot = (d) => Object.fromEntries(fs.readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => [path.relative(d, path.join(e.parentPath, e.name)), fs.readFileSync(path.join(e.parentPath, e.name), 'utf8')]));

test('career-ops: all three files must be there; setup reads cv.md and profile.yml', () => {
  const d = careerOpsDir();
  assert.equal(co.isCareerOpsDir(d), true);
  assert.equal(runJobs(home, ['setup', 'careerops'], { cwd: os.tmpdir() }).json.detected, false);
  fs.rmSync(path.join(d, 'data', 'pipeline.md'));
  assert.equal(co.isCareerOpsDir(d), false);
  const d2 = careerOpsDir();
  const r = runJobs(home, ['setup', 'careerops'], { cwd: d2 });
  assert.equal(r.json.detected, true);
  assert.match(r.json.profileYml, /role: software engineer/);
  const p = JSON.parse(fs.readFileSync(path.join(home, '.tenjin-skills', 'job-search', 'profile.json'), 'utf8'));
  assert.match(p.resumeText, /Compilers, 8 years/);
  assert.deepEqual(p.careerOps, { dir: fs.realpathSync(d2), pipeline: false });
});

test('career-ops: dedupe also skips the URLs in the pipeline, applications and scan history', async () => {
  const d = careerOpsDir();
  const profile = { ...prof, careerOps: { dir: d, pipeline: false }, includeOld: true };
  const skip = co.loadSkipUrls(profile);
  for (const u of ['https://boards.greenhouse.io/old/jobs/1', 'https://boards.greenhouse.io/done/jobs/9', 'https://jobs.lever.co/applied/abc', 'https://jobs.ashbyhq.com/scanned/uuid-1']) assert.ok(skip.has(u), u);
  reset();
  const sweepMod = await import('../../skills/job-search/scripts/lib/sweep.mjs');
  const board = ghBoard('Old', [{ id: 1, title: 'Software Engineer' }, { id: 2, title: 'Software Engineer' }]);
  const payload = await sweepMod.runSweep({ state: store.loadState(), profile: { ...profile, watch: [{ url: 'https://boards.greenhouse.io/old' }] }, overlay: empty, fetch: fakeFetch({ [`${GH}/old/`]: board }), now: NOW });
  assert.deepEqual(payload.jobs.map((j) => j.sourceId), ['2'], 'job 1 is in the pipeline');
  const r = await run(webDoc([{ url: 'https://boards.greenhouse.io/old/jobs/1' }]), fakeFetch({ [`${GH}/old/`]: board }), profile);
  assert.equal(r.added, 0);
});

test('career-ops: the pipeline write needs the yes, goes under ## Pending, and changes no other file', () => {
  const d = careerOpsDir();
  const before = snapshot(d);
  runJobs(home, ['setup', 'careerops'], { cwd: d });
  const j1 = mkJob({ key: 'https://boards.greenhouse.io/new/jobs/1', status: 'reviewed', company: 'Newco', title: 'Staff Engineer', city: 'Berlin' });
  j1.employerPosting.url = j1.key;
  const j2 = mkJob({ key: 'https://boards.greenhouse.io/other/jobs/2', status: 'reviewed', company: 'Other', title: 'Engineer | Platform', city: '', remote: true });
  j2.employerPosting.url = j2.key;
  const skipped = mkJob({ key: 'https://boards.greenhouse.io/no/jobs/3', status: 'skipped' });
  store.updateState((s) => { Object.assign(s, store.emptyState()); s.jobs = { [j1.key]: j1, [j2.key]: j2, [skipped.key]: skipped }; s.contacts[j1.key] = [{ name: 'Bo Lee', title: 'VP Eng', sourceUrl: 'https://newco.test/team', how: 'x', cares: 'y', notConfirmed: true }]; });
  assert.equal(runJobs(home, ['pipeline', 'add']).code, 4, 'no yes at setup, no write');
  assert.deepEqual(snapshot(d), before);
  runJobs(home, ['setup', 'careerops', '--pipeline', 'yes'], { cwd: d });
  const r = runJobs(home, ['pipeline', 'add']);
  assert.equal(r.json.appended, 2);
  const after = snapshot(d);
  for (const f of Object.keys(before)) if (f !== path.join('data', 'pipeline.md')) assert.equal(after[f], before[f], `${f} is byte for byte the same`);
  const expected = before[path.join('data', 'pipeline.md')].replace('\n\n## Done', `\n- [ ] https://boards.greenhouse.io/new/jobs/1 | Newco | Staff Engineer | Berlin | note: write to Bo Lee, VP Eng, not confirmed (https://newco.test/team)\n- [ ] https://boards.greenhouse.io/other/jobs/2 | Other | Engineer / Platform | Remote\n\n## Done`);
  assert.equal(after[path.join('data', 'pipeline.md')], expected, 'inserted at the end of the Pending section, nothing else touched');
  assert.equal(runJobs(home, ['pipeline', 'add']).json.appended, 0, 'each job once');
  assert.deepEqual(Object.keys(after), Object.keys(before));
});

test('career-ops: a missing ## Pending heading is added; a file with no trailing newline stays valid', () => {
  const d = careerOpsDir();
  fs.writeFileSync(path.join(d, 'data', 'pipeline.md'), '# Pipeline\n- [x] https://a.test/1 | A | B | C');
  co.appendPending(d, ['- [ ] https://b.test/2 | X | Y | Z']);
  assert.equal(fs.readFileSync(path.join(d, 'data', 'pipeline.md'), 'utf8'), '# Pipeline\n- [x] https://a.test/1 | A | B | C\n\n## Pending\n- [ ] https://b.test/2 | X | Y | Z\n');
  assert.equal(co.pipelineLine(mkJob({ company: 'A', title: 'B', city: 'C' }), null).includes('note:'), false, 'no note when no person was found');
});

test('career-ops: the pipeline write is refused while a batch is open', () => {
  const d = careerOpsDir();
  runJobs(home, ['setup', 'careerops', '--pipeline', 'yes'], { cwd: d });
  const before = snapshot(d);
  g.openBatch({ mode: 'attended', uploadPath: '/r.pdf' });
  assert.equal(runJobs(home, ['pipeline', 'add']).code, 4);
  assert.deepEqual(snapshot(d), before);
  assert.equal(runJobs(home, ['setup', 'careerops'], { cwd: d }).code, 4);
  g.closeBatch();
});

// ---- 12 and 13. the description, the credit, no decline rule ------------------
test('the description covers the find-jobs uses; credit and the MIT notice are in place', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'job-search', 'SKILL.md'), 'utf8');
  const desc = /^description: >-\n((?:  .+\n)+)/m.exec(skill)[1].replace(/\n\s*/g, ' ').trim();
  for (const w of ['any job hunt', 'only the new postings', 'hiring manager', 'career-ops pipeline', 'attended', 'unattended', 'Do not use it for a cover letter, resume tailoring, interview prep or a job offer']) assert.ok(desc.includes(w) || skill.includes(w), w);
  assert.ok(desc.length < 1536, 'under the listing limit');
  const notice = fs.readFileSync(path.join(ROOT, 'skills', 'job-search', 'references', 'careerops.md'), 'utf8');
  assert.match(notice, /Copyright \(c\) 2026 vraspar/);
  assert.match(notice, /Permission is hereby granted, free of charge/);
  assert.match(fs.readFileSync(path.join(ROOT, 'skills', 'job-search', 'CHANGES.md'), 'utf8'), /vraspar\/find-jobs/);
  assert.match(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), /vraspar\/find-jobs/);
  const all = [skill, ...fs.readdirSync(path.join(ROOT, 'skills', 'job-search', 'references')).map((f) => fs.readFileSync(path.join(ROOT, 'skills', 'job-search', 'references', f), 'utf8'))].join('\n');
  assert.doesNotMatch(all, /If Tenjin offers a paid lookup/i);
  assert.doesNotMatch(all, /(always|must|should) decline/i);
});
