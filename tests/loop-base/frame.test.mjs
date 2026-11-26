import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BASE_LIB, ROOT } from './helpers/demo.mjs';

const BASE = path.join(ROOT, 'skills', 'loop-base');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const code = (f) => fs.readFileSync(f, 'utf8');

test('no base file imports a path outside skills/loop-base, and no base file imports app code', () => {
  for (const f of walk(BASE_LIB).filter((x) => x.endsWith('.mjs'))) {
    for (const m of code(f).matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] || m[2];
      if (spec.startsWith('node:')) continue;
      assert.ok(spec.startsWith('.'), `${path.basename(f)} imports ${spec}: only node: modules and base files`);
      const target = path.resolve(path.dirname(f), spec);
      assert.ok(target.startsWith(`${BASE}${path.sep}`), `${path.basename(f)} imports ${spec} outside skills/loop-base`);
      assert.ok(fs.existsSync(target), `${path.basename(f)} imports ${spec}, which does not exist`);
    }
  }
});

test('no base code names an app, a seller or the app command', () => {
  for (const f of walk(BASE).filter((x) => /\.(mjs|md)$/.test(x) && !x.endsWith('README.md'))) {
    assert.doesNotMatch(code(f), /job[- ]search|jobs\.mjs|\bgtm\b|outreach|\bJOB_SEARCH/i, path.relative(ROOT, f));
  }
});

test('the base SKILL.md carries no rules: a short description that says it is shared code, and nothing for the model to do', () => {
  const skill = code(path.join(BASE, 'SKILL.md'));
  const fm = /^---\nname: loop-base\ndescription: (.+)\n---\n/.exec(skill);
  assert.ok(fm, 'frontmatter');
  assert.match(fm[1], /Shared code for Tenjin loop skills/);
  assert.match(fm[1], /Not used on its own/);
  assert.doesNotMatch(skill, /allowed-tools/);
  assert.ok(skill.length < 700);
  assert.ok(fs.existsSync(path.join(BASE, 'README.md')));
  assert.match(code(path.join(BASE, 'README.md')), /defineApp/);
});

test('the base tooling exists: the workflow loops over every manifest with a gates hash, and the dash check covers the base', () => {
  const wf = code(path.join(ROOT, '.github', 'workflows', 'pr.yml'));
  assert.match(wf, /for m in skills\/\*\/manifest\.json/);
  assert.match(wf, /gatesHash/);
  assert.match(wf, /if \[ ! -e "\$m" \]; then continue; fi/, 'a folder with no manifest is skipped');
  assert.match(code(path.join(ROOT, 'scripts', 'check-dashes.sh')), /skills\/loop-base/);
  assert.match(code(path.join(ROOT, 'scripts', 'check-skills.sh')), /ls skills\/\*\/SKILL\.md/);
  const pkg = JSON.parse(code(path.join(ROOT, 'package.json')));
  assert.equal(pkg.scripts['check:dashes'], 'sh scripts/check-dashes.sh');
});
