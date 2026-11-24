import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL } from './helpers/env.mjs';

const md = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');

test('SKILL.md stays under 2,500 tokens (characters divided by 4)', () => {
  assert.ok(md.length / 4 < 2500, `${md.length / 4} tokens`);
});

test('SKILL.md has the Claude Code frontmatter and the gates come first', () => {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(md)[1];
  assert.match(fm, /^name: job-search$/m);
  assert.match(fm, /^description: .+/m);
  assert.ok(md.indexOf('<!-- gates:start -->') < md.indexOf('## Start and recover'));
  assert.ok(md.indexOf('<!-- gates:end -->') > md.indexOf('<!-- gates:start -->'));
});

test('SKILL.md names no private repo, no home path and no em dash', () => {
  for (const f of ['SKILL.md', ...fs.readdirSync(path.join(SKILL, 'references')).map((r) => `references/${r}`)]) {
    const t = fs.readFileSync(path.join(SKILL, f), 'utf8');
    assert.doesNotMatch(t, /tenjin-notes|tenjin-workspace|\/Users\/|\u2014/, f);
  }
});

test('the pinned models in the skill match the plan: browser, review and contacts haiku, writing opus', () => {
  assert.match(md, /browser `haiku`, review `haiku`, contacts `haiku`, writing `opus`/);
});
