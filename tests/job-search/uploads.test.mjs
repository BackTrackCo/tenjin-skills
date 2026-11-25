import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const store = await import(`${S}store.mjs`);
const rs = await import(`${S}resume.mjs`);
const up = await import(`${S}uploads.mjs`);
const qs = await import(`${S}questions.mjs`);
const { mkJob } = await import('./helpers/env.mjs');
const J = (...a) => runJobs(home, a);
const stateDir = () => path.join(process.env.TENJIN_SKILLS_DIR, 'job-search');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const reset = () => {
  fs.rmSync(stateDir(), { recursive: true, force: true });
  store.updateState((s) => { Object.assign(s, store.emptyState()); });
};
const pdf = () => { const d = tmp('cv-'); const f = path.join(d, 'cv.pdf'); fs.writeFileSync(f, '%PDF-1.4 original'); return f; };

test('J resume set --file keeps the original path, puts a 0600 copy in a 0700 uploads folder, and leaves the original and the state files alone', () => {
  reset();
  const f = pdf();
  const r = J('resume', 'set', '--file', f);
  assert.equal(r.code, 0, r.stdout);
  const prof = J('profile', 'get').json;
  assert.equal(prof.resumePath, f, 'the profile keeps the path');
  const copy = path.join(stateDir(), 'uploads', 'cv.pdf');
  assert.equal(prof.resumeUploadPath, copy);
  assert.equal(fs.readFileSync(copy, 'utf8'), '%PDF-1.4 original');
  assert.equal(fs.statSync(path.dirname(copy)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(copy).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f, 'utf8'), '%PDF-1.4 original', 'the original is not touched');
  assert.deepEqual(fs.readdirSync(path.join(stateDir(), 'uploads')), ['cv.pdf'], 'the copy keeps the original name; no state file lives in the uploads folder');
  assert.ok(fs.existsSync(path.join(stateDir(), 'profile.json')), 'the state files stay in the parent');
  J('batch', 'open');
  assert.equal(store.loadState().batch.uploadPath, copy, 'the browser task uploads the copy');
  J('batch', 'close');
});

test('a PDF from a link is saved in the uploads folder, and resume.txt stays in the state folder', async () => {
  reset();
  const resp = (status, body, type) => ({ status, ok: true, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) }, text: async () => String(body), arrayBuffer: async () => Buffer.from(String(body)) });
  const pub = async () => [{ address: '93.184.216.34', family: 4 }];
  const a = await rs.fetchResume('https://cv.example.test/me.pdf', async () => resp(200, '%PDF-1.4 data', 'application/pdf'), { lookup: pub });
  assert.equal(a.resumePath, path.join(stateDir(), 'uploads', 'resume.pdf'));
  assert.equal(a.resumeUploadPath, a.resumePath);
  assert.equal(fs.statSync(a.resumePath).mode & 0o777, 0o600);
  const b = rs.setText('Typed resume text');
  assert.equal(b.resumeTextFile, path.join(stateDir(), 'resume.txt'));
  assert.equal(fs.existsSync(path.join(stateDir(), 'uploads', 'resume.txt')), false);
});

test('there is no migration: a saved resume file outside the uploads folder is not copied by any command', () => {
  reset();
  const old = path.join(stateDir(), 'resume.pdf');
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(old, '%PDF-1.4 saved before');
  fs.writeFileSync(path.join(stateDir(), 'profile.json'), JSON.stringify({ resumeSource: 'link', resumePath: old }));
  assert.equal(J('arm').code, 0);
  assert.equal(fs.existsSync(path.join(stateDir(), 'uploads')), false, 'nothing is copied on read');
  assert.equal(J('profile', 'get').json.resumeUploadPath, undefined);
  assert.equal(up.migrateResume, undefined);
  // the person's own J resume set puts the copy in place
  assert.equal(J('resume', 'set', '--file', old).code, 0);
  assert.equal(fs.readFileSync(path.join(stateDir(), 'uploads', 'resume.pdf'), 'utf8'), '%PDF-1.4 saved before');
});

// ---- staging in the working folder -------------------------------------------------------------------------
const proj = () => tmp('cc-proj-');
const snapshot = (d) => fs.readdirSync(d, { recursive: true }).sort();
function setup(dir) {
  reset();
  process.env.CLAUDE_PROJECT_DIR = dir;
  const f = path.join(tmp('cv-'), 'Ada Lovelace Resume.pdf');
  fs.writeFileSync(f, '%PDF-1.4 ada');
  J('resume', 'set', '--file', f);
  const job = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/1', status: 'apply_ready', company: 'Acme', sheet: { hash: 'h', passed: true, eeoMissing: false, unanswered: [], forbidden: [], fields: [{ label: 'Resume/CV', value: '<resume>', tag: 'upload', required: true }] } });
  store.updateState((s) => { s.jobs[job.key] = job; });
  return job;
}

test('the staged copy keeps the original name, sits in a hidden folder of the working folder, and is deleted after the upload', () => {
  const dir = proj();
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
  const job = setup(dir);
  try {
    const before = snapshot(dir);
    const r = J('uploads', 'stage', job.key);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.staged, path.join(dir, '.job-search-upload', 'Ada Lovelace Resume.pdf'));
    assert.equal(r.json.name, 'Ada Lovelace Resume.pdf');
    assert.equal(fs.readFileSync(r.json.staged, 'utf8'), '%PDF-1.4 ada');
    assert.equal(fs.statSync(r.json.staged).mode & 0o777, 0o600);
    assert.deepEqual(snapshot(dir), [...before, '.job-search-upload', '.job-search-upload/Ada Lovelace Resume.pdf'].sort());
    assert.equal(J('uploads', 'unstage', job.key).code, 0);
    assert.deepEqual(snapshot(dir), before, 'nothing else in the working folder changed');
    assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'mine');
  } finally { delete process.env.CLAUDE_PROJECT_DIR; }
});

test('the handout names the staged path and the steps; a stop, the read-back, may-submit and the outcome all remove the copy', () => {
  const dir = proj();
  const job = setup(dir);
  store.updateState((s) => { s.approvals[job.key] = { sheetHash: 'h' }; });
  try {
    J('batch', 'open');
    const h = J('apply', 'next').json.handout;
    assert.equal(h.resume, path.join(dir, '.job-search-upload', 'Ada Lovelace Resume.pdf'));
    assert.equal(h.stage, `J uploads stage ${job.key}`);
    assert.equal(h.unstage, `J uploads unstage ${job.key}`);
    for (const later of [['may-submit', job.key, 'h'], ['stop', job.key, '--kind', 'unknown_field'], ['submitted', job.key], ['ops', JSON.stringify([{ op: 'transition', key: job.key, to: 'submitted' }])], ['sheet', 'readback', job.key, '--read', '[]']]) {
      J('uploads', 'stage', job.key);
      assert.ok(fs.existsSync(path.join(dir, '.job-search-upload')));
      J(...later);
      assert.equal(fs.existsSync(path.join(dir, '.job-search-upload')), false, later.slice(0, 2).join(' '));
    }
  } finally { delete process.env.CLAUDE_PROJECT_DIR; }
});

test('a copy is removed after a failure too, and a leftover folder is removed at the next apply step, by its exact name only', () => {
  const dir = proj();
  const job = setup(dir);
  try {
    fs.mkdirSync(path.join(dir, '.job-search-upload'));
    fs.writeFileSync(path.join(dir, '.job-search-upload', 'old.pdf'), 'left');
    fs.mkdirSync(path.join(dir, '.job-search-other'));
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
    J('batch', 'open');
    J('apply', 'next');
    assert.equal(fs.existsSync(path.join(dir, '.job-search-upload')), false, 'the leftover folder is gone');
    assert.deepEqual(snapshot(dir), ['.job-search-other', 'keep.txt'], 'nothing else was touched');
    J('uploads', 'stage', job.key);
    J('stop', job.key, '--kind', 'upload_blocked');
    assert.equal(fs.existsSync(path.join(dir, '.job-search-upload')), false, 'deleted after a failed upload');
  } finally { delete process.env.CLAUDE_PROJECT_DIR; }
});

test('a link or a file by that name is refused and never followed; an unwritable folder fills the job without the file and says so once', () => {
  const dir = proj();
  const job = setup(dir);
  const outside = tmp('outside-');
  try {
    fs.symlinkSync(outside, path.join(dir, '.job-search-upload'));
    const a = J('uploads', 'stage', job.key);
    assert.equal(a.json.staged, null);
    assert.match(a.json.line, /is a link, so nothing was copied/);
    assert.deepEqual(fs.readdirSync(outside), [], 'the link was not followed');
    J('batch', 'open');
    J('apply', 'next');
    assert.ok(fs.lstatSync(path.join(dir, '.job-search-upload')).isSymbolicLink(), 'a link is left alone by the cleanup');
    fs.rmSync(path.join(dir, '.job-search-upload'));
    fs.writeFileSync(path.join(dir, '.job-search-upload'), 'a file');
    assert.match(J('uploads', 'stage', job.key).json.line, /is a file/);
    fs.rmSync(path.join(dir, '.job-search-upload'));
    // unwritable
    fs.chmodSync(dir, 0o500);
    if (process.getuid && process.getuid() !== 0) {
      const b = J('uploads', 'stage', job.key);
      assert.equal(b.json.staged, null);
      assert.match(b.json.line, /cannot be written/);
      J('uploads', 'stage', job.key);
      const lines = store.loadState().uploadLines.filter((l) => /cannot be written/.test(l));
      assert.equal(lines.length, 1, 'one report line');
      fs.chmodSync(dir, 0o700);
      assert.match(J('report', '--all').stdout, /Upload: Acme: the resume was not attached/);
    }
  } finally { fs.chmodSync(dir, 0o700); delete process.env.CLAUDE_PROJECT_DIR; }
});

test('no text asks for /add-dir or "go on", and the grant path is gone', () => {
  const root = path.join(import.meta.dirname, '..', '..');
  const texts = [path.join(root, 'README.md'), path.join(root, 'skills', 'job-search', 'SKILL.md'), ...fs.readdirSync(path.join(root, 'skills', 'job-search', 'references')).map((f) => path.join(root, 'skills', 'job-search', 'references', f)), ...fs.readdirSync(path.join(root, 'skills', 'job-search', 'scripts', 'lib')).map((f) => path.join(root, 'skills', 'job-search', 'scripts', 'lib', f)), path.join(root, 'skills', 'job-search', 'scripts', 'jobs.mjs')];
  for (const t of texts.filter((x) => fs.statSync(x).isFile())) {
    const body = fs.readFileSync(t, 'utf8');
    assert.doesNotMatch(body, /add-dir|additionalDirectories|uploadBlockedStep|uploadsLine|uploadsGranted|uploads set granted|then say go on|say go on/, t);
  }
  const skill = fs.readFileSync(path.join(root, 'skills', 'job-search', 'SKILL.md'), 'utf8');
  assert.ok(skill.length <= 10000, `${skill.length}`);
  assert.match(skill, /J uploads stage/);
  assert.equal(J('uploads', 'set', 'granted').code, 2);
});

test('an old uploads grant in state is refused with the field named', () => {
  reset();
  store.updateState((s) => { s.uploads = 'granted'; });
  const r = J('report');
  assert.equal(r.code, 2);
  assert.match(r.json.error, /uploads \(the uploads folder grant is gone/);
});
