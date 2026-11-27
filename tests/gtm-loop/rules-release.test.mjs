import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKILL, fakeFetch, tmpHome } from './helpers/env.mjs';

tmpHome();
const ov = await import('../../skills/gtm-loop/scripts/lib/overlay.mjs');
const rel = await import('../../skills/gtm-loop/scripts/lib/release.mjs');
const prof = await import('../../skills/gtm-loop/scripts/lib/profile.mjs');
const NOW = Date.parse('2026-11-26T12:00:00Z');
const R = (tag, ageDays, extra = {}) => ({ tag_name: tag, published_at: new Date(NOW - ageDays * 864e5).toISOString(), ...extra });

test('a rule keeps the person\'s words and an effect from the vocabulary; nothing else is accepted', () => {
  assert.throws(() => ov.addRule({ effect: 'lesson', value: 1, words: 'x' }), /vocabulary/);
  assert.throws(() => ov.addRule({ effect: 'min_score', value: 50 }), /words/);
  assert.throws(() => ov.addRule({ effect: 'min_score', value: 500, words: 'x' }), /1 to 100/);
  assert.throws(() => ov.addRule({ effect: 'emails_per_day', value: 'many', words: 'x' }), /whole number/);
  const r = ov.addRule({ effect: 'min_score', value: 60, words: 'only strong leads' });
  assert.equal(ov.ruleValue(ov.loadOverlay(), 'min_score'), 60);
  assert.equal(ov.removeRule(r.id), 1);
  assert.equal(ov.ruleValue(ov.loadOverlay(), 'min_score'), undefined);
});

test('there is no default cap: a cap exists only as the person\'s rule', () => {
  assert.equal(ov.capOf(ov.loadOverlay(), 'emails_per_day'), null);
  ov.addRule({ effect: 'emails_per_day', value: 5, words: 'five emails a day' });
  assert.equal(ov.capOf(ov.loadOverlay(), 'emails_per_day'), 5);
  assert.equal(ov.followUpDays(ov.loadOverlay()), null);
  ov.addRule({ effect: 'follow_up', value: '', words: 'follow up once after 4 days' });
  assert.equal(ov.followUpDays(ov.loadOverlay()), 4);
});

test('the rules hash changes with the sender and the rules that decide who is written to, not with caps', () => {
  const p = { sender: { name: 'A', company: 'B', postal: 'Street 1' }, offer: { name: 'Thing' } };
  const o = { rules: [{ effect: 'exclude_domain', value: 'a.com' }] };
  const h = ov.rulesHash(p, o);
  assert.equal(ov.rulesHash(p, { rules: [...o.rules, { effect: 'emails_per_day', value: 3 }, { effect: 'note', value: 'x' }] }), h);
  assert.notEqual(ov.rulesHash(p, { rules: [...o.rules, { effect: 'exclude_term', value: 'x' }] }), h);
  assert.notEqual(ov.rulesHash({ ...p, sender: { ...p.sender, postal: 'Other 2' } }, o), h);
});

test('the profile is checked when set: a bad shape is refused, null removes a field, an object merges', () => {
  assert.throws(() => prof.setProfile({ offer: { name: 'x' } }), /offer needs/);
  assert.throws(() => prof.setProfile({ sources: ['myspace'] }), /sources must/);
  prof.setProfile({ offer: { name: 'Thing', what: 'does a thing', link: 'https://example.org/thing' }, sender: { name: 'Sam' } });
  const p = prof.setProfile({ sender: { company: 'Co' } });
  assert.deepEqual(p.sender, { name: 'Sam', company: 'Co' });
  assert.equal(prof.setProfile({ sender: null }).sender, undefined);
});

test('the release picker takes the newest gtm-loop tag that is a day old, never a draft or another skill', () => {
  const releases = [R('gtm-loop-v0.1.1', 3), R('gtm-loop-v0.1.2', 2), R('gtm-loop-v0.1.3', 0.5), R('job-search-v9.0.0', 5), R('gtm-loop-v0.2.0', 4, { draft: true }), R('gtm-loop-v0.1.4', 4, { prerelease: true })];
  assert.equal(rel.pickRelease({ releases, installed: '0.1.0', now: NOW }).tag, 'gtm-loop-v0.1.2');
  assert.equal(rel.pickRelease({ releases, installed: '0.1.2', now: NOW }), null);
  assert.equal(rel.pickRelease({ releases: [R('gtm-loop-v1.0.0', 3)], installed: '0.1.0', now: NOW }).majorChange, true);
});

test('install commands use #tag, never @tag, for the skill and for writing', () => {
  const cmds = rel.installCommands('gtm-loop-v0.1.2', 'writing-v0.1.0');
  assert.equal(cmds.length, 2);
  assert.ok(cmds[0][1].includes('BackTrackCo/tenjin-skills#gtm-loop-v0.1.2'));
  assert.ok(cmds[1][1].includes('BackTrackCo/tenjin-skills#writing-v0.1.0'));
  assert.ok(cmds.every(([, a]) => !a.some((x) => /tenjin-skills@/.test(x))));
  assert.deepEqual(cmds[0][1].filter((x) => x === '--skill' || x === 'gtm-loop'), ['--skill', 'gtm-loop']);
});

function copySkill() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcopy-'));
  fs.cpSync(SKILL, dir, { recursive: true });
  return dir;
}

test('the gates hash covers the gate section, graph.json and the gate code, and nothing else', () => {
  const dir = copySkill();
  const h = rel.gatesHash(dir);
  fs.appendFileSync(path.join(dir, 'CHANGES.md'), '\nmore\n');
  const skill = path.join(dir, 'SKILL.md');
  fs.writeFileSync(skill, fs.readFileSync(skill, 'utf8').replace('## Start and recover', '## Start and recover\n\nExtra non-gate text.'));
  assert.equal(rel.gatesHash(dir), h);
  fs.writeFileSync(skill, fs.readFileSync(skill, 'utf8').replace('No email without', 'Email without'));
  assert.notEqual(rel.gatesHash(dir), h);
  const h2 = rel.gatesHash(dir);
  fs.appendFileSync(path.join(dir, 'scripts', 'lib', 'net.mjs'), '\n// changed\n');
  assert.notEqual(rel.gatesHash(dir), h2);
});

test('the release check returns update_waiting when the gates change, and never installs by itself then', async () => {
  const dir = copySkill();
  const fetchImpl = fakeFetch({
    'https://api.github.com/repos/BackTrackCo/tenjin-skills/releases': [R('gtm-loop-v0.1.5', 3)],
    'https://api.github.com/repos/BackTrackCo/tenjin-skills/contents/skills/gtm-loop/manifest.json': { version: '0.1.5', gatesHash: 'different', change: 'Changed a gate.', writing: 'writing-v0.1.0' },
  });
  const r = await rel.checkRelease({ fetchImpl, runner: async () => { throw new Error('no install'); }, now: NOW, skillDir: dir });
  assert.equal(r.status, 'update_waiting');
  assert.match(r.line, /GTM Loop 0\.1\.5 changes the gates/);
});
