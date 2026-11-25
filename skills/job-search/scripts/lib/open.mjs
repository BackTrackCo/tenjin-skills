import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { isLocalHost, isPrivateAddress } from './net.mjs';
import { hostOf } from './platforms.mjs';

// J open: the operating system's own open command, in the person's Google Chrome, with the job's exact URL.
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

// Every J open goes through the operating system's own open command with Google Chrome named as the app, so the person sees the
// page in the Chrome Claude in Chrome uses, with their sign-ins. Never the Claude in Chrome extension or its tools. Chrome
// opens it in its most recently used window and profile. When Chrome is missing or the command fails, the default browser opens
// it and the reply says so in one plain line.
export function chromeCommand(url, platform = process.platform) {
  if (platform === 'darwin') return { bin: 'open', args: ['-a', 'Google Chrome', url] };
  if (platform === 'win32') return { bin: 'cmd', args: ['/c', 'start', '', 'chrome', url] };
  return { bin: 'google-chrome', args: [url] };
}
export function defaultCommand(url, platform = process.platform) {
  if (platform === 'darwin') return { bin: 'open', args: [url] };
  if (platform === 'win32') return { bin: 'cmd', args: ['/c', 'start', '', url] };
  return { bin: 'xdg-open', args: [url] };
}
export const FALLBACK_LINE = 'Google Chrome did not open it, so the page opened in your default browser.';
// `spawn` is injected in tests so no test opens a real browser. JOB_SEARCH_OPEN_BIN replaces the whole command in tests.
export function openPage(url, { spawn = spawnSync, platform = process.platform, env = process.env } = {}) {
  const bad = checkOpenUrl(url);
  if (bad) return { ok: false, why: bad };
  const run = ({ bin, args }) => spawn(bin, args, { stdio: 'ignore', timeout: 10000 });
  if (env.JOB_SEARCH_OPEN_BIN) {
    const r = run({ bin: env.JOB_SEARCH_OPEN_BIN, args: [url] });
    return r.status === 0 ? { ok: true, browser: 'chrome' } : { ok: false, why: `the open command failed (${r.status ?? 'not found'})` };
  }
  const first = run(chromeCommand(url, platform));
  if (first.status === 0) return { ok: true, browser: 'chrome' };
  const second = run(defaultCommand(url, platform));
  return second.status === 0 ? { ok: true, browser: 'default', line: FALLBACK_LINE } : { ok: false, why: `the open command failed (${second.status ?? 'not found'})` };
}

// The page to open for a job: its employer posting in "Just open the pages"; in every stronger mode only the fallback, a job
// the skill must not or cannot fill (its application on a deny-listed host, or a stop at a login or a bot check).
export function openUrlOf(job, profile = {}) {
  if (profile.applyMode === 'open_only') return job.employerPosting && job.sheet ? job.employerPosting.url : job.otherSystem ? job.otherSystem.url : null;
  if (job.otherSystem && job.otherSystem.url) return job.otherSystem.url;
  if (job.parked && job.employerPosting && job.parked.reasons.some((r) => ['captcha', 'login', 'sign_in'].includes(r))) return job.employerPosting.url;
  return null;
}
