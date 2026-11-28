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
  assert.match(fm, /^description: >-\n  \S/m, 'a folded block, so a colon in the text cannot break the YAML');
  assert.ok(md.indexOf('<!-- gates:start -->') < md.indexOf('## Start and recover'));
  assert.ok(md.indexOf('<!-- gates:end -->') > md.indexOf('<!-- gates:start -->'));
});

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const PRIVATE = new RegExp([['tenjin', 'notes'].join('-'), ['tenjin', 'workspace'].join('-'), ['BackTrackCo', 'tenjin(?![-\\w])'].join('/'), 'tenjin#\\d', ['tenjin', 'agent#\\d'].join('-')].join('|'));

test('the skill ships no private repo or issue link, no home path and no em dash', () => {
  for (const f of walk(SKILL).filter((x) => /\.(md|json|mjs)$/.test(x))) {
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t, PRIVATE, f);
    assert.doesNotMatch(t, /\/Users\/|\/home\/[a-z]|\u2014/, f);
  }
});

test('the pinned models in the skill match the plan: browser, review and contacts haiku, writing opus', () => {
  assert.match(md, /browser `haiku`, review `haiku`, contacts `haiku`, writing `opus`/);
});

test('the start: the task list only through a task tool, never as text; the first message comes from J start status', () => {
  const fm = /^allowed-tools: (.*)$/m.exec(md)[1];
  for (const tool of ['TaskCreate', 'TaskUpdate', 'TodoWrite']) assert.ok(fm.split(' ').includes(tool), `${tool} is allowed`);
  assert.match(md, /If you have a task list tool, make the setup list with it; never write the steps as text\./);
  assert.match(md, /say the `next` text of `J start status` as given/);
  assert.doesNotMatch(md, /Waiting for your resume|mark each done|three-item/);
  assert.doesNotMatch(md, /resume path|the path/i);
});
