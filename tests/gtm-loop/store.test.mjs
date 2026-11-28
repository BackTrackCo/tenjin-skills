import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SKILL, mkLead, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const store = await import('../../skills/gtm-loop/scripts/lib/store.mjs');
const paths = await import('../../skills/gtm-loop/scripts/lib/paths.mjs');
const seed = (leads) => store.updateState((s) => { for (const l of leads) s.leads[l.key] = l; });

test('writes are atomic: no temp files linger, the file is valid JSON, mode 0600, state folder is gtm-loop', () => {
  store.updateState((s) => { s.rc = 'x'; });
  const dir = paths.stateDir();
  assert.equal(path.basename(dir), 'gtm-loop');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock')), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).rc, 'x');
  assert.equal(fs.statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600);
});

test('unknown ops are refused and land nothing', () => {
  assert.throws(() => store.applyOps([{ op: 'signal', kind: 'x' }, { op: 'delete_everything' }]), /unknown op/);
  assert.equal(store.loadState().signals.counts.x, undefined);
});

test('every illegal transition is refused, every legal one lands', () => {
  const g = JSON.parse(fs.readFileSync(path.join(SKILL, 'graph.json'), 'utf8'));
  for (const from of g.statuses) {
    for (const to of g.statuses) {
      const l = mkLead({ status: from });
      seed([l]);
      if (g.transitions[from].includes(to)) { store.applyOps([{ op: 'transition', key: l.key, to }]); assert.equal(store.loadState().leads[l.key].status, to); }
      else assert.throws(() => store.applyOps([{ op: 'transition', key: l.key, to }]), /illegal transition/, `${from} -> ${to}`);
    }
  }
});

test('a rank needs three scores in range, and a bad op in a batch lands none of the batch', () => {
  const l = mkLead();
  seed([l]);
  assert.throws(() => store.applyOps([{ op: 'rank', key: l.key, fit: 50, intent: 120, timing: 10 }]), /0\.\.100/);
  assert.throws(() => store.applyOps([{ op: 'rank', key: l.key, fit: 60, intent: 60, timing: 60, line: 'x' }, { op: 'transition', key: l.key, to: 'contacted' }]), /illegal/);
  assert.equal(store.loadState().leads[l.key].scores, undefined);
  store.applyOps([{ op: 'rank', key: l.key, fit: 60, intent: 90, timing: 30, line: 'asks for it', quote: 'pay for APIs' }]);
  assert.equal(store.loadState().leads[l.key].scores.avg, 60);
});

test('two processes with 100 ops each land all 200', async () => {
  const writer = path.join(import.meta.dirname, 'helpers', 'writer.mjs');
  const env = { ...process.env, HOME: home, TENJIN_SKILLS_DIR: process.env.TENJIN_SKILLS_DIR };
  const run = (tag) => new Promise((res, rej) => { const c = spawn(process.execPath, [writer, tag, '100'], { env }); c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`writer ${tag} exited ${code}`)))); });
  await Promise.all([run('a'), run('b')]);
  const counts = store.loadState().signals.counts;
  assert.equal(Object.keys(counts).filter((k) => /^[ab]-\d+$/.test(k)).length, 200);
});

test('a state from a newer schema is refused', () => {
  store.updateState((s) => { s.schemaVersion = 99; });
  assert.throws(() => store.loadState(), /newer than this code/);
  fs.rmSync(store.stateFile());
});
