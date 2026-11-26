import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKILL, fakeFetch, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const rel = await import('../../skills/job-search/scripts/lib/release.mjs');
const ov = await import('../../skills/job-search/scripts/lib/overlay.mjs');
const paths = await import('../../skills/job-search/scripts/lib/paths.mjs');
const NOW = Date.parse('2026-11-23T12:00:00Z');
const R = (tag, ageDays, extra = {}) => ({ tag_name: tag, published_at: new Date(NOW - ageDays * 864e5).toISOString(), ...extra });

function copySkill() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcopy-'));
  fs.cpSync(SKILL, dir, { recursive: true });
  return dir;
}
const setManifest = (dir, patch) => {
  const f = path.join(dir, 'manifest.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...patch }));
};

test('the gates hash covers the gate section, graph.json and the gate code, and nothing else', () => {
  const dir = copySkill();
  const h = rel.gatesHash(dir);
  fs.appendFileSync(path.join(dir, 'references', 'setup.md'), '\nmore text\n');
  fs.appendFileSync(path.join(dir, 'CHANGES.md'), '\nmore\n');
  const skill = path.join(dir, 'SKILL.md');
  fs.writeFileSync(skill, fs.readFileSync(skill, 'utf8').replace('## Start and recover', '## Start and recover\n\nExtra non-gate text.'));
  assert.equal(rel.gatesHash(dir), h);
  fs.writeFileSync(skill, fs.readFileSync(skill, 'utf8').replace('Never submit without', 'Submit without'));
  assert.notEqual(rel.gatesHash(dir), h);
  const h2 = rel.gatesHash(dir);
  fs.appendFileSync(path.join(dir, 'scripts', 'lib', 'apply.mjs'), '\n// changed\n');
  assert.notEqual(rel.gatesHash(dir), h2);
});

test('the committed manifest hash matches the gate files', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(SKILL, 'manifest.json'), 'utf8')).gatesHash, rel.gatesHash(SKILL));
});

const gh = (releases, manifest) => fakeFetch({ 'https://api.github.com/repos/BackTrackCo/tenjin-skills/releases': releases, 'https://api.github.com/repos/BackTrackCo/tenjin-skills/contents/': manifest });

test('a release with the same gates installs the app, the loop base and writing at its tags, with the pinned installer', async () => {
  const dir = copySkill();
  const calls = [];
  const runner = async (c, a) => {
    calls.push([c, ...a]);
    if (a.includes('BackTrackCo/tenjin-skills@job-search-v0.1.1')) setManifest(dir, { version: '0.1.1', gatesHash: rel.gatesHash(dir) });
    return { code: 0 };
  };
  const r = await rel.checkRelease({ fetchImpl: gh([R('job-search-v0.1.1', 3)], { version: '0.1.1', gatesHash: rel.gatesHash(dir), change: 'Fix a sweep bug.', writing: 'writing-v0.1.0' }), runner, now: NOW, skillDir: dir });
  assert.equal(r.status, 'updated');
  assert.equal(r.line, 'Updated Job Search to v0.1.1: Fix a sweep bug.');
  assert.deepEqual(calls[0].slice(0, 4), ['npx', '-y', 'skills@1.9.0', 'add']);
  assert.ok(calls[0].includes('-g') && calls[0].includes('claude-code'));
  assert.ok(calls[0].includes('job-search') && calls[0].includes('loop-base'), 'the loop base installs at the app\'s tag');
  assert.ok(calls.some((c) => c.includes('BackTrackCo/tenjin-skills@writing-v0.1.0')));
});

test('an update leaves rules.json, profile.json and the writing rules byte for byte the same', async () => {
  const rulesFile = ov.rulesFile();
  ov.addRule({ effect: 'period_max', value: 3, words: 'at most 3 a day', date: '2026-11-20' });
  fs.mkdirSync(path.dirname(paths.writingRulesPath()), { recursive: true });
  fs.writeFileSync(paths.writingRulesPath(), '- 2026-11-20: never write "excited to apply"\n');
  fs.writeFileSync(path.join(paths.stateDir(), 'profile.json'), '{"facts":{"first_name":"Ada"}}\n');
  const files = [rulesFile, paths.writingRulesPath(), path.join(paths.stateDir(), 'profile.json')];
  const before = files.map((f) => fs.readFileSync(f));
  const dir = copySkill();
  const runner = async (c, a) => { if (a.includes('BackTrackCo/tenjin-skills@job-search-v0.1.1')) setManifest(dir, { version: '0.1.1', gatesHash: rel.gatesHash(dir) }); return { code: 0 }; };
  await rel.checkRelease({ fetchImpl: gh([R('job-search-v0.1.1', 3)], { version: '0.1.1', gatesHash: rel.gatesHash(dir), change: 'x', writing: 'writing-v0.1.1' }), runner, now: NOW, skillDir: dir });
  assert.deepEqual(files.map((f) => fs.readFileSync(f)), before);
});

