import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getApp } from './app.mjs';
import { updateState } from './store.mjs';

// Releases and gates. The app declares release: { repo, displayName, skillsCli, guardedFetch, companions: [{ skill, manifestKey,
// tagField, previousField }] }. The tag prefix comes from the app's name, the gate files from its manifest.json (`gateFiles`, in
// order), and the loop base installs at the app's own tag beside the app. A change to a gate waits for the person's yes.
const DAY = 86400000;

const spec = () => {
  const r = getApp().release;
  if (!r) throw new Error(`the app ${getApp().name} has not declared its release settings`);
  return { companions: [], ...r };
};
const manifestOf = (skillDir) => JSON.parse(fs.readFileSync(path.join(skillDir, 'manifest.json'), 'utf8'));

const parseVer = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
export function cmpVer(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

// The gate section of an app's SKILL.md sits between two markers.
export function gateSection(skillMd) {
  const m = /<!-- gates:start -->([\s\S]*?)<!-- gates:end -->/.exec(skillMd);
  return m ? m[1] : '';
}

// The hash covers the gate section of SKILL.md and, in the manifest's order, each file in `gateFiles` (paths relative to the skill folder;
// a sibling's path such as ../loop-base/lib/netguard.mjs is allowed). Nothing else.
export function gatesHash(skillDir = getApp().skillDir) {
  const files = manifestOf(skillDir).gateFiles;
  if (!Array.isArray(files) || !files.length) throw new Error('the manifest has no gateFiles');
  const h = crypto.createHash('sha256');
  h.update(gateSection(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')));
  for (const f of files) h.update(`\n${f}\n`).update(fs.readFileSync(path.join(skillDir, f)));
  return h.digest('hex');
}

// The newest <name>-v* tag that is a day old, newer than the installed one.
export function pickRelease({ releases, installed, now = Date.now(), name = getApp().name }) {
  const major = parseVer(installed)[0];
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-v(\\d+\\.\\d+\\.\\d+)$`);
  let best = null;
  for (const r of releases) {
    const m = re.exec(r.tag_name || '');
    if (!m || r.draft || r.prerelease) continue;
    if (now - Date.parse(r.published_at) < DAY) continue;
    if (cmpVer(m[1], installed) <= 0) continue;
    if (!best || cmpVer(m[1], best.version) > 0) best = { version: m[1], tag: r.tag_name, majorChange: parseVer(m[1])[0] !== major };
  }
  return best;
}

async function ghJson(url, fetchImpl, accept) {
  const res = await spec().guardedFetch(url, accept ? { headers: { accept } } : {}, fetchImpl);
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res;
}

// The installs for one tag: the app and the loop base at the app's tag, then each companion at its own tag. `tags` maps a companion's
// tagField to its tag.
export function installCommands(tag, tags = {}) {
  const { repo, skillsCli, companions } = spec();
  const base = ['-y', skillsCli, 'add'];
  const tail = ['-g', '-a', 'claude-code', '-y'];
  return [
    // the loop base installs at the app's own tag, beside the app
    ['npx', [...base, `${repo}@${tag}`, '--skill', getApp().name, '--skill', 'loop-base', ...tail]],
    ...companions.filter((c) => tags[c.tagField]).map((c) => ['npx', [...base, `${repo}@${tags[c.tagField]}`, '--skill', c.skill, ...tail]]),
  ];
}

// Never silent: every outcome returns a report line. Gate changes and major versions wait for a yes.
export async function checkRelease({ fetchImpl, runner, now = Date.now(), skillDir = getApp().skillDir, autoInstall = true }) {
  const { repo, displayName, companions } = spec();
  const manifest = manifestOf(skillDir);
  const installed = manifest.version;
  let releases;
  try {
    releases = await (await ghJson(`https://api.github.com/repos/${repo}/releases?per_page=30`, fetchImpl)).json();
  } catch (e) {
    return { status: 'check_failed', line: `Update check failed: ${e.message}` };
  }
  const pick = pickRelease({ releases, installed, now });
  if (!pick) return { status: 'current', line: null };
  let next;
  try {
    next = await (await ghJson(`https://api.github.com/repos/${repo}/contents/skills/${getApp().name}/manifest.json?ref=${pick.tag}`, fetchImpl, 'application/vnd.github.raw')).json();
  } catch (e) {
    return { status: 'check_failed', line: `Update check failed: ${e.message}` };
  }
  const change = (next.change || '').slice(0, 160);
  const tags = Object.fromEntries(companions.map((c) => [c.tagField, next[c.manifestKey]]));
  if (pick.majorChange || next.gatesHash !== gatesHash(skillDir)) {
    return { status: 'update_waiting', tag: pick.tag, ...tags, change, line: `${displayName} ${pick.version} changes the gates or is a new major version: ${change}. Waiting for your yes.` };
  }
  if (!autoInstall) return { status: 'update_available', tag: pick.tag, ...tags, change, line: null };
  const previous = Object.fromEntries(companions.map((c) => [c.previousField, manifest[c.manifestKey]]));
  return applyUpdate({ tag: pick.tag, ...tags, change, runner, skillDir, previousTag: `${getApp().name}-v${installed}`, ...previous, version: pick.version });
}

export async function applyUpdate({ tag, change = '', runner, skillDir = getApp().skillDir, previousTag, version, ...rest }) {
  const { displayName } = spec();
  for (const [cmd, args] of installCommands(tag, rest)) {
    const r = await runner(cmd, args);
    if (r.code !== 0) return rollback({ runner, previousTag, rest, why: `install exited ${r.code}` });
  }
  let ok = false;
  try {
    const m = manifestOf(skillDir);
    ok = m.gatesHash === gatesHash(skillDir) && m.version === (version || m.version);
  } catch {}
  if (!ok) return rollback({ runner, previousTag, rest, why: 'installed files do not match the manifest hash' });
  return { status: 'updated', tag, line: `Updated ${displayName} to ${tag.replace(`${getApp().name}-`, '')}: ${change}` };
}

async function rollback({ runner, previousTag, rest, why }) {
  const { displayName, companions } = spec();
  const before = Object.fromEntries(companions.map((c) => [c.tagField, rest[c.previousField]]));
  if (previousTag) for (const [cmd, args] of installCommands(previousTag, before)) await runner(cmd, args);
  return { status: 'update_failed', line: `${displayName} update failed (${why}); the previous version is back.` };
}

// Records the outcome in state (held reasons) so the work list and notify line carry it. The app's state carries update, held and
// updateLines.
export function recordRelease(result, now = Date.now()) {
  const { companions } = spec();
  return updateState((state) => {
    state.update.lastCheckAt = new Date(now).toISOString();
    state.update.status = result.status;
    state.update.waiting = result.status === 'update_waiting' ? { tag: result.tag, ...Object.fromEntries(companions.map((c) => [c.tagField, result[c.tagField]])), change: result.change } : null;
    state.held = state.held.filter((h) => h.reason !== 'update_waiting' && h.reason !== 'update_failed');
    if (result.status === 'update_waiting') state.held.push({ reason: 'update_waiting', detail: result.tag });
    if (result.status === 'update_failed') state.held.push({ reason: 'update_failed', detail: result.line });
    if (result.line && !(state.updateLines || []).includes(result.line)) (state.updateLines ||= []).push(result.line);
  });
}
