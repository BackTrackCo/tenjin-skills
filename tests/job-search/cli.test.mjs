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
const flag = path.join(home, 'ds-on');
const log = path.join(home, 'tenjin-calls.log');
fs.writeFileSync(path.join(bin, 'tenjin'), `#!/bin/sh
echo "$@" >> "${log}"
case "$*" in
  "--version") echo "tenjin 0.1.0-alpha.35" ;;
  "config subagents --json") if [ -e "${flag}" ]; then echo '{"schemaVersion":1,"ok":true,"data":{"enabled":true,"consent":true}}'; else echo '{"schemaVersion":1,"ok":true,"data":{"enabled":false}}'; fi ;;
  "config subagents off") rm -f "${flag}" ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
`, { mode: 0o755 });
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);

test('setup check and the Tenjin check use the released CLI under a temporary HOME', () => {
  const r = runJobs(home, ['tenjin']);
  assert.equal(r.json.status, 'present');
  const c = runJobs(home, ['setup', 'check']);
  assert.equal(c.json.deepseek.enabled, false);
  assert.equal(c.json.guardInstalled, false);
});

test('DeepSeek on: setup explains and changes nothing until the yes', () => {
  fs.writeFileSync(flag, '1');
  fs.rmSync(log, { force: true });
  const ask = runJobs(home, ['setup', 'deepseek']);
  assert.equal(ask.json.state, 'on_ask');
  assert.ok(!calls().includes('config subagents off'));
  const yes = runJobs(home, ['setup', 'deepseek', '--yes']);
  assert.equal(yes.json.state, 'turned_off');
  assert.equal(calls().filter((c) => c === 'config subagents off').length, 1);
  assert.equal(store.loadState().setup.deepseek, 'turned_off');
});

test('DeepSeek kept on: recorded, and apply next holds with deepseek_on', () => {
  fs.writeFileSync(flag, '1');
  assert.equal(runJobs(home, ['setup', 'deepseek', '--keep']).json.state, 'on_kept');
  assert.ok(store.loadState().held.some((h) => h.reason === 'deepseek_on'));
  fs.rmSync(flag);
});

test('guard install and uninstall through the CLI touch only the temporary settings.json', () => {
  const settings = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark' }));
  assert.equal(runJobs(home, ['guard', 'install']).code, 0);
  assert.equal(runJobs(home, ['setup', 'check']).json.guardInstalled, true);
  assert.equal(runJobs(home, ['guard', 'uninstall']).json.removed, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { theme: 'dark' });
});

test('apply next refuses without a passing guard self-test', () => {
  store.updateState((s) => { const j = mkJob({ status: 'apply_ready' }); s.jobs[j.key] = j; });
  const r = runJobs(home, ['apply', 'next']);
  assert.equal(r.code, 4);
  assert.equal(r.json.refused, 'guard_missing');
  assert.ok(store.loadState().held.some((h) => h.reason === 'guard_missing'));
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

test('sheet build, check and approve through the CLI, then apply next with a passing guard', () => {
  const j = mkJob({ status: 'prepared', title: 'Platform Engineer', company: 'Globex' });
  store.updateState((s) => { s.jobs = { [j.key]: j }; s.notified = {}; s.held = []; s.applications = []; });
  const q = path.join(home, 'q.json');
  fs.writeFileSync(q, JSON.stringify([{ label: 'First Name', required: true, type: 'input_text' }, { label: 'Email', required: true, type: 'input_text' }]));
  runJobs(home, ['profile', 'set', JSON.stringify({ facts: { first_name: 'Ada', email: 'ada@example.com' }, eeo: 'decline_all', resumePath: path.join(home, 'resume.pdf') })]);
  const built = runJobs(home, ['sheet', 'build', j.key, '--questions', q]);
  assert.equal(built.json.fields.length, 2);
  assert.equal(runJobs(home, ['sheet', 'check', j.key]).code, 0);
  assert.equal(store.loadState().jobs[j.key].status, 'apply_ready');
  runJobs(home, ['guard', 'install']);
  const open = runJobs(home, ['batch', 'open']);
  const probeCmd = `node ${path.join(path.resolve(import.meta.dirname, '..', '..'), 'skills', 'job-search', 'scripts', 'jobs.mjs')} guard probe ${open.json.nonce}`;
  runJobs(home, ['guard', 'hook'], { input: JSON.stringify({ tool_name: 'Bash', session_id: 's', tool_input: { command: probeCmd } }) });
  assert.equal(runJobs(home, ['apply', 'next']).json.queue[0].reason, 'no_recorded_yes');
  assert.equal(runJobs(home, ['approve', j.key]).code, 0);
  const next = runJobs(home, ['apply', 'next']);
  assert.equal(next.code, 0, next.stdout);
  assert.equal(next.json.handout.key, j.key);
  runJobs(home, ['batch', 'close']);
  runJobs(home, ['guard', 'uninstall']);
});

test('the report renders from state: new jobs by fit, held sources, rules, contacts offer', () => {
  const s = store.emptyState();
  const a = mkJob({ fit: 90, fitLine: 'great fit', title: 'Staff Engineer' });
  const b = mkJob({ fit: 50, title: 'Engineer', company: 'Globex' });
  s.jobs = { [a.key]: a, [b.key]: b };
  s.held = [{ reason: 'source_empty', detail: 'Figma: rate limited (429)' }];
  const text = report.renderReport(s, { rules: [{ id: 'r1', effect: 'daily_max', value: 5, words: 'at most 5 a day', date: '2026-11-23' }], lessons: [] });
  assert.ok(text.indexOf('Staff Engineer') < text.indexOf('Globex'));
  assert.match(text, /Figma: rate limited/);
  assert.match(text, /"at most 5 a day"/);
  assert.match(text, /5 if you do not say/);
});

test('a state or rules write never lands outside the temporary HOME', () => {
  assert.ok(process.env.TENJIN_SKILLS_DIR.startsWith(home));
  assert.ok(fs.existsSync(path.join(home, '.tenjin-skills', 'job-search', 'state.json')));
});
