// A career-ops folder is one with
// cv.md, config/profile.yml and data/pipeline.md. Dedupe also skips the URLs in its pipeline, applications and scan
// history; on the person's yes, each job that passes is appended under "## Pending". No other file is changed.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeUrl } from './dedupe.mjs';

const FILES = ['cv.md', path.join('config', 'profile.yml'), path.join('data', 'pipeline.md')];
const SEEN_FILES = [path.join('data', 'pipeline.md'), path.join('data', 'applications.md'), path.join('data', 'scan-history.tsv')];

export const isCareerOpsDir = (dir) => FILES.every((f) => fs.existsSync(path.join(dir, f)));

// Setup reads cv.md and config/profile.yml, and asks nothing that they already answer.
export function readCareerOps(dir) {
  if (!isCareerOpsDir(dir)) return null;
  return { cv: fs.readFileSync(path.join(dir, 'cv.md'), 'utf8'), profileYml: fs.readFileSync(path.join(dir, 'config', 'profile.yml'), 'utf8') };
}

export function loadSkipUrls(profile) {
  const skip = new Set();
  const dir = profile && profile.careerOps && profile.careerOps.dir;
  if (!dir) return skip;
  for (const f of SEEN_FILES) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const u of text.match(/https?:\/\/[^\s|)>\]"']+/g) || []) {
      skip.add(u);
      try {
        skip.add(normalizeUrl(u));
      } catch {}
    }
  }
  return skip;
}

// - [ ] <job URL> | <Company> | <Role> | <Location> | note: write to <name, role>[, not confirmed] (<source link>)
export function pipelineLine(job, contact) {
  const url = job.employerPosting ? job.employerPosting.url : job.url;
  const loc = [job.city, job.region].filter(Boolean).join(', ') || (job.remote ? 'Remote' : '');
  const clean = (s) => String(s || '').replace(/\s*\|\s*/g, ' / ').replace(/\s+/g, ' ').trim();
  let line = `- [ ] ${url} | ${clean(job.company)} | ${clean(job.title)} | ${clean(loc)}`;
  if (contact) line += ` | note: write to ${clean(contact.name)}${contact.title ? `, ${clean(contact.title)}` : ''}${contact.notConfirmed ? ', not confirmed' : ''} (${contact.sourceUrl})`;
  return line;
}

// Inserts lines at the end of the "## Pending" section, adding the heading if it is missing. Nothing else changes.
export function appendPending(dir, lines) {
  const file = path.join(dir, 'data', 'pipeline.md');
  const text = fs.readFileSync(file, 'utf8');
  if (!lines.length) return 0;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const parts = text.split(/(?<=\n)/); // keep each line's own ending
  const head = parts.findIndex((l) => /^## Pending\s*$/.test(l));
  let out;
  if (head === -1) {
    const base = text.endsWith('\n') || text === '' ? text : text + eol;
    out = `${base}${eol}## Pending${eol}${lines.join(eol)}${eol}`;
  } else {
    let end = parts.length;
    for (let i = head + 1; i < parts.length; i++) if (/^## /.test(parts[i])) { end = i; break; }
    let at = end;
    while (at > head + 1 && parts[at - 1].trim() === '') at--;
    if (at > 0 && !parts[at - 1].endsWith('\n')) parts[at - 1] += eol;
    out = [...parts.slice(0, at), ...lines.map((l) => l + eol), ...parts.slice(at)].join('');
  }
  fs.writeFileSync(file, out);
  return lines.length;
}
