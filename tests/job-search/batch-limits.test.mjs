import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const g = await import('../../skills/job-search/scripts/lib/guard.mjs');
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const ans = await import('../../skills/job-search/scripts/lib/answers.mjs');
const ov = await import('../../skills/job-search/scripts/lib/overlay.mjs');

const U = { roles: ['engineer'], places: ['Berlin'], remote: false, minScore: 70, hosts: ['greenhouse'] };
const profile = { eeo: 'decline_all', resumePath: path.join(home, 'resume.pdf'), facts: { first_name: 'Ada' }, unattended: U };
const J = (cmd) => `node ${path.join(path.resolve(import.meta.dirname, '..', '..'), 'skills', 'job-search', 'scripts', 'jobs.mjs')} ${cmd}`;

// Every command that changes what an unattended submit may do.
const LIMIT_COMMANDS = [
  'rules add --effect daily_max --value 9 --words more',
  'rules remove r1',
  'lessons add --effect drop_query --subject q',
  'lessons remove l1',
  'consent record unattended --optional-writing skip',
  'consent record writing',
  'writing approve k1',
  'answer add --label Q --value A',
  `profile set {"unattended":{"minScore":0}}`,
  'setup resume /tmp/x',
  'setup deepseek --keep',
  'dryrun confirm',
  'batch open --upload /tmp/x',
  'guard uninstall',
  'release apply',
];

test('each of those commands refuses while a batch is open, changes nothing, and exits 4', () => {
  runJobs(home, ['profile', 'set', JSON.stringify(profile)]);
  const before = fs.readFileSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), 'utf8');
  g.openBatch({ mode: 'unattended', uploadPath: profile.resumePath });
  for (const c of LIMIT_COMMANDS) {
    const r = runJobs(home, c.startsWith('profile set') ? ['profile', 'set', '{"unattended":{"minScore":0}}'] : c.split(' '));
    assert.equal(r.code, 4, c);
    assert.match(r.json.error, /refused while a batch is open|attended session|close the batch/, c);
  }
  assert.equal(fs.readFileSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json'), 'utf8'), before);
  assert.deepEqual(ov.loadOverlay(), { rules: [], lessons: [] });
  assert.deepEqual(ans.loadAnswers(), { entries: [] });
  assert.equal(store.loadState().consent.writing, null);
  g.closeBatch();
});

test('the guard denies each of them in an attended and in an unattended batch', () => {
  for (const mode of ['attended', 'unattended']) {
    const p = g.openBatch({ mode, uploadPath: profile.resumePath });
    for (const c of LIMIT_COMMANDS) assert.equal(g.decide({ tool_name: 'Bash', tool_input: { command: J(c) } }, p).decision, 'deny', `${mode}: ${c}`);
    g.closeBatch();
  }
});

test('the guard still allows what a batch needs, and the person-side tightening', () => {
  const p = g.openBatch({ mode: 'unattended', uploadPath: profile.resumePath });
  for (const c of ['work', 'apply next --unattended', 'sheet check k1', 'sheet readback k1 --read f', 'stop k1 --kind captcha', 'dryrun record k1 {}', 'consent revoke writing', 'consent revoke unattended', 'guard probe abc123', 'ingest f.json']) {
    assert.equal(g.decide({ tool_name: 'Bash', tool_input: { command: J(c) } }, p).decision, 'allow', c);
  }
  assert.equal(g.decide({ tool_name: 'Bash', tool_input: { command: J('batch close') } }, p).decision, 'deny', 'only the person closes an unattended batch');
  g.closeBatch();
  const a = g.openBatch({ mode: 'attended', uploadPath: profile.resumePath });
  assert.equal(g.decide({ tool_name: 'Bash', tool_input: { command: J('batch close') } }, a).decision, 'allow');
  g.closeBatch();
});

test('end to end: in an unattended batch with no writing consent, a new-writing job reaches no submit by any of those commands', () => {
  const Q = [{ label: 'First Name', required: true, type: 'input_text' }, { label: 'Resume/CV', required: true, type: 'input_file' }, { label: 'Why us?', required: true, type: 'textarea', maxLength: 300 }];
  const j = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/9', url: 'https://boards.greenhouse.io/acme/jobs/9', status: 'prepared', fit: 90, drafts: { 'Why us?': 'I enjoy building tools.' } });
  store.updateState((s) => { Object.assign(s, store.emptyState()); s.jobs[j.key] = j; });
  fs.rmSync(path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'answers.json'), { force: true });
  runJobs(home, ['profile', 'set', JSON.stringify(profile)]);
  const q = path.join(home, 'q.json');
  fs.writeFileSync(q, JSON.stringify(Q));
  assert.equal(runJobs(home, ['sheet', 'build', j.key, '--questions', q]).code, 0);
  assert.equal(runJobs(home, ['sheet', 'check', j.key]).code, 0);
  // the person records the unattended consent and confirms the dry run, attended, with no batch open
  assert.equal(runJobs(home, ['consent', 'record', 'unattended', '--optional-writing', 'skip']).code, 0);
  runJobs(home, ['dryrun', 'record', j.key, '{}']);
  assert.equal(runJobs(home, ['dryrun', 'confirm']).code, 0);
  // an unattended batch opens and the hook is proven in this session
  runJobs(home, ['guard', 'install']);
  const open = runJobs(home, ['batch', 'open', '--unattended', '--upload', profile.resumePath]);
  const policy = JSON.parse(fs.readFileSync(g.policyFile(), 'utf8'));
  runJobs(home, ['guard', 'hook'], { input: JSON.stringify({ tool_name: 'Bash', session_id: 's', tool_input: { command: `${policy.commandPrefix} guard probe ${open.json.nonce}` } }) });
  // the model tries every command that could loosen the limit, through the CLI and through the hook
  for (const c of LIMIT_COMMANDS) {
    const viaCli = runJobs(home, c.startsWith('profile set') ? ['profile', 'set', '{"x":1}'] : c.split(' '));
    assert.equal(viaCli.code, 4, c);
    const viaHook = runJobs(home, ['guard', 'hook'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: J(c) } }) });
    assert.match(viaHook.stdout, /"permissionDecision":"deny"/, c);
  }
  // direct writes to the state, answers and settings are denied by the hook too
  for (const file of [path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'answers.json'), path.join(home, '.claude', 'settings.json')]) {
    assert.match(runJobs(home, ['guard', 'hook'], { input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file } }) }).stdout, /deny/);
  }
  // and no op can record consent
  assert.equal(runJobs(home, ['ops', '[{"op":"consent","which":"writing"}]']).code, 2);
  const next = runJobs(home, ['apply', 'next', '--unattended']);
  assert.equal(next.code, 4);
  assert.equal(next.json.handout, null);
  assert.deepEqual(next.json.queue, [{ key: j.key, reason: 'writing_needs_yes' }]);
  assert.equal(store.loadState().applications.length, 0);
  assert.equal(store.loadState().jobs[j.key].status, 'apply_ready');
  assert.equal(store.loadState().consent.writing, null);
  assert.deepEqual(ans.loadAnswers().entries, []);
  runJobs(home, ['batch', 'close']);
  // the person, outside the batch, approves the text: now it is an earlier answer and the job is allowed
  assert.equal(runJobs(home, ['writing', 'approve', j.key]).code, 0);
});
