import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const work = await import('../../skills/job-search/scripts/lib/work.mjs');
const lease = await import('../../skills/job-search/scripts/lib/lease.mjs');
const watcher = await import('../../skills/job-search/scripts/lib/watcher.mjs');
const report = await import('../../skills/job-search/scripts/lib/report.mjs');
const q = await import('../../skills/job-search/scripts/lib/questions.mjs');

const NOW = Date.parse('2026-11-24T12:00:00Z');
const empty = { rules: [], lessons: [] };
const rule = (effect, value) => ({ rules: [{ id: effect, effect, value, words: 'w', date: '2026-11-24' }], lessons: [] });
const reset = (jobs = []) => {
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'rules.json'), { force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState()); for (const j of jobs) s.jobs[j.key] = j; });
};
const noPosting = (i, fit) => mkJob({ key: `https://www.example-jobs.test/view/${i}`, status: 'reviewed', employerPosting: null, openConfirmed: false, unresolved: 'no_board', company: `Co${i}`, fit, employerWebsite: `co${i}.test`, v: 1 });

test('reverify_due is not an item and never wakes: the watcher\'s sweep re-verifies', async () => {
  const j = mkJob({ status: 'reviewed', verifiedAt: new Date(NOW - 3 * 86400000).toISOString() });
  reset([j]);
  const wl = work.workList({ now: NOW });
  assert.equal(wl.items.some((i) => i.reason === 'reverify_due'), false);
  await lease.claimLease({ holder: 'w', now: NOW });
  assert.deepEqual((await watcher.tick({ holder: 'w', now: NOW + 1000, seen: { sig: null } })).lines, []);
});

test('a release line goes to the report and the notify set, never a wake of its own', async () => {
  reset();
  store.updateState((s) => { s.updateLines = ['Updated Job Search to v0.1.1: a fix.']; });
  const n = work.notifyLine(store.loadState(), empty, NOW);
  assert.match(n.line, /1 update for the report/);
  assert.match(report.renderReport(store.loadState(), empty, { now: NOW }), /Updated Job Search to v0\.1\.1/);
  await lease.claimLease({ holder: 'w', now: NOW });
  const lines = (await watcher.tick({ holder: 'w', now: NOW + 1000, seen: { sig: null } })).lines;
  assert.ok(lines.every((l) => !/Updated Job Search/.test(l)), 'the release line is not the wake');
});

test('employer_page only for the jobs this period can use: best fit within the positions rule, above the score floor', () => {
  const jobs = [noPosting(1, 90), noPosting(2, 80), noPosting(3, 70), noPosting(4, 20)];
  reset(jobs);
  const items = (o, profile = {}) => work.buildWorkList(store.loadState(), o, NOW, profile).items.filter((i) => i.reason === 'employer_page').map((i) => i.company).sort();
  assert.deepEqual(items(empty), ['Co1', 'Co2', 'Co3', 'Co4'], 'no limit and no floor: all');
  assert.deepEqual(items(rule('period_max', 2)), ['Co1', 'Co2'], 'within the positions rule, best fit first');
  assert.deepEqual(items(empty, { unattended: { minScore: 75 } }), ['Co1', 'Co2'], 'above the floor');
  assert.deepEqual(items(rule('period_max', 1), { unattended: { minScore: 75 } }), ['Co1']);
  assert.deepEqual(items(rule('period_max', 'none')), ['Co1', 'Co2', 'Co3', 'Co4']);
});

test('follow_up_due never wakes; the question tool asks what happened and J outcome records it', async () => {
  const j = mkJob({ status: 'submitted', statusAt: new Date(NOW - 20 * 86400000).toISOString(), company: 'Initech', v: 1 });
  reset([j]);
  const item = work.workList({ now: NOW }).items.find((i) => i.reason === 'follow_up_due');
  assert.equal(item.waitsForPerson, true);
  await lease.claimLease({ holder: 'w', now: NOW });
  const first = (await watcher.tick({ holder: 'w', now: NOW + 1000, seen: { sig: null } })).lines;
  assert.ok(first.every((l) => !/follow_up_due/.test(l)), 'not a wake item');
  const p = runJobs(home, ['ask', 'follow_up', '--json', JSON.stringify({ company: 'Initech', title: 'Engineer' })]).json;
  assert.deepEqual(q.validateAsk(p), []);
  assert.match(p.questions[0].options[0].label, /\(Recommended\)$/);
  assert.equal(runJobs(home, ['outcome', j.key, '--status', 'interview']).json.status, 'interview');
  assert.ok(store.loadState().jobs[j.key].followUpAsked);
  assert.equal(store.loadState().signals.counts.interview, 1);
  assert.equal(runJobs(home, ['outcome', j.key, '--status', 'sideways']).code, 2);
  assert.equal(runJobs(home, ['outcome', 'nope', '--status', 'reply']).code, 2);
});

test('the watcher logs each wake with its reason counts, and the report shows the day\'s wakes', async () => {
  reset([noPosting(1, 90), noPosting(2, 80)]);
  await lease.claimLease({ holder: 'w', now: NOW });
  const lines = (await watcher.tick({ holder: 'w', now: NOW + 1000, seen: { sig: null } })).lines;
  assert.equal(lines.length, 1);
  assert.deepEqual(store.loadState().wakes.map((w) => w.counts), [{ employer_page: 2 }]);
  assert.deepEqual((await watcher.tick({ holder: 'w', now: NOW + 2000, seen: { sig: null } })).lines, []);
  assert.equal(store.loadState().wakes.length, 1, 'no wake, no log entry');
  assert.match(report.renderReport(store.loadState(), empty, { now: NOW + 3000 }), /Model wakes in the last day: 1 \(2 employer_page\)/);
  assert.doesNotMatch(report.renderReport(store.loadState(), empty, { now: NOW + 3 * 86400000 }), /Model wakes in the last day/);
});

test('no script starts claude: the orchestrator and the Monitor stay, and no model step is a headless process', () => {
  const dir = path.join(import.meta.dirname, '..', '..', 'skills', 'job-search');
  const files = [path.join(dir, 'scripts', 'jobs.mjs'), ...fs.readdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true }).filter((f) => f.endsWith('.mjs')).map((f) => path.join(dir, 'scripts', 'lib', f))];
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /spawn(Sync)?\([^)]*['"`]claude['"`]/, path.basename(f));
    assert.doesNotMatch(t, /exec(Sync|File)?\([^)]*claude/, path.basename(f));
    assert.doesNotMatch(t, /claude\s+-p\b|--print|headless/i, path.basename(f));
  }
  const refs = [path.join(dir, 'SKILL.md'), ...fs.readdirSync(path.join(dir, 'references')).map((f) => path.join(dir, 'references', f))].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.doesNotMatch(refs, /claude -p\b/);
});
