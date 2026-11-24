import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmpHome } from './helpers/env.mjs';

tmpHome();
const t = await import('../../skills/job-search/scripts/lib/tenjin.mjs');

const fakeRun = (script) => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args.join(' '));
    const hit = script.find(([k]) => args.join(' ') === k);
    return hit ? hit[1](calls) : { code: 1, stdout: '' };
  };
  run.calls = calls;
  return run;
};
const json = (data) => ({ code: 0, stdout: JSON.stringify({ schemaVersion: 1, ok: true, data }) });

test('versions compare, alpha builds included', () => {
  assert.ok(t.compareVersions('0.1.0-alpha.36', '0.1.0-alpha.35') > 0);
  assert.ok(t.compareVersions('0.1.0-alpha.9', '0.1.0-alpha.35') < 0);
  assert.ok(t.compareVersions('0.1.0', '0.1.0-alpha.99') > 0);
  assert.equal(t.compareVersions('0.1.0-alpha.35', '0.1.0-alpha.35'), 0);
});

test('the Tenjin check answers missing, outdated or present', () => {
  assert.equal(t.checkTenjin({ bin: null }).status, 'missing');
  assert.equal(t.checkTenjin({ bin: '/x/tenjin', run: fakeRun([['--version', () => ({ code: 0, stdout: 'tenjin 0.1.0-alpha.30\n' })]]) }).status, 'outdated');
  assert.equal(t.checkTenjin({ bin: '/x/tenjin', run: fakeRun([['--version', () => ({ code: 0, stdout: '0.1.0-alpha.35' })]]) }).status, 'present');
  assert.equal(t.checkTenjin({ bin: '/x/tenjin', run: fakeRun([['--version', () => ({ code: 0, stdout: '0.2.0' })]]) }).status, 'present');
  assert.equal(t.checkTenjin({ bin: '/x/tenjin', run: fakeRun([]) }).status, 'missing');
});

test('findTenjin looks on PATH, then in ~/.local/bin', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tj-'));
  assert.equal(t.findTenjin({ env: { PATH: '' }, home }), null);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'tenjin'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(t.findTenjin({ env: { PATH: '' }, home }), path.join(home, '.local', 'bin', 'tenjin'));
});

test('DeepSeek step: reads `tenjin config subagents --json`, read-only when off', () => {
  const run = fakeRun([['config subagents --json', () => json({ enabled: false })]]);
  assert.deepEqual(t.deepseekStep({ run, bin: '/x/tenjin', yes: true }), { state: 'off', enabled: false });
  assert.deepEqual(run.calls, ['config subagents --json']);
});

test('DeepSeek step: on, no yes: it explains and changes nothing', () => {
  const run = fakeRun([['config subagents --json', () => json({ enabled: true, consent: true })]]);
  const r = t.deepseekStep({ run, bin: '/x/tenjin' });
  assert.equal(r.state, 'on_ask');
  assert.match(r.why, /no Claude in Chrome tools/);
  assert.ok(!run.calls.includes('config subagents off'));
});

test('DeepSeek step: `off` runs only after a yes, then reads back', () => {
  let off = false;
  const run = fakeRun([
    ['config subagents --json', () => json({ enabled: !off })],
    ['config subagents off', () => { off = true; return { code: 0, stdout: '' }; }],
  ]);
  const r = t.deepseekStep({ run, bin: '/x/tenjin', yes: true });
  assert.equal(r.state, 'turned_off');
  assert.deepEqual(run.calls, ['config subagents --json', 'config subagents off', 'config subagents --json']);
});

test('DeepSeek step: kept on is recorded, nothing runs; an unreadable answer is not guessed', () => {
  const run = fakeRun([['config subagents --json', () => json({ enabled: true })]]);
  assert.equal(t.deepseekStep({ run, bin: '/x/tenjin', keep: true }).state, 'on_kept');
  assert.ok(!run.calls.includes('config subagents off'));
  assert.equal(t.deepseekStep({ run: fakeRun([]), bin: '/x/tenjin', yes: true }).state, 'unreadable');
  assert.equal(t.deepseekStep({ run, bin: null }).state, 'no_tenjin');
});

test('the skill runs no other Tenjin command that changes a setting', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'job-search', 'scripts', 'lib', 'tenjin.mjs'), 'utf8');
  const calls = [...src.matchAll(/run\(bin, \[([^\]]*)\]/g)].map((m) => m[1].replace(/['\s]/g, ''));
  assert.deepEqual(calls.sort(), ['--version', 'config,subagents,--json', 'config,subagents,off'].sort());
});
