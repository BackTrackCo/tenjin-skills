import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runJobs, tmpHome } from './helpers/env.mjs';

const home = tmpHome();
const g = await import('../../skills/job-search/scripts/lib/guard.mjs');
const paths = await import('../../skills/job-search/scripts/lib/paths.mjs');
const settingsFile = () => paths.claudeSettingsPath();
const RESUME = path.join(home, 'resume.pdf');
const nav = (url, extra = {}) => ({ tool_name: 'mcp__claude-in-chrome__navigate', tool_input: { url }, ...extra });
const policy = (mode = 'attended') => g.openBatch({ mode, uploadPath: RESUME });
const dec = (p, pol) => g.decide(p, pol).decision;

test('settings: install touches no other entry; uninstall removes only its own', () => {
  const original = { model: 'sonnet', permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } };
  fs.writeFileSync(settingsFile(), JSON.stringify(original));
  g.installGuard();
  const after = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  assert.deepEqual(after.permissions, original.permissions);
  assert.deepEqual(after.hooks.Stop, original.hooks.Stop);
  assert.equal(after.model, 'sonnet');
  assert.deepEqual(after.hooks.PreToolUse[0], original.hooks.PreToolUse[0]);
  assert.equal(after.hooks.PreToolUse.length, 2);
  assert.equal(g.guardInstalled(), true);
  g.installGuard(); // idempotent
  assert.equal(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).hooks.PreToolUse.length, 2);
  assert.equal(g.uninstallGuard().removed, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')), original);
  assert.equal(g.guardInstalled(), false);
});

test('settings: a file that was absent is created, and uninstall leaves no empty hooks object', () => {
  fs.rmSync(settingsFile());
  g.installGuard();
  assert.equal(g.guardInstalled(), true);
  g.uninstallGuard();
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')), {});
});

test('settings: invalid JSON is refused and left alone', () => {
  fs.writeFileSync(settingsFile(), '{ not json');
  assert.throws(() => g.installGuard(), /not valid JSON/);
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), '{ not json');
  fs.writeFileSync(settingsFile(), '{}');
});

test('the hook command starts no Node when no batch is open', () => {
  assert.match(g.hookCommand(), /^\[ -e ".*guard\/active" \] \|\| exit 0; exec node /);
});

test('navigation: policy hosts pass; other hosts, LinkedIn and Indeed are denied', () => {
  const p = policy();
  assert.equal(dec(nav('https://boards.greenhouse.io/acme/jobs/1'), p), 'allow');
  assert.equal(dec(nav('https://jobs.lever.co/acme/1'), p), 'allow');
  assert.equal(dec(nav('https://evil.example.com/'), p), 'deny');
  assert.equal(dec(nav('https://www.linkedin.com/jobs/view/1'), p), 'deny');
  assert.equal(dec(nav('https://de.indeed.com/viewjob'), p), 'deny');
  assert.equal(dec({ tool_name: 'mcp__claude-in-chrome__tabs_create_mcp', tool_input: { url: 'https://evil.example.com' } }, p), 'deny');
});

test('page scripts are denied, also as an item inside a browser_batch', () => {
  const p = policy();
  assert.equal(dec({ tool_name: 'mcp__claude-in-chrome__javascript_tool', tool_input: { text: '1' } }, p), 'deny');
  assert.equal(dec({ tool_name: 'mcp__claude-in-chrome__browser_batch', tool_input: { actions: [{ tool: 'read_page' }, { tool: 'javascript_tool', input: {} }] } }, p), 'deny');
  assert.equal(dec({ tool_name: 'mcp__claude-in-chrome__browser_batch', tool_input: { actions: [{ tool: 'read_page' }] } }, p), 'allow');
});

test('a second upload path is denied; the named resume passes', () => {
  const p = policy();
  assert.equal(dec({ tool_name: 'mcp__claude-in-chrome__file_upload', tool_input: { paths: [RESUME] } }, p), 'allow');
  assert.equal(dec({ tool_name: 'mcp__claude-in-chrome__file_upload', tool_input: { paths: ['/etc/passwd'] } }, p), 'deny');
  assert.equal(dec({ tool_name: 'mcp__claude-in-chrome__file_upload', tool_input: { paths: [RESUME, '/tmp/other.pdf'] } }, p), 'deny');
  assert.equal(dec({ tool_name: 'mcp__claude-in-chrome__file_upload', tool_input: {} }, p), 'deny');
});

test('rules add and writes under the state, skill, guard and settings folders are denied', () => {
  const p = policy();
  const jobs = `${p.commandPrefix}`;
  assert.equal(dec({ tool_name: 'Bash', tool_input: { command: `${jobs} rules add --effect note --words x` } }, p), 'deny');
  assert.equal(dec({ tool_name: 'Bash', tool_input: { command: `${jobs} work` } }, p), 'allow');
  assert.equal(dec({ tool_name: 'Bash', tool_input: { command: `echo hi > ${paths.rootDir()}/job-search/profile.json` } }, p), 'deny');
  assert.equal(dec({ tool_name: 'Bash', tool_input: { command: 'rm -rf ~/.tenjin-skills' } }, p), 'deny');
  assert.equal(dec({ tool_name: 'Bash', tool_input: { command: `${jobs} work && rm -rf ${paths.rootDir()}` } }, p), 'deny');
  assert.equal(dec({ tool_name: 'Write', tool_input: { file_path: path.join(paths.rootDir(), 'writing', 'rules.md') } }, p), 'deny');
  assert.equal(dec({ tool_name: 'Edit', tool_input: { file_path: settingsFile() } }, p), 'deny');
  assert.equal(dec({ tool_name: 'Write', tool_input: { file_path: path.join(home, 'notes.txt') } }, p), 'allow');
  assert.equal(dec({ tool_name: 'Bash', tool_input: { command: `${jobs} consent unattended` } }, p), 'deny');
});

test('unattended: web, other MCP tools and shell outside the prefix are denied', () => {
  const p = policy('unattended');
  assert.equal(dec({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }, p), 'deny');
  assert.equal(dec({ tool_name: 'WebSearch', tool_input: { query: 'x' } }, p), 'deny');
  assert.equal(dec({ tool_name: 'mcp__plugin_tenjin_router__request', tool_input: {} }, p), 'deny');
  assert.equal(dec({ tool_name: 'Bash', tool_input: { command: 'curl https://example.com' } }, p), 'deny');
  assert.equal(dec({ tool_name: 'Bash', tool_input: { command: `${p.commandPrefix} work; curl x` } }, p), 'deny');
  assert.equal(dec({ tool_name: 'Bash', tool_input: { command: `${p.commandPrefix} work` } }, p), 'allow');
  assert.equal(dec(nav('https://jobs.ashbyhq.com/linear/1'), p), 'allow');
  const att = policy('attended');
  assert.equal(dec({ tool_name: 'WebSearch', tool_input: { query: 'x' } }, att), 'allow', 'attended keeps the person in charge of the web');
});

test('a malformed policy denies every call in that batch', () => {
  assert.equal(dec({ tool_name: 'Read', tool_input: {} }, null), 'deny');
  assert.equal(dec({ tool_name: 'Read', tool_input: {} }, { hosts: 'nope' }), 'deny');
});

test('subagent calls are checked against the same policy, never skipped', () => {
  const p = policy();
  assert.equal(dec(nav('https://evil.example.com/', { agent_id: 'agent-1', agent_type: 'general-purpose' }), p), 'deny');
  assert.equal(dec(nav('https://boards.greenhouse.io/a/jobs/1', { agent_id: 'agent-1' }), p), 'allow');
});

test('hookMain: nothing happens with no open batch; deny output when a batch is open', () => {
  g.closeBatch();
  assert.equal(g.hookMain(JSON.stringify(nav('https://evil.example.com'))), null);
  policy();
  const out = g.hookMain(JSON.stringify(nav('https://evil.example.com')));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(g.hookMain(JSON.stringify(nav('https://boards.greenhouse.io/a/jobs/1'))), null);
  assert.equal(g.hookMain('not json').hookSpecificOutput.permissionDecision, 'deny');
  fs.writeFileSync(g.policyFile(), '{ broken');
  assert.equal(g.hookMain(JSON.stringify({ tool_name: 'Read', tool_input: {} })).hookSpecificOutput.permissionDecision, 'deny');
});

test('self-test passes only when the hook is installed and the batch nonce came back through a tool call', () => {
  fs.writeFileSync(settingsFile(), '{}');
  g.closeBatch();
  assert.deepEqual(g.selftest().reasons.sort(), ['hook_not_installed', 'no_open_batch', 'no_policy']);
  g.installGuard();
  const p = policy();
  assert.deepEqual(g.selftest().reasons, ['probe_not_seen']);
  g.hookMain(JSON.stringify({ tool_name: 'Bash', session_id: 's1', tool_input: { command: `${p.commandPrefix} guard probe ${p.nonce}` } }));
  assert.equal(g.selftest().ok, true);
  g.closeBatch();
  assert.equal(g.selftest().ok, false);
});

test('the hook entry runs end to end through the CLI under a temporary HOME', () => {
  g.closeBatch();
  const r = runJobs(home, ['batch', 'open', '--upload', RESUME]);
  assert.equal(r.code, 0);
  const hook = runJobs(home, ['guard', 'hook'], { input: JSON.stringify(nav('https://evil.example.com')) });
  assert.match(hook.stdout, /"permissionDecision":"deny"/);
  assert.equal(runJobs(home, ['batch', 'close']).json.closed, true);
});
