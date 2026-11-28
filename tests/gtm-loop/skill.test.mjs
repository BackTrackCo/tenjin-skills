import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SKILL, runGtm, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const files = (dir) => walk(dir).filter((f) => /\.(md|json|mjs|yml)$/.test(f));
const EM = String.fromCharCode(0x2014);
const PRIVATE = new RegExp([['tenjin', 'notes'].join('-'), ['BackTrackCo', 'tenjin(?![-\\w])'].join('/'), 'tenjin#\\d', ['tenjin', 'agent#\\d'].join('-')].join('|'));

test('the gates hash in the manifest matches the gate section and the gate code', () => {
  const want = JSON.parse(fs.readFileSync(path.join(SKILL, 'manifest.json'), 'utf8')).gatesHash;
  assert.equal(runGtm(home, ['gates']).json.gatesHash, want);
  assert.match(want, /^[0-9a-f]{64}$/);
});

test('SKILL.md has the frontmatter the installer reads, a gates block and no model-provider or seller name', () => {
  const md = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(md, /^---\nname: gtm-loop\ndescription: >-\n/);
  assert.match(md, /allowed-tools: Bash\(node \$\{CLAUDE_SKILL_DIR\}\/scripts\/gtm\.mjs \*\)/);
  assert.match(md, /<!-- gates:start -->[\s\S]+<!-- gates:end -->/);
  assert.ok(md.length < 12000, 'the skill text stays short');
  assert.match(md, /Pin every subagent with the Agent `model` parameter: review `haiku`, the free web search `haiku`, writing `opus`/);
  assert.match(md, /changes no Tenjin setting and declines no Tenjin offer/);
  assert.doesNotMatch(md, /decline_all/);
});

test('no em dash, no home path, no private link in anything the skill, its tests or the writing skill ship', () => {
  for (const f of [...files(SKILL), ...files(path.join(ROOT, 'skills', 'writing')), ...files(path.join(ROOT, 'tests', 'gtm-loop')), ...files(path.join(ROOT, '.github'))].filter((x) => /gtm-loop|writing/.test(x))) {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!t.includes(EM), `${f} has an em dash`);
    assert.doesNotMatch(t, /\/Users\/|\/home\/[a-z]/, `${f} has an absolute home path`);
    assert.doesNotMatch(t, PRIVATE, `${f} names a private repo or issue`);
  }
});

test('seller and model-provider names live only in the adapter table under scripts/lib/suppliers, never in text people see', () => {
  const NAMES = /\b(glim|anyapi|getanyapi|exa|stableenrich|apollo|icypeas|hunter|scrapecreators|companyenrich|orthogonal|deepseek|neon|gemini)\b/i;
  for (const f of files(SKILL).filter((x) => !x.includes(`${path.sep}suppliers${path.sep}`))) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), NAMES, `${path.relative(ROOT, f)} names a seller`);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), NAMES);
  const suppliers = files(path.join(SKILL, 'scripts', 'lib', 'suppliers')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.match(suppliers, /api\.exa\.ai/);
});

test('every script file loads, and no file in the skill uses a hook, a server, or a browser tool', () => {
  for (const f of walk(path.join(SKILL, 'scripts')).filter((x) => x.endsWith('.mjs'))) {
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /createServer|\.listen\(/, `${f} starts a server`);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8'), /mcp__claude-in-chrome/, 'no Claude in Chrome tool in v0');
});

test('the writing skill is the same file, byte for byte, as the one the other skill ships', () => {
  const sha = (f) => fs.readFileSync(f);
  const w = sha(path.join(ROOT, 'skills', 'writing', 'SKILL.md'));
  assert.match(w.toString('utf8'), /^---\nname: writing\n/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(SKILL, 'manifest.json'), 'utf8')).writing, 'writing-v0.1.0');
});

test('the manifest names the version, the minimum Tenjin and the writing tag', () => {
  const m = JSON.parse(fs.readFileSync(path.join(SKILL, 'manifest.json'), 'utf8'));
  assert.equal(m.name, 'gtm-loop');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.match(m.minTenjin, /^\d+\.\d+\.\d+/);
});
