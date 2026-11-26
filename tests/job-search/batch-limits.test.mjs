import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkJob, runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const b = await import('../../skills/job-search/scripts/lib/batch.mjs');
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const ans = await import('../../skills/job-search/scripts/lib/answers.mjs');
const ov = await import('../../skills/job-search/scripts/lib/overlay.mjs');

const U = { roles: ['engineer'], places: ['Berlin'], remote: false, minScore: 70, hosts: ['greenhouse'] };
const profile = { eeoText: 'Decline every voluntary demographic question (test placeholder).', referrals: { acme: { status: 'none' } }, resumePath: path.join(home, 'resume.pdf'), facts: { first_name: 'Ada' }, unattended: U };

// Every command that changes what a submit may do. With no hook, the CLI is the line that holds.
const LIMIT_COMMANDS = [
  ['rules', 'add', '--effect', 'period_max', '--value', '9', '--words', 'more'],
  ['rules', 'remove', 'r1'],
  ['consent', 'record', 'unattended', '--optional-writing', 'skip'],
  ['consent', 'record', 'writing'],
  ['writing', 'approve', 'k1'],
  ['answer', 'add', '--label', 'Q', '--value', 'A'],
  ['fact', 'set', 'phone', '+49123'],
  ['profile', 'set', '{"unattended":{"minScore":0}}'],
  ['frequency', 'set', 'weekly'],
  ['start', 'record', '--mode', 'auto_write'],
  ['watch', 'remove', 'acme'],
  ['dryrun', 'confirm'],
  ['batch', 'open', '--unattended'],
  ['release', 'apply'],
  ['intros', 'save', 'k1', '--result', '/tmp/x'],
];

test('the denied list names each of them, and nothing the batch needs', () => {
  for (const c of LIMIT_COMMANDS) assert.ok(b.isBatchDenied(c[0], c[1]), c.slice(0, 2).join(' '));
  for (const [c, s] of [['work'], ['apply', 'next'], ['sheet', 'check'], ['stop'], ['dryrun', 'record'], ['consent', 'revoke'], ['batch', 'close'], ['ingest'], ['hn'], ['report'], ['unpark']]) assert.equal(b.isBatchDenied(c, s), false, `${c} ${s}`);
});

test('each of those commands refuses while a batch is open, changes nothing, and exits 4', () => {
  runJobs(home, ['profile', 'set', JSON.stringify(profile)]);
  const file = path.join(process.env.TENJIN_SKILLS_DIR, 'job-search', 'profile.json');
  const before = fs.readFileSync(file, 'utf8');
  b.openBatch({ mode: 'unattended', uploadPath: profile.resumePath });
  for (const c of LIMIT_COMMANDS) {
    const r = runJobs(home, c);
    assert.equal(r.code, 4, c.join(' '));
    assert.match(r.json.error, /refused while a batch is open/, c.join(' '));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(ov.loadOverlay(), { rules: [], lessons: [] });
  assert.deepEqual(ans.loadAnswers(), { entries: [] });
  assert.equal(store.loadState().consent.writing, null);
  b.closeBatch();
});

test('the same commands work once the batch is closed (an attended session)', () => {
  assert.equal(runJobs(home, ['frequency', 'set', 'weekly']).code, 0);
  assert.equal(runJobs(home, ['rules', 'add', '--effect', 'period_max', '--value', '9', '--words', 'nine']).code, 0);
  assert.equal(runJobs(home, ['fact', 'set', 'phone', '+49123']).code, 0);
});

test('a batch is a record in state.json, not a file or a hook', () => {
  const p = b.openBatch({ mode: 'attended', uploadPath: '/r.pdf' });
  assert.deepEqual(Object.keys(p).sort(), ['denied', 'mode', 'openedAt', 'touchedAt', 'uploadPath']);
  assert.ok(p.denied.includes('linkedin.com') && p.denied.includes('x.com'), 'the deny list comes only from graph.json');
  assert.deepEqual(store.loadState().batch, p);
  assert.equal(fs.existsSync(path.join(process.env.TENJIN_SKILLS_DIR, 'guard')), false, 'the guard folder is gone');
  assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false, 'no settings are written');
  b.closeBatch();
  assert.equal(store.loadState().batch, null);
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
  assert.equal(runJobs(home, ['consent', 'record', 'unattended', '--optional-writing', 'skip']).code, 0);
  runJobs(home, ['dryrun', 'record', j.key, '{}']);
  assert.equal(runJobs(home, ['dryrun', 'confirm']).code, 0);
  assert.equal(runJobs(home, ['batch', 'open', '--unattended', '--upload', profile.resumePath]).code, 0);
  for (const c of LIMIT_COMMANDS) assert.equal(runJobs(home, c).code, 4, c.join(' '));
  assert.equal(runJobs(home, ['ops', '[{"op":"consent","which":"writing"}]']).code, 2);
  const next = runJobs(home, ['apply', 'next', '--unattended']);
  assert.equal(next.code, 4);
  assert.equal(next.json.handout, null);
  assert.deepEqual(next.json.queue, [{ key: j.key, reason: 'writing_needs_yes' }]);
  assert.equal(next.json.batchClosed, true);
  assert.equal(store.loadState().applications.length, 0);
  assert.equal(store.loadState().consent.writing, null);
  assert.deepEqual(ans.loadAnswers().entries, []);
  // the person, outside the batch, approves the text: now it is an earlier answer
  assert.equal(runJobs(home, ['writing', 'approve', j.key]).code, 0);
});
