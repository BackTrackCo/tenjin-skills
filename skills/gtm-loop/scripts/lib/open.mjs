import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { graph } from './graph.mjs';
import { isLocalHost, isPrivateAddress } from './net.mjs';
import { hostOf, tweetIdOf } from './platforms.mjs';

// G open: the operating system's own open command, in the person's Google Chrome, with one page. Opening a URL is what a
// person clicking a link does: nothing reads, fetches, fills or clicks that page, not code and not Claude in Chrome. Only X,
// LinkedIn, Reddit and Hacker News pages open here, https only, and never a local or private address.
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
  const emb = /^(\d{1,3})[.-](\d{1,3})[.-](\d{1,3})[.-](\d{1,3})\./.exec(host);
  if (emb && isLocalHost(emb.slice(1).join('.'))) return 'local or private address';
  if (net.isIP(host) && isPrivateAddress(host)) return 'local or private address';
  if (u.username || u.password) return 'a link with a login in it';
  if (/["\u0000-\u001f\u007f]/.test(String(url))) return 'a link with a quote or a control character in it';
  if (!graph().openHosts.some((h) => host === h || host.endsWith(`.${h}`))) return 'only X, LinkedIn, Reddit and Hacker News pages open';
  return null;
}

// X's Web Intent reply page: the post's id and the text, both encoded. The person presses Post. Whether the page fills the text is
// checked in the first live round; the clipboard has the text as well.
export function xReplyLink(tweetUrlOrId, text) {
  const id = /^\d{5,25}$/.test(String(tweetUrlOrId)) ? String(tweetUrlOrId) : tweetIdOf(tweetUrlOrId);
  if (!id) throw new Error('no post id in that link');
  return `https://x.com/intent/post?in_reply_to=${id}&text=${encodeURIComponent(String(text))}`;
}

export function chromeCommand(url, platform = process.platform, { env = process.env, exists = fs.existsSync } = {}) {
  if (platform === 'darwin') return { bin: 'open', args: ['-a', 'Google Chrome', url] };
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LocalAppData].filter(Boolean);
    const bin = roots.map((r) => path.win32.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')).find((p) => exists(p));
    return bin ? { bin, args: [url] } : null;
  }
  return { bin: 'google-chrome', args: [url] };
}
export function defaultCommand(url, platform = process.platform) {
  if (platform === 'darwin') return { bin: 'open', args: [url] };
  if (platform === 'win32') return { bin: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  return { bin: 'xdg-open', args: [url] };
}
export const FALLBACK_LINE = 'Google Chrome did not open it, so the page opened in your default browser.';

// `spawn` is injected in tests so no test opens a real browser. GTM_LOOP_OPEN_BIN replaces the whole command in tests.
export function openPage(url, { spawn = spawnSync, platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const bad = checkOpenUrl(url);
  if (bad) return { ok: false, why: bad };
  url = new URL(url).href;
  const run = ({ bin, args }) => spawn(bin, args, { stdio: 'ignore', timeout: 10000 });
  if (env.GTM_LOOP_OPEN_BIN) {
    const r = run({ bin: env.GTM_LOOP_OPEN_BIN, args: [url] });
    return r.status === 0 ? { ok: true, browser: 'chrome' } : { ok: false, why: `the open command failed (${r.status ?? 'not found'})` };
  }
  const cc = chromeCommand(url, platform, { env, exists });
  if (cc && run(cc).status === 0) return { ok: true, browser: 'chrome' };
  const second = run(defaultCommand(url, platform));
  return second.status === 0 ? { ok: true, browser: 'default', line: FALLBACK_LINE } : { ok: false, why: `the open command failed (${second.status ?? 'not found'})` };
}

// The text goes to the clipboard on macOS (pbcopy), Windows (clip) and Linux (xclip), read from stdin, never from a command line.
export function copyToClipboard(text, { spawn = spawnSync, platform = process.platform, env = process.env } = {}) {
  if (env.GTM_LOOP_CLIP_BIN) {
    const r = spawn(env.GTM_LOOP_CLIP_BIN, [], { input: String(text), timeout: 5000 });
    return r.status === 0;
  }
  const cmd = platform === 'darwin' ? ['pbcopy', []] : platform === 'win32' ? ['clip', []] : ['xclip', ['-selection', 'clipboard']];
  const r = spawn(cmd[0], cmd[1], { input: String(text), timeout: 5000 });
  return r.status === 0;
}
