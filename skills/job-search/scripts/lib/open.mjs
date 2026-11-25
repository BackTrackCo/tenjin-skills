import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { isLocalHost, isPrivateAddress } from './net.mjs';
import { hostOf } from './platforms.mjs';

// "Just open the pages": the operating system's own open command, in the person's default browser, with the job's exact URL.
// Opening a URL is what a person clicking a link does: nothing reads, fetches, fills or clicks that page, not code and not
// Claude in Chrome. So a deny-listed host is allowed here, and the person meets any bot check or sign-in themselves.
// https only, and never a local or private address.
export function checkOpenUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'not a link';
  }
  if (u.protocol !== 'https:') return 'https links only';
  const host = hostOf(url);
  if (!host || isLocalHost(host)) return 'local or private address';
  if (net.isIP(host) && isPrivateAddress(host)) return 'local or private address';
  if (u.username || u.password) return 'a link with a login in it';
  return null;
}

export const openCommand = () => process.env.JOB_SEARCH_OPEN_BIN || (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open');
export function openPage(url) {
  const bad = checkOpenUrl(url);
  if (bad) return { ok: false, why: bad };
  const bin = openCommand();
  const args = process.platform === 'win32' && !process.env.JOB_SEARCH_OPEN_BIN ? ['/c', 'start', '', url] : [url];
  const r = spawnSync(bin, args, { stdio: 'ignore', timeout: 10000 });
  return r.status === 0 ? { ok: true } : { ok: false, why: `the open command failed (${r.status ?? 'not found'})` };
}

// The page to open for a job: its employer posting in "Just open the pages"; in every stronger mode only the fallback, a job
// the skill must not or cannot fill (its application on a deny-listed host, or a stop at a login or a bot check).
export function openUrlOf(job, profile = {}) {
  if (profile.applyMode === 'open_only') return job.employerPosting && job.sheet ? job.employerPosting.url : job.otherSystem ? job.otherSystem.url : null;
  if (job.otherSystem && job.otherSystem.url) return job.otherSystem.url;
  if (job.parked && job.employerPosting && job.parked.reasons.some((r) => ['captcha', 'login', 'sign_in'].includes(r))) return job.employerPosting.url;
  return null;
}
