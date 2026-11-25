import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FIX, mkJob, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const store = await import('../../skills/job-search/scripts/lib/store.mjs');
const paths = await import('../../skills/job-search/scripts/lib/paths.mjs');

const seed = (jobs) => store.updateState((s) => { for (const j of jobs) s.jobs[j.key] = j; });

test('writes are atomic: no temp files linger, file is valid JSON, mode 0600', () => {
  store.updateState((s) => { s.chrome = 'x'; });
  const dir = paths.stateDir();
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock')), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).chrome, 'x');
  assert.equal(fs.statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600);
});

test('unknown ops are refused and land nothing', () => {
  assert.throws(() => store.applyOps([{ op: 'signal', kind: 'x' }, { op: 'delete_everything' }]), /unknown op/);
  assert.equal(store.loadState().signals.counts.x, undefined);
  assert.throws(() => store.applyOps([{ op: 'answer', label: 'a', value: '1' }]), /unknown op/, 'answers live in answers.json, not in ops');
});

test('every illegal transition is refused, every legal one lands', () => {
  const g = JSON.parse(fs.readFileSync(path.join(FIX, '..', '..', '..', 'skills', 'job-search', 'graph.json'), 'utf8'));
  for (const from of g.statuses) {
    for (const to of g.statuses) {
      const j = mkJob({ status: from });
      seed([j]);
      const legal = g.transitions[from].includes(to);
      if (legal) { store.applyOps([{ op: 'transition', key: j.key, to }]); assert.equal(store.loadState().jobs[j.key].status, to); }
      else assert.throws(() => store.applyOps([{ op: 'transition', key: j.key, to }]), /illegal transition/, `${from} -> ${to}`);
    }
  }
});

test('a contact needs a source link; an approval must name the current sheet hash', () => {
  const j = mkJob({ sheet: { hash: 'abc' } });
  seed([j]);
  assert.throws(() => store.applyOps([{ op: 'contact', key: j.key, name: 'A', title: 'VP' }]), /source link/);
  assert.throws(() => store.applyOps([{ op: 'approve', key: j.key, sheetHash: 'zzz' }]), /current sheet hash/);
  store.applyOps([{ op: 'approve', key: j.key, sheetHash: 'abc' }]);
  assert.equal(store.loadState().approvals[j.key].sheetHash, 'abc');
});

test('view is bounded', () => {
  seed(Array.from({ length: 50 }, () => mkJob()));
  const v = store.view(store.loadState(), { limit: 10 });
  assert.equal(v.jobs.length, 10);
  assert.ok(v.truncated >= 40);
});

test('a newer schema is refused by older code', () => {
  const f = store.stateFile();
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...s, schemaVersion: 99 }));
  assert.throws(() => store.loadState(), /newer than this code/);
  fs.writeFileSync(f, JSON.stringify(s));
});

test('two processes writing 100 ops each land all 200', async () => {
  store.updateState((s) => { s.signals.counts = {}; });
  const writer = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'writer.mjs');
  const run = (tag) => new Promise((res, rej) => {
    const p = spawn(process.execPath, [writer, tag, '100'], { env: { ...process.env, HOME: home, TENJIN_SKILLS_DIR: process.env.TENJIN_SKILLS_DIR }, stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`writer exit ${c}`))));
  });
  await Promise.all([run('a'), run('b')]);
  assert.equal(Object.keys(store.loadState().signals.counts).length, 200);
});

test('a stale lock whose pid is gone is reclaimed', () => {
  fs.writeFileSync(path.join(paths.stateDir(), 'state.lock'), '999999');
  store.updateState((s) => { s.chrome = 'again'; });
  assert.equal(store.loadState().chrome, 'again');
});
