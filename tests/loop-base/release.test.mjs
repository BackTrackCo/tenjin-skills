import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BASE_LIB, demoState, fakeFetch, releasableSkill, tmpRoot } from './helpers/demo.mjs';

tmpRoot();
const { defineApp, setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
const rel = await import(path.join(BASE_LIB, 'release.mjs'));
const store = await import(path.join(BASE_LIB, 'store.mjs'));
const NOW = Date.parse('2026-11-23T12:00:00Z');
const R = (tag, ageDays, extra = {}) => ({ tag_name: tag, published_at: new Date(NOW - ageDays * 864e5).toISOString(), ...extra });

function appAt(dir, name = 'alpha', extra = {}) {
  const state = demoState();
  const empty = state.empty;
  state.empty = () => ({ ...empty(), update: { lastCheckAt: null, status: null, installed: null, waiting: null }, held: [], updateLines: [] });
  return setApp(defineApp({
    skillDir: dir, state, hosts: { allowed: ['api.github.com'], never: [] },
    release: { repo: 'Org/skills', displayName: 'Alpha', skillsCli: 'skills@1.9.0', companions: [{ skill: 'writing', manifestKey: 'writing', tagField: 'writingTag', previousField: 'previousWriting' }], ...extra },
  }));
}
const setManifest = (dir, patch) => {
  const f = path.join(dir, 'manifest.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...patch }));
};
const gh = (releases, manifest) => fakeFetch({ 'https://api.github.com/repos/Org/skills/releases': releases, 'https://api.github.com/repos/Org/skills/contents/skills/alpha/manifest.json': manifest });

test('the tag prefix comes from the app name: the picker takes the newest day-old tag of that app, never a draft, a prerelease or another skill', () => {
  appAt(releasableSkill());
  const releases = [R('alpha-v0.1.1', 3), R('alpha-v0.1.2', 2), R('alpha-v0.1.3', 0.5), R('writing-v9.0.0', 5), R('alpha-v0.1.0', 10), R('alpha-v0.2.0', 4, { draft: true }), R('alpha-v0.1.4', 4, { prerelease: true }), R('beta-v0.1.9', 4)];
  assert.equal(rel.pickRelease({ releases, installed: '0.1.0', now: NOW }).tag, 'alpha-v0.1.2');
  assert.equal(rel.pickRelease({ releases, installed: '0.1.2', now: NOW }), null);
  assert.equal(rel.pickRelease({ releases: [R('alpha-v1.0.0', 3)], installed: '0.1.0', now: NOW }).majorChange, true);
});

test('the gate files come from the manifest, in its order, and the hash covers the gate section and those files and nothing else', () => {
  const dir = releasableSkill();
  appAt(dir);
  const h = rel.gatesHash(dir);
  fs.appendFileSync(path.join(dir, 'SKILL.md'), '\nmore non-gate text\n');
  fs.writeFileSync(path.join(dir, 'other.md'), 'x');
  assert.equal(rel.gatesHash(dir), h);
  fs.appendFileSync(path.join(dir, 'scripts', 'gate.mjs'), '// changed\n');
  assert.notEqual(rel.gatesHash(dir), h);
  fs.writeFileSync(path.join(dir, 'scripts', 'gate.mjs'), 'export const gate = 1;\n');
  assert.equal(rel.gatesHash(dir), h);
  setManifest(dir, { gateFiles: ['scripts/gate.mjs', 'graph.json'] });
  assert.notEqual(rel.gatesHash(dir), h, 'the order is part of the hash');
  setManifest(dir, { gateFiles: [] });
  assert.throws(() => rel.gatesHash(dir), /no gateFiles/);
  const sib = path.join(path.dirname(dir), `${path.basename(dir)}-sibling.mjs`);
  fs.writeFileSync(sib, 'export const guard = 1;\n');
  setManifest(dir, { gateFiles: ['graph.json', `../${path.basename(sib)}`] });
  assert.match(rel.gatesHash(dir), /^[0-9a-f]{64}$/, 'a sibling path is a gate file too');
});

test('the install runs the app and the loop base at the app\'s tag, then each companion at its own tag', () => {
  appAt(releasableSkill());
  const cmds = rel.installCommands('alpha-v0.1.1', { writingTag: 'writing-v0.1.0' });
  assert.deepEqual(cmds[0], ['npx', ['-y', 'skills@1.9.0', 'add', 'Org/skills@alpha-v0.1.1', '--skill', 'alpha', '--skill', 'loop-base', '-g', '-a', 'claude-code', '-y']]);
  assert.deepEqual(cmds[1], ['npx', ['-y', 'skills@1.9.0', 'add', 'Org/skills@writing-v0.1.0', '--skill', 'writing', '-g', '-a', 'claude-code', '-y']]);
  assert.equal(rel.installCommands('alpha-v0.1.1').length, 1);
});

test('a release that changes the gates or the major version waits for the person\'s yes and installs nothing', async () => {
  const dir = releasableSkill();
  appAt(dir);
  const calls = [];
  const runner = async (c, a) => { calls.push(a); return { code: 0 }; };
  const a = await rel.checkRelease({ fetchImpl: gh([R('alpha-v0.1.1', 3)], { version: '0.1.1', gatesHash: 'different', change: 'Tighter gates.', writing: 'writing-v0.1.1' }), runner, now: NOW, skillDir: dir });
  assert.equal(a.status, 'update_waiting');
  assert.equal(a.writingTag, 'writing-v0.1.1');
  assert.match(a.line, /^Alpha 0\.1\.1 changes the gates or is a new major version: Tighter gates\.\. Waiting for your yes\.$/);
  const b = await rel.checkRelease({ fetchImpl: gh([R('alpha-v1.0.0', 3)], { version: '1.0.0', gatesHash: rel.gatesHash(dir), change: 'Big.' }), runner, now: NOW, skillDir: dir });
  assert.equal(b.status, 'update_waiting');
  assert.deepEqual(calls, []);
});

test('a release with the same gates installs at its tag with the pinned installer and reports a line', async () => {
  const dir = releasableSkill();
  appAt(dir);
  const calls = [];
  const runner = async (c, a) => {
    calls.push([c, ...a]);
    if (a.includes('Org/skills@alpha-v0.1.1')) setManifest(dir, { version: '0.1.1', gatesHash: rel.gatesHash(dir) });
    return { code: 0 };
  };
  const r = await rel.checkRelease({ fetchImpl: gh([R('alpha-v0.1.1', 3)], { version: '0.1.1', gatesHash: rel.gatesHash(dir), change: 'Fix a bug.', writing: 'writing-v0.1.0' }), runner, now: NOW, skillDir: dir });
  assert.equal(r.status, 'updated');
  assert.equal(r.line, 'Updated Alpha to v0.1.1: Fix a bug.');
  assert.deepEqual(calls[0].slice(0, 4), ['npx', '-y', 'skills@1.9.0', 'add']);
  assert.ok(calls[0].includes('loop-base'));
  assert.ok(calls.some((c) => c.includes('Org/skills@writing-v0.1.0')));
});

test('a failed install, or files that do not match the manifest, roll back to the previous tag', async () => {
  for (const mode of ['exit', 'mismatch']) {
    const dir = releasableSkill();
    appAt(dir);
    const calls = [];
    const runner = async (c, a) => {
      calls.push(a.find((x) => x.startsWith('Org/')));
      if (mode === 'exit' && a.includes('Org/skills@alpha-v0.1.1')) return { code: 1 };
      if (mode === 'mismatch' && a.includes('Org/skills@alpha-v0.1.1')) setManifest(dir, { version: '0.1.1', gatesHash: 'nope' });
      return { code: 0 };
    };
    const r = await rel.checkRelease({ fetchImpl: gh([R('alpha-v0.1.1', 3)], { version: '0.1.1', gatesHash: rel.gatesHash(dir), change: 'x' }), runner, now: NOW, skillDir: dir });
    assert.equal(r.status, 'update_failed', mode);
    assert.match(r.line, /^Alpha update failed \(.*\); the previous version is back\.$/);
    assert.ok(calls.slice(-2).includes('Org/skills@alpha-v0.1.0'), mode);
    assert.ok(calls.includes('Org/skills@writing-v0.1.0'), 'the previous companion is reinstalled too');
  }
});

test('a failed update check reports and installs nothing, and no release means current', async () => {
  const dir = releasableSkill();
  appAt(dir);
  const r = await rel.checkRelease({ fetchImpl: fakeFetch({ 'https://api.github.com/': 500 }), runner: async () => assert.fail('no install'), now: NOW, skillDir: dir });
  assert.equal(r.status, 'check_failed');
  const c = await rel.checkRelease({ fetchImpl: gh([R('alpha-v0.1.0', 9)], {}), runner: async () => assert.fail('no install'), now: NOW, skillDir: dir });
  assert.deepEqual(c, { status: 'current', line: null });
});

test('recordRelease holds the waiting and failed updates in state, and a later good result clears them', () => {
  appAt(releasableSkill());
  rel.recordRelease({ status: 'update_waiting', tag: 'alpha-v0.2.0', writingTag: 'writing-v0.2.0', change: 'c', line: 'l' }, NOW);
  const s = store.loadState();
  assert.ok(s.held.some((h) => h.reason === 'update_waiting'));
  assert.deepEqual(s.update.waiting, { tag: 'alpha-v0.2.0', writingTag: 'writing-v0.2.0', change: 'c' });
  rel.recordRelease({ status: 'updated', line: 'done' }, NOW);
  assert.equal(store.loadState().held.some((h) => h.reason === 'update_waiting'), false);
  assert.deepEqual(store.loadState().updateLines, ['l', 'done']);
});

test('an app that declared no release settings fails with a clear error', async () => {
  setApp(defineApp({ skillDir: releasableSkill(), state: demoState() }));
  assert.throws(() => rel.installCommands('x'), /has not declared its release settings/);
});
