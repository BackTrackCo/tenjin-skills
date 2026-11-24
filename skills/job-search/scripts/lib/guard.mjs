import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { graph } from './graph.mjs';
import { SKILL_DIR, claudeSettingsPath, guardDir, readJson, rootDir, writeJsonAtomic, ensureDir } from './paths.mjs';

export const MARKER = 'jobs.mjs" guard hook';
export const policyFile = () => path.join(guardDir(), 'job-search.json');
export const activeFile = () => path.join(guardDir(), 'active');
export const probeFile = () => path.join(guardDir(), 'probe.json');
const CHROME = 'mcp__claude-in-chrome__';

// ---- policy -----------------------------------------------------------
export function openBatch({ mode = 'attended', uploadPath, hosts } = {}) {
  const g = graph();
  const allowedHosts = (hosts || g.hosts).flatMap((h) => g.applyHostNames[h] || []);
  const policy = {
    mode,
    hosts: allowedHosts, // only from graph.json, so a page cannot widen it
    uploadPath: uploadPath || null,
    commandPrefix: `node ${path.join(SKILL_DIR, 'scripts', 'jobs.mjs')}`,
    protected: [rootDir(), SKILL_DIR, guardDir(), path.join(os.homedir(), '.claude')],
    nonce: crypto.randomBytes(8).toString('hex'),
    openedAt: new Date().toISOString(),
  };
  ensureDir(guardDir());
  try { fs.unlinkSync(probeFile()); } catch {}
  writeJsonAtomic(policyFile(), policy);
  fs.writeFileSync(activeFile(), String(process.pid), { mode: 0o600 });
  return policy;
}
export function closeBatch() {
  for (const f of [activeFile(), policyFile(), probeFile()]) try { fs.unlinkSync(f); } catch {}
}
// A batch that saw no tool call for two hours is abandoned. One application takes minutes, a round of 20 about
// two hours of work in total, and every hook call and every `apply next` refreshes the marker, so only a batch
// with no activity at all goes stale. The limit keeps a forgotten batch from blocking the daily search, consent
// and setup for ever. The hook itself keeps enforcing until `work` cleans the batch up.
export const STALE_MS = 2 * 60 * 60 * 1000;
export function batchExists() {
  return fs.existsSync(activeFile());
}
export function isStale(now = Date.now()) {
  try {
    return now - fs.statSync(activeFile()).mtimeMs >= STALE_MS;
  } catch {
    return false;
  }
}
export function isActive(now = Date.now()) {
  return batchExists() && !isStale(now);
}
export function touchBatch(now = Date.now()) {
  try {
    const t = new Date(now);
    fs.utimesSync(activeFile(), t, t);
  } catch {}
}
// Called by `work`: a stale batch is closed in code.
export function cleanupStale(now = Date.now()) {
  if (batchExists() && isStale(now)) {
    closeBatch();
    return true;
  }
  return false;
}
export function batchMode() {
  const p = readJson(policyFile(), null);
  return p && p.mode;
}

// ---- decision (pure) --------------------------------------------------
function collect(v, out = { strings: [], urls: [], keys: [] }) {
  if (typeof v === 'string') {
    out.strings.push(v);
    if (/^https?:\/\//i.test(v)) out.urls.push(v);
  } else if (Array.isArray(v)) v.forEach((x) => collect(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.keys.push(k);
      collect(x, out);
    }
  }
  return out;
}
const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
};
const underHost = (host, base) => host === base || host.endsWith(`.${base}`);
const expand = (p) => path.resolve(String(p).replace(/^~(?=\/|$)/, os.homedir()).replace(/\$HOME|\$\{HOME\}/g, os.homedir()));
function touchesProtected(str, policy) {
  const s = String(str).replace(/["']/g, '');
  if (/(^|[\s/=])~?\/?\.tenjin-skills|\.tenjin-skills\//.test(s)) return true;
  return (policy.protected || []).some((p) => s.includes(p)) || /\.claude\/settings(\.local)?\.json/.test(s);
}
// What changes the limits of a submit is never changed from inside a batch, by any caller.
export const BATCH_DENIED = [
  [/\brules\s+(add|remove)\b/, 'rules come only from the person, not from a batch'],
  [/\blessons\s+(add|remove)\b/, 'lessons are not changed from a batch'],
  [/\bconsent\s+record\b/, 'consent is recorded in an attended session only'],
  [/\bwriting\s+approve\b/, 'only the person approves new writing, outside a batch'],
  [/\banswer\s+add\b/, 'earlier answers are added by the person, outside a batch'],
  [/\bprofile\s+set\b/, 'the profile and the unattended settings are not changed from a batch'],
  [/\bsetup\s+(resume|deepseek)\b/, 'setup is not run from a batch'],
  [/\bdryrun\s+confirm\b/, 'the person confirms the dry run outside a batch'],
  [/\bbatch\s+open\b/, 'a batch cannot open another batch'],
  [/\bguard\s+uninstall\b/, 'the guard is not removed from inside a batch'],
  [/\brelease\s+apply\b/, 'updates are not installed from a batch'],
];
const deny = (reason) => ({ decision: 'deny', reason: `job-search guard: ${reason}` });
const allow = { decision: 'allow' };

export function decide(payload, policy) {
  if (!policy || typeof policy !== 'object' || !Array.isArray(policy.hosts) || !policy.commandPrefix) return deny('the batch policy is unreadable, so every call is denied');
  const g = graph();
  const tool = payload.tool_name || '';
  const input = payload.tool_input || {};
  const c = collect(input);
  const unattended = policy.mode === 'unattended';
  const flat = JSON.stringify(input);
  const strip = (s) => String(s).replace(/["']/g, '').trim();

  if (tool.endsWith('javascript_tool') || flat.includes('javascript_tool')) return deny('page scripts are denied during a batch');

  if (tool.startsWith(CHROME)) {
    for (const u of c.urls) {
      const h = hostOf(u);
      if (!h) return deny('unreadable URL');
      if (g.neverHosts.some((b) => underHost(h, b))) return deny(`${h} is never opened in the browser`);
      if (!policy.hosts.includes(h)) return deny(`${h} is not a host this batch may open`);
    }
    if (tool.endsWith('file_upload') || flat.includes('file_upload')) {
      const paths = c.strings.filter((s) => s.startsWith('/') || s.startsWith('~') || /^[A-Za-z]:\\/.test(s));
      if (!policy.uploadPath || !paths.length || paths.some((p) => expand(p) !== expand(policy.uploadPath))) return deny('only the resume the person named may be uploaded');
    }
    return allow;
  }

  if (tool === 'Bash' || tool === 'PowerShell' || tool === 'Monitor') {
    const cmd = strip(input.command || '');
    const prefix = strip(policy.commandPrefix);
    if (/jobs\.mjs\s+guard\s+probe\s+[0-9a-f]+/.test(cmd) && cmd.startsWith(prefix)) return { decision: 'allow', probe: /guard\s+probe\s+([0-9a-f]+)/.exec(cmd)[1] };
    const blocked = BATCH_DENIED.find(([re]) => re.test(cmd));
    if (blocked) return deny(blocked[1]);
    if (cmd.startsWith(prefix)) {
      if (touchesProtected(cmd.slice(prefix.length), policy)) return deny('writes to the skill, state, guard and settings folders are denied');
      if (unattended && /[;&|`\n]|\$\(/.test(cmd.slice(prefix.length))) return deny('no chained shell in an unattended batch');
      return allow;
    }
    if (touchesProtected(cmd, policy)) return deny('writes to the skill, state, guard and settings folders are denied');
    if (unattended) return deny('shell commands outside the skill are denied in an unattended batch');
    return allow;
  }

  if (['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(tool)) {
    const f = input.file_path || input.notebook_path || '';
    if (touchesProtected(expand(f), policy)) return deny('writes to the skill, state, guard and settings folders are denied');
    return allow;
  }

  if ((tool === 'WebFetch' || tool === 'WebSearch') && g.neverHosts.some((b) => flat.toLowerCase().includes(b))) return deny('a platform that bans automated access is never opened or fetched');
  if (unattended) {
    if (tool === 'WebFetch' || tool === 'WebSearch') return deny('web access is denied in an unattended batch');
    if (tool.startsWith('mcp__')) return deny('other MCP tools are denied in an unattended batch');
  }
  return allow;
}

// ---- the hook entry point (stdin text in, JSON out) -------------------
export function hookMain(stdinText) {
  if (!batchExists()) return null;
  touchBatch();
  let payload;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    return hookOutput(deny('unreadable hook input'));
  }
  let policy;
  try {
    policy = readJson(policyFile(), 'bad');
  } catch {
    policy = 'bad';
  }
  // A broken policy denies everything, but never the one command that closes the batch: no dead end.
  if (policy === 'bad' && payload.tool_name === 'Bash' && /jobs\.mjs"?\s+batch\s+close\s*$/.test(String((payload.tool_input || {}).command || ''))) return null;
  const d = decide(payload, policy === 'bad' ? null : policy);
  if (d.probe && policy && d.probe === policy.nonce) {
    writeJsonAtomic(probeFile(), { nonce: d.probe, session_id: payload.session_id || null, at: new Date().toISOString() });
  }
  return d.decision === 'deny' ? hookOutput(d) : null;
}
function hookOutput(d) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } };
}

// ---- settings.json: install and uninstall -----------------------------
export function hookCommand() {
  const jobs = path.join(SKILL_DIR, 'scripts', 'jobs.mjs');
  return `[ -e "${path.join(rootDir(), 'guard', 'active')}" ] || exit 0; exec node "${jobs}" guard hook`;
}
function loadSettings() {
  const file = claudeSettingsPath();
  if (!fs.existsSync(file)) return { file, settings: {}, existed: false };
  try {
    return { file, settings: JSON.parse(fs.readFileSync(file, 'utf8')), existed: true };
  } catch {
    throw new Error('settings.json is not valid JSON; the guard hook was not written');
  }
}
const isOurs = (h) => typeof h.command === 'string' && h.command.includes(MARKER);

export function installGuard() {
  if (process.platform === 'win32') throw new Error('the guard hook has no Windows form in v0; apply attended by hand');
  const { file, settings, existed } = loadSettings();
  if (existed) {
    const bak = `${file}.job-search.bak`;
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  }
  const hooks = (settings.hooks ||= {});
  const pre = (hooks.PreToolUse ||= []);
  let found = false;
  for (const grp of pre) for (const h of grp.hooks || []) if (isOurs(h)) { h.command = hookCommand(); found = true; }
  if (!found) pre.push({ matcher: '*', hooks: [{ type: 'command', command: hookCommand(), timeout: 5 }] });
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { file, updated: found };
}

export function uninstallGuard() {
  const { file, settings, existed } = loadSettings();
  if (!existed || !settings.hooks || !Array.isArray(settings.hooks.PreToolUse)) return { removed: 0 };
  let removed = 0;
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.map((grp) => {
    const keep = (grp.hooks || []).filter((h) => !isOurs(h));
    removed += (grp.hooks || []).length - keep.length;
    return { ...grp, hooks: keep };
  }).filter((grp) => (grp.hooks || []).length > 0);
  if (!settings.hooks.PreToolUse.length) delete settings.hooks.PreToolUse;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  if (removed) fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { removed };
}

export function guardInstalled() {
  try {
    const { settings } = loadSettings();
    return ((settings.hooks && settings.hooks.PreToolUse) || []).some((grp) => (grp.hooks || []).some(isOurs));
  } catch {
    return false;
  }
}

// The self-test proves the hook ran in this session: the batch's nonce came back through a real tool call.
export function selftest() {
  const reasons = [];
  if (!guardInstalled()) reasons.push('hook_not_installed');
  if (!isActive()) reasons.push('no_open_batch');
  const policy = readJson(policyFile(), null);
  const probe = readJson(probeFile(), null);
  if (!policy) reasons.push('no_policy');
  else if (!probe || probe.nonce !== policy.nonce) reasons.push('probe_not_seen');
  return { ok: reasons.length === 0, reasons };
}
