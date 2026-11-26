import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const S = '../../skills/job-search/scripts/lib/';
const qs = await import(`${S}questions.mjs`);
const store = await import(`${S}store.mjs`);

// Every test reads fixture files in a temporary folder, never the real config of the machine that runs the tests.
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-config-'));
const put = (d, rel, v) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), typeof v === 'string' ? v : JSON.stringify(v)); };
const IN = 'inputNeededNotifEnabled';
const AG = 'agentPushNotifEnabled';
const ACTIONS = 'Then open /config and turn on "Push when actions required", so questions reach your phone.';
const DECIDES = 'Then open /config and turn on "Push when Claude decides", so updates reach your phone.';
const BOTH = 'Then open /config and turn on "Push when actions required" and "Push when Claude decides", so questions and updates reach your phone.';

test('the reminder names only the settings that are off or unknown', () => {
  const r = (rc, settings, pushSent = false) => qs.rcReminder({ rc, pushSent, settings });
  assert.equal(r('unknown', { input: null, agent: null }), `${'Type /rc to get these notifications on your phone and answer from the Claude app while this session keeps running here.'} ${BOTH}`);
  assert.equal(r('on', { input: false, agent: false }), BOTH);
  assert.equal(r('on', { input: true, agent: false }), DECIDES);
  assert.equal(r('on', { input: null, agent: true }), ACTIONS, 'unknown counts as not on');
  assert.equal(r('unknown', { input: true, agent: true }), 'Type /rc to get these notifications on your phone and answer from the Claude app while this session keeps running here.', 'both on: no /config sentence');
  assert.equal(r('on', { input: true, agent: true }), null, 'both on and Remote Control on: no reminder');
});

test('a sent push counts as "Push when Claude decides" on, whatever the file says, and proves Remote Control', () => {
  assert.equal(qs.rcReminder({ rc: 'unknown', pushSent: true, settings: { input: false, agent: false } }), ACTIONS);
  assert.equal(qs.rcReminder({ rc: 'unknown', pushSent: true, settings: { input: true, agent: false } }), null);
});

test('J start record and J ask start build the reminder from the config files; not_sent --reason off still says the /config sentence once', () => {
  const d = dir();
  process.env.CLAUDE_CONFIG_DIR = d;
  try {
    store.updateState((s) => { Object.assign(s, store.emptyState()); });
    put(d, '.claude.json', { [IN]: true, [AG]: true });
    runJobs(home, ['rc', 'set', 'on']);
    assert.equal(runJobs(home, ['start', 'record', '--mode', 'attended']).json.reminder, null);
    assert.equal(runJobs(home, ['ask', 'start']).json.reminder, null);
    put(d, '.claude.json', { [IN]: false, [AG]: true });
    assert.equal(runJobs(home, ['ask', 'start']).json.reminder, ACTIONS);
    put(d, '.claude.json', { [IN]: true, [AG]: true });
    const off = runJobs(home, ['notify', 'result', 'not_sent', '--reason', 'off']).json;
    assert.equal(off.say, DECIDES, 'the push says it is off, though the file says on: the file can be out of date');
    assert.equal(runJobs(home, ['notify', 'result', 'not_sent', '--reason', 'off']).json.say, null, 'once');
  } finally { delete process.env.CLAUDE_CONFIG_DIR; }
});
