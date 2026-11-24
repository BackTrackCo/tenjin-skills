import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const report = await import('../../skills/job-search/scripts/lib/report.mjs');

// A fake tenjin under the temporary HOME, as the installer would put it. It logs every call.
const bin = path.join(home, '.local', 'bin');
fs.mkdirSync(bin, { recursive: true });
const balFile = path.join(home, 'balance-atomic');
const log = path.join(home, 'tenjin-calls.log');
fs.writeFileSync(balFile, '5000000');
fs.writeFileSync(path.join(bin, 'tenjin'), `#!/bin/sh
echo "$@" >> "${log}"
case "$*" in
  "--version") echo "0.1.0-alpha.35" ;;
  "balance --json") a=$(cat "${balFile}"); printf '{"schemaVersion":1,"command":"balance","ok":true,"data":{"balance":{"atomic":"%s","usd":"$0"}}}\\n' "$a" ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
`, { mode: 0o755 });
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);

test('`J tenjin` only sets the hint state, from --version and balance --json; it never stops or changes anything', () => {
  fs.rmSync(log, { force: true });
  assert.equal(runJobs(home, ['tenjin']).json.status, 'ready');
  assert.deepEqual(calls(), ['--version', 'balance --json']);
  assert.equal(store.loadState().tenjin.status, 'ready');
  fs.writeFileSync(balFile, '0');
  assert.equal(runJobs(home, ['tenjin']).json.status, 'unfunded');
  fs.writeFileSync(balFile, '5000000');
  runJobs(home, ['tenjin']);
  const c = runJobs(home, ['setup', 'check']);
  assert.equal(c.json.tenjin.status, 'ready');
  assert.equal(c.json.deepseek, undefined, 'no DeepSeek question, no DeepSeek read');
  assert.ok(calls().every((x) => ['--version', 'balance --json'].includes(x)), 'no Tenjin setting is read for DeepSeek or changed');
});

test('there are no guard or DeepSeek commands any more', () => {
  for (const args of [['guard', 'install'], ['guard', 'hook'], ['setup', 'deepseek']]) {
    const r = runJobs(home, args);
    assert.notEqual(r.code, 0, args.join(' '));
  }
  assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false, 'no settings file is written');
});

test('apply next refuses without an open batch', () => {
  store.updateState((s) => { const j = mkJob({ status: 'apply_ready' }); s.jobs[j.key] = j; });
  const r = runJobs(home, ['apply', 'next']);
  assert.equal(r.code, 4);
  assert.equal(r.json.refused, 'no_batch');
});

test('consent is refused until the unattended rules and the EEO choice are set', () => {
  assert.equal(runJobs(home, ['consent', 'record', 'unattended', '--optional-writing', 'skip']).code, 2);
  runJobs(home, ['profile', 'set', JSON.stringify({ eeo: 'decline_all', unattended: { roles: ['engineer'], places: ['Berlin'], minScore: 70, hosts: ['greenhouse'] } })]);
  const r = runJobs(home, ['consent', 'record', 'unattended', '--optional-writing', 'skip']);
  assert.equal(r.code, 0);
  assert.match(r.json.rulesHash, /^[0-9a-f]{64}$/);
});

test('stop parks the job, records the stop, two captcha stops on a host make a lesson; one notification', () => {
  const a = mkJob({ company: 'Initech', ats: 'lever' });
  const b = mkJob({ company: 'Hooli', ats: 'lever' });
  store.updateState((s) => { s.jobs = { [a.key]: a, [b.key]: b }; s.notified = {}; s.held = []; });
  runJobs(home, ['stop', a.key, '--kind', 'captcha']);
  runJobs(home, ['stop', b.key, '--kind', 'captcha']);
  assert.equal(store.loadState().jobs[a.key].parked.reasons[0], 'captcha');
  const les = runJobs(home, ['lessons', 'derive']);
  assert.deepEqual(les.json.map((l) => l.effect).sort(), ['host_attended', 'host_last']);
  const w1 = runJobs(home, ['work', '--commit']);
  assert.match(w1.json.notify, /2 stops need you/);
  assert.equal(w1.code, 3, 'parked jobs are not work items');
  assert.equal(runJobs(home, ['work', '--commit']).json.notify, null);
});

test('sheet build, check and approve through the CLI, then apply next in an open batch', () => {
  const j = mkJob({ status: 'prepared', title: 'Platform Engineer', company: 'Globex' });
  store.updateState((s) => { s.jobs = { [j.key]: j }; s.notified = {}; s.held = []; s.applications = []; });
  const q = path.join(home, 'q.json');
  fs.writeFileSync(q, JSON.stringify([{ label: 'First Name', required: true, type: 'input_text' }, { label: 'Email', required: true, type: 'input_text' }]));
  runJobs(home, ['profile', 'set', JSON.stringify({ facts: { first_name: 'Ada', email: 'ada@example.com' }, eeo: 'decline_all', resumePath: path.join(home, 'resume.pdf') })]);
  const built = runJobs(home, ['sheet', 'build', j.key, '--questions', q]);
  assert.equal(built.json.fields.length, 2);
  assert.equal(runJobs(home, ['sheet', 'check', j.key]).code, 0);
  assert.equal(store.loadState().jobs[j.key].status, 'apply_ready');
  assert.equal(runJobs(home, ['batch', 'open']).code, 0);
  assert.equal(runJobs(home, ['apply', 'next']).json.queue[0].reason, 'no_recorded_yes');
  assert.equal(runJobs(home, ['approve', j.key]).code, 0);
  const next = runJobs(home, ['apply', 'next']);
  assert.equal(next.code, 0, next.stdout);
  assert.equal(next.json.handout.key, j.key);
  runJobs(home, ['batch', 'close']);
});

test('the report renders from state: new jobs by fit, held sources, rules, contacts offer', () => {
  const s = store.emptyState();
  const a = mkJob({ fit: 90, fitLine: 'great fit', title: 'Staff Engineer' });
  const b = mkJob({ fit: 50, title: 'Engineer', company: 'Globex' });
  s.jobs = { [a.key]: a, [b.key]: b };
  s.held = [{ reason: 'source_empty', detail: 'Figma: rate limited (429)' }];
  const text = report.renderReport(s, { rules: [{ id: 'r1', effect: 'period_max', value: 5, words: 'at most 5 a day', date: '2026-11-23' }], lessons: [] });
  assert.ok(text.indexOf('Staff Engineer') < text.indexOf('Globex'));
  assert.match(text, /Figma: rate limited/);
  assert.match(text, /"at most 5 a day"/);
  assert.match(text, /5 if you do not say/);
});

test('a state or rules write never lands outside the temporary HOME', () => {
  assert.ok(process.env.TENJIN_SKILLS_DIR.startsWith(home));
  assert.ok(fs.existsSync(path.join(home, '.tenjin-skills', 'job-search', 'state.json')));
});

test('profile set refuses a bad shape with the reason, and saves nothing', () => {
  const file = path.join(home, '.tenjin-skills', 'job-search', 'profile.json');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  for (const [bad, msg] of [
    [{ places: [{ city: 'San Francisco' }] }, /places must be a list of strings/],
    [{ search: { role: 'x', roleWords: 'dev' } }, /search\.roleWords must be a list of strings/],
    [{ search: { place: 'Berlin' } }, /search needs a role/],
    [{ watch: ['https://boards.greenhouse.io/acme'] }, /watch must be a list/],
    [{ windowDays: 'ten' }, /windowDays/],
    [{ sweepHour: 25 }, /sweepHour/],
    [{ unattended: { roles: 'engineer' } }, /unattended\.roles/],
    [{ facts: { first_name: { a: 1 } } }, /facts/],
    [{ eeo: 'yes' }, /eeo/],
  ]) {
    const r = runJobs(home, ['profile', 'set', JSON.stringify(bad)]);
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.match(r.json.error, msg);
  }
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, before);
  const ok = runJobs(home, ['profile', 'set', JSON.stringify({ places: ['San Francisco'], remote: true, search: { role: 'software engineer', roleWords: ['developer'] }, watch: [{ url: 'https://boards.greenhouse.io/acme' }] })]);
  assert.equal(ok.code, 0);
});
