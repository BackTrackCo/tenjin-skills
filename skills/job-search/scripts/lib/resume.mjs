import fs from 'node:fs';
import path from 'node:path';
import { guardedFetch, isLocalHost } from './net.mjs';
import { ensureDir, stateDir } from './paths.mjs';
import { isNeverAutomated } from './platforms.mjs';
import { readLinkedIn } from './routed.mjs';
import { askFirst, tenjinAsk, tenjinHint } from './work.mjs';

// The resume, in any form (a file, a link or the text). Read once; a link is not read again unless the person gives a new
// one. The skill never searches the person's files.
export const MAX_REDIRECTS = 3;
export const FILE_TYPES = ['.pdf', '.doc', '.docx', '.md', '.markdown', '.txt', '.rtf'];
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
// The body, read in pieces and refused once it passes the limit, so a huge answer is never held whole.
export async function readCapped(res, max) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) { try { await reader.cancel(); } catch {} return null; }
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts);
  }
  const buf = typeof res.arrayBuffer === 'function' ? Buffer.from(await res.arrayBuffer()) : Buffer.from(await res.text());
  return buf.length > max ? null : buf;
}

export const isLinkedIn = (url) => {
  try {
    const u = new URL(url);
    return /(^|\.)linkedin\.com$/i.test(u.hostname.replace(/\.+$/, '')) && /^\/in\//i.test(u.pathname);
  } catch {
    return false;
  }
};

import { saveToUploads } from './uploads.mjs';
const save = (name, data) => {
  const file = path.join(ensureDir(stateDir()), name);
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
};

export function setText(text, { source = 'text' } = {}) {
  const t = String(text || '').trim();
  if (!t) throw new Error('the resume text is empty');
  const file = save('resume.txt', t);
  return { source, resumeText: t, resumeTextFile: file };
}

// A file: it must exist and be a type a resume comes in. Text and Markdown are read here; for a PDF or a Word file the model
// reads the file itself and saves its text with `J resume set --text`. The profile keeps the path; the file stays put.
export function setFile(p) {
  if (!p || /\[PATH TO/i.test(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return { ask: true, why: 'that file does not exist' };
  const ext = path.extname(p).toLowerCase();
  if (!FILE_TYPES.includes(ext)) return { ask: true, why: `a resume is a PDF, a Word file, Markdown or text, not ${ext || 'this'}` };
  const out = { source: 'file', resumePath: path.resolve(p) };
  if (['.md', '.markdown', '.txt'].includes(ext)) out.resumeText = fs.readFileSync(p, 'utf8');
  else out.needsText = true;
  return out;
}

const signInPage = (url, status, text) => status === 401 || status === 403 || /(^|\.)accounts\.google\.com$/i.test(new URL(url).hostname) || /sign in to continue|log in to continue|ServiceLogin|You need access|Request access/i.test(String(text).slice(0, 4000));

// A public link, fetched once, in code: that exact URL, https only, at most 3 redirects, local and private addresses and
// never-automated hosts refused at each hop. A PDF is saved as resume.pdf, a page as resume.txt (both 0600).
export async function fetchResume(url, fetchImpl = globalThis.fetch, { lookup } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ask: true, why: 'that is not a link' };
  }
  if (u.protocol !== 'https:') return { ask: true, why: 'only https links are read' };
  if (isLinkedIn(url)) return { linkedin: true };
  let cur = u.href;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const host = new URL(cur).hostname;
    if (isNeverAutomated(cur)) return { ask: true, never: true, why: `${host} is never opened by this skill: give a PDF export or the text` };
    if (isLocalHost(host)) return { ask: true, why: 'a local or private address is never read' };
    let res;
    try {
      res = await guardedFetch(cur, { redirect: 'manual', headers: { accept: 'application/pdf,text/html,text/plain,*/*' } }, fetchImpl, { allowUrl: cur, lookup });
    } catch (e) {
      return { ask: true, why: e.message };
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers && res.headers.get ? res.headers.get('location') : null;
      if (!loc || hop === MAX_REDIRECTS) return { ask: true, why: 'too many redirects' };
      try {
        cur = new URL(loc, cur).href;
      } catch {
        return { ask: true, why: 'a bad redirect' };
      }
      if (new URL(cur).protocol !== 'https:') return { ask: true, why: 'a redirect left https' };
      continue;
    }
    const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
    if (!res.ok) return signInPage(cur, res.status, '') ? { signIn: true } : { ask: true, why: `the link answered ${res.status}` };
    if (type.includes('pdf') || /\.pdf($|\?)/i.test(cur)) {
      const buf = await readCapped(res, MAX_BYTES);
      if (!buf) return { ask: true, why: 'the file is too large' };
      { const up = saveToUploads('resume.pdf', buf); return { source: 'link', url, resumePath: up, resumeUploadPath: up, needsText: true }; }
    }
    const body = await readCapped(res, MAX_TEXT_BYTES);
    if (!body) return { ask: true, why: 'the page is too large' };
    const html = body.toString('utf8');
    if (signInPage(cur, res.status, html)) return { signIn: true };
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    if (text.length < 80) return { ask: true, why: 'the page has no readable text' };
    return { source: 'link', url, resumeText: text, resumeTextFile: save('resume.txt', text) };
  }
  return { ask: true, why: 'too many redirects' };
}

// `J resume set --url`: a LinkedIn profile goes to the router as its own need (never fetched or opened by the skill); with no
// Tenjin it is a hint moment and the person gives a PDF export or the text. Every other link is fetched once, in code.
export async function setFromLink({ url, state, client, fetchImpl = globalThis.fetch, lookup }) {
  if (isLinkedIn(url)) {
    if ((state.tenjin || {}).status !== 'ready') {
      const first = askFirst(state, 'linkedin_resume');
      if (first) return { read: false, linkedin: true, ...first };
      return { read: false, linkedin: true, hint: tenjinHint(state, 'linkedin_resume'), askTenjin: tenjinAsk(state), ask: 'a PDF export of the profile (LinkedIn: More, Save to PDF) or the text; the link itself is read only through Tenjin' };
    }
    const r = await readLinkedIn({ url, client });
    if (!r.ok) return { read: false, linkedin: true, status: r.status, ask: 'a PDF export of the profile or the text' };
    return { read: true, ...setText(r.text, { source: 'link' }), url, thin: true };
  }
  const r = await fetchResume(url, fetchImpl, { lookup });
  if (r.signIn) return { read: false, signIn: true, ask: 'a connector can read this only if the person connected one; otherwise a public link, the file or the text' };
  if (r.ask) return { read: false, ask: r.why };
  return { read: true, ...r };
}
