import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { guardedFetch } from './net.mjs';
import { SKILL_DIR } from './paths.mjs';
import { updateState } from './store.mjs';

export const REPO = 'BackTrackCo/tenjin-skills';
export const SKILLS_CLI = 'skills@1.9.0';
const DAY = 86400000;
export const GATE_FILES = ['graph.json', 'scripts/lib/email.mjs', 'scripts/lib/consent.mjs', 'scripts/lib/batch.mjs', 'scripts/lib/net.mjs', 'scripts/lib/open.mjs', 'scripts/lib/dedupe.mjs'];

const parseVer = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
export function cmpVer(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

// The gate section of SKILL.md sits between two markers.
export function gateSection(skillMd) {
  const m = /<!-- gates:start -->([\s\S]*?)<!-- gates:end -->/.exec(skillMd);
  return m ? m[1] : '';
}
export function gatesHash(skillDir = SKILL_DIR) {
  const h = crypto.createHash('sha256');
  h.update(gateSection(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')));
  for (const f of GATE_FILES) h.update(`\n${f}\n`).update(fs.readFileSync(path.join(skillDir, f)));
  return h.digest('hex');
}

// The newest gtm-loop-v* tag that is a day old, newer than the installed one.
export function pickRelease({ releases, installed, now = Date.now() }) {
  const major = parseVer(installed)[0];
  let best = null;
  for (const r of releases) {
    const m = /^gtm-loop-v(\d+\.\d+\.\d+)$/.exec(r.tag_name || '');
    if (!m || r.draft || r.prerelease) continue;
    if (now - Date.parse(r.published_at) < DAY) continue;
    if (cmpVer(m[1], installed) <= 0) continue;
    if (!best || cmpVer(m[1], best.version) > 0) best = { version: m[1], tag: r.tag_name, majorChange: parseVer(m[1])[0] !== major };
  }
  return best;
}

async function ghJson(url, fetchImpl, accept) {
  const res = await guardedFetch(url, accept ? { headers: { accept } } : {}, fetchImpl);
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res;
}

export function installCommands(tag, writingTag) {
  const base = ['-y', SKILLS_CLI, 'add'];
  const tail = ['-g', '-a', 'claude-code', '-y'];
  return [
    ['npx', [...base, `${REPO}#${tag}`, '--skill', 'gtm-loop', ...tail]],
    ...(writingTag ? [['npx', [...base, `${REPO}#${writingTag}`, '--skill', 'writing', ...tail]]] : []),
  ];
}

// Never silent: every outcome returns a report line. Gate changes and major versions wait for a yes.
export async function checkRelease({ fetchImpl, runner, now = Date.now(), skillDir = SKILL_DIR, autoInstall = true }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(skillDir, 'manifest.json'), 'utf8'));
  const installed = manifest.version;
  let releases;
  try {
    releases = await (await ghJson(`https://api.github.com/repos/${REPO}/releases?per_page=30`, fetchImpl)).json();
  } catch (e) {
    return { status: 'check_failed', line: `Update check failed: ${e.message}` };
  }
  const pick = pickRelease({ releases, installed, now });
  if (!pick) return { status: 'current', line: null };
  let next;
  try {
    next = await (await ghJson(`https://api.github.com/repos/${REPO}/contents/skills/gtm-loop/manifest.json?ref=${pick.tag}`, fetchImpl, 'application/vnd.github.raw')).json();
  } catch (e) {
    return { status: 'check_failed', line: `Update check failed: ${e.message}` };
  }
  const change = (next.change || '').slice(0, 160);
  if (pick.majorChange || next.gatesHash !== gatesHash(skillDir)) {
    return { status: 'update_waiting', tag: pick.tag, writingTag: next.writing, change, line: `GTM Loop ${pick.version} changes the gates or is a new major version: ${change}. Waiting for your yes.` };
  }
  if (!autoInstall) return { status: 'update_available', tag: pick.tag, writingTag: next.writing, change, line: null };
  return applyUpdate({ tag: pick.tag, writingTag: next.writing, change, runner, skillDir, previousTag: `gtm-loop-v${installed}`, previousWriting: manifest.writing, version: pick.version });
}

export async function applyUpdate({ tag, writingTag, change = '', runner, skillDir = SKILL_DIR, previousTag, previousWriting, version }) {
  for (const [cmd, args] of installCommands(tag, writingTag)) {
    const r = await runner(cmd, args);
    if (r.code !== 0) return rollback({ runner, previousTag, previousWriting, why: `install exited ${r.code}` });
  }
  let ok = false;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(skillDir, 'manifest.json'), 'utf8'));
    ok = m.gatesHash === gatesHash(skillDir) && m.version === (version || m.version);
  } catch {}
  if (!ok) return rollback({ runner, previousTag, previousWriting, why: 'installed files do not match the manifest hash' });
  return { status: 'updated', tag, line: `Updated GTM Loop to ${tag.replace('gtm-loop-', '')}: ${change}` };
}

async function rollback({ runner, previousTag, previousWriting, why }) {
  if (previousTag) for (const [cmd, args] of installCommands(previousTag, previousWriting)) await runner(cmd, args);
  return { status: 'update_failed', line: `GTM Loop update failed (${why}); the previous version is back.` };
}

// Records the outcome in state (held reasons) so the work-list and notify line carry it.
export function recordRelease(result, now = Date.now()) {
  return updateState((state) => {
    state.update.lastCheckAt = new Date(now).toISOString();
    state.update.status = result.status;
    state.update.waiting = result.status === 'update_waiting' ? { tag: result.tag, writingTag: result.writingTag, change: result.change } : null;
    state.held = state.held.filter((h) => h.reason !== 'update_waiting' && h.reason !== 'update_failed');
    if (result.status === 'update_waiting') state.held.push({ reason: 'update_waiting', detail: result.tag });
    if (result.status === 'update_failed') state.held.push({ reason: 'update_failed', detail: result.line });
    if (result.line && !(state.updateLines || []).includes(result.line)) (state.updateLines ||= []).push(result.line);
  });
}
