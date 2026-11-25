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
  const copy = path.join(stateDir(), 'uploads', 'resume.pdf');
  assert.equal(prof.resumeUploadPath, copy);
  assert.equal(fs.readFileSync(copy, 'utf8'), '%PDF-1.4 original');
  assert.equal(fs.statSync(path.dirname(copy)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(copy).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f, 'utf8'), '%PDF-1.4 original', 'the original is not touched');
  assert.deepEqual(fs.readdirSync(path.join(stateDir(), 'uploads')), ['resume.pdf'], 'no state file lives in the uploads folder');
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

// ---- the grant check ---------------------------------------------------------------------------------------
const settings = (d, rel, dirs, extra = {}) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), JSON.stringify({ ...extra, permissions: { additionalDirectories: dirs } })); };
const ctx = () => ({ cfg: tmp('cc-cfg-'), project: tmp('cc-proj-') });
const granted = (c, extra = {}) => up.uploadsGranted({ env: { CLAUDE_CONFIG_DIR: c.cfg }, home: '/nonexistent', project: c.project, ...extra });

test('the grant check reads only additionalDirectories, from user, project and local settings; the folder or a parent counts', () => {
  const c = ctx();
  const dir = up.uploadsDir();
  assert.equal(granted(c), false, 'no settings: not granted');
  settings(c.cfg, 'settings.json', ['/somewhere/else']);
  assert.equal(granted(c), false);
  settings(c.cfg, 'settings.json', [dir]);
  assert.equal(granted(c), true, 'the user settings list the folder');
  settings(c.cfg, 'settings.json', [path.dirname(dir)]);
  assert.equal(granted(c), true, 'a parent folder counts');
  const c2 = ctx();
  settings(c2.project, '.claude/settings.json', [dir]);
  assert.equal(granted(c2), true, 'the project settings');
  const c3 = ctx();
  settings(c3.project, '.claude/settings.local.json', [dir + path.sep]);
  assert.equal(granted(c3), true, 'the project local settings, with a trailing slash');
  const c4 = ctx();
  settings(c4.project, '.claude/settings.json', [`${dir}-other`, '/tmp/x']);
  assert.equal(granted(c4), false, 'a sibling that only shares the prefix is not a parent');
  assert.equal(granted(ctx(), { recorded: true }), true, 'a grant the model saw is recorded');
  const c5 = ctx();
  settings(c5.cfg, 'settings.json', [], { apiKeyHelper: 'secret' });
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'scripts', 'lib', 'uploads.mjs'), 'utf8');
  assert.doesNotMatch(src, /writeFile\(|appendFile|rename/, 'no code writes Claude Code\'s settings');
  assert.deepEqual(fs.readdirSync(c5.cfg), ['settings.json'], 'read-only: nothing was written beside it');
});

test('J resume set says the one plain /add-dir line after saving a file, unless a grant covers the folder or one was recorded', () => {
  reset();
  const cfg = tmp('cc-cfg-');
  const proj = tmp('cc-proj-');
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.CLAUDE_PROJECT_DIR = proj;
  try {
    const r = J('resume', 'set', '--file', pdf());
    assert.equal(r.json.say, `So Chrome can attach your resume to forms, type /add-dir ${path.join(stateDir(), 'uploads')} and pick "Yes, and remember this directory". That remembers the folder for this project only.`);
    assert.equal(J('uploads', 'status').json.granted, false);
    settings(proj, '.claude/settings.local.json', [path.join(stateDir(), 'uploads')]);
    assert.equal(J('resume', 'set', '--file', pdf()).json.say, undefined, 'a settings grant covers it');
    fs.rmSync(path.join(proj, '.claude'), { recursive: true });
    assert.ok(J('resume', 'set', '--file', pdf()).json.say);
    assert.equal(J('uploads', 'set', 'granted').json.granted, true);
    assert.equal(J('resume', 'set', '--file', pdf()).json.say, undefined, 'a recorded grant covers it');
    assert.equal(J('uploads', 'set', 'nope').code, 2);
    assert.equal(J('resume', 'set', '--text', 'Pat Example, engineer').json.say, undefined, 'a text resume has no file to upload');
  } finally { delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CLAUDE_PROJECT_DIR; }
});

test('upload_blocked: attended the stop gives the one-line step at once; unattended it asks nothing and one notification goes, the other jobs go on', () => {
  reset();
  const a = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/1', status: 'apply_ready', company: 'Acme' });
  const b = mkJob({ key: 'https://boards.greenhouse.io/acme/jobs/2', status: 'apply_ready', company: 'Beta' });
  store.updateState((s) => { s.jobs[a.key] = a; s.jobs[b.key] = b; });
  const r = J('stop', a.key, '--kind', 'upload_blocked');
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.say, up.uploadBlockedStep());
  assert.match(r.json.say, /\/add-dir .*uploads.*Yes, and remember this directory.*go on/);
  assert.deepEqual(store.loadState().jobs[a.key].parked.reasons, ['upload_blocked']);
  // unattended: no say, the batch stays for the other jobs, and one notification names the stop
  J('batch', 'open', '--unattended');
  const u = J('stop', b.key, '--kind', 'upload_blocked');
  assert.equal(u.json.say, undefined, 'no question in an unattended turn');
  assert.equal(u.json.batchClosed, false, 'the round goes on');
  J('batch', 'close');
  const w = (async () => (await import(`${S}work.mjs`)).notifyLine(store.loadState(), { rules: [], lessons: [] }, Date.now()).line)();
  return w.then((line) => assert.match(line, /2 stops need you.*upload blocked|stop.*upload blocked/));
});

test('SKILL.md and the docs: the say line, the grant record, the new stop kind, the README line; under 10,000 characters', () => {
  const root = path.join(import.meta.dirname, '..', '..');
  const skill = fs.readFileSync(path.join(root, 'skills', 'job-search', 'SKILL.md'), 'utf8');
  assert.ok(skill.length <= 10000, `${skill.length}`);
  assert.match(skill, /`J uploads set granted`/);
  assert.match(skill, /upload_blocked/);
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /permissions\.additionalDirectories/);
  assert.match(readme, /never writes Claude Code's settings/);
  assert.match(fs.readFileSync(path.join(root, 'skills', 'job-search', 'references', 'setup.md'), 'utf8'), /uploads folder/);
});
