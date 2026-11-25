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

test('SKILL.md names no private repo, no home path and no em dash', () => {
  for (const f of ['SKILL.md', ...fs.readdirSync(path.join(SKILL, 'references')).map((r) => `references/${r}`)]) {
    const t = fs.readFileSync(path.join(SKILL, f), 'utf8');
    assert.doesNotMatch(t, /tenjin-notes|tenjin-workspace|\/Users\/|\u2014/, f);
  }
});

test('the pinned models in the skill match the plan: browser, review and contacts haiku, writing opus', () => {
  assert.match(md, /browser `haiku`, review `haiku`, contacts `haiku`, writing `opus`/);
});

test('the start shows that it waits: a three-item setup task list, both task tools allowed, and one plain waiting line', () => {
  const fm = /^allowed-tools: (.*)$/m.exec(md)[1];
  for (const tool of ['TaskCreate', 'TaskUpdate', 'TodoWrite']) assert.ok(fm.split(' ').includes(tool), `${tool} is allowed`);
  assert.match(md, /`TaskCreate` and `TaskUpdate`, or `TodoWrite`/);
  assert.match(md, /"Share your resume \(waiting on you\)" in progress, "Four quick choices", "First search and report"/);
  assert.match(md, /mark each done as it completes/);
  assert.match(md, /Waiting for your resume: drop the file here, paste a link, or paste the text\./);
  assert.match(md, /none: skip it/, 'with neither tool, only the waiting line');
  assert.doesNotMatch(md, /resume path|the path/i);
});
