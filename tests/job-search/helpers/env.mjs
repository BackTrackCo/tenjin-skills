import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SKILL = path.join(ROOT, 'skills', 'job-search');
export const JOBS = path.join(SKILL, 'scripts', 'jobs.mjs');
export const FIX = path.join(ROOT, 'tests', 'job-search', 'fixtures');
export const fixture = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));

// Every test that touches settings or state runs in a temporary HOME. Never the real one.
export function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-test-'));
  process.env.HOME = dir;
  process.env.TENJIN_SKILLS_DIR = path.join(dir, '.tenjin-skills');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

export function runJobs(home, args, { input, cwd } = {}) {
  const r = spawnSync(process.execPath, [JOBS, ...args], { encoding: 'utf8', input, cwd, env: { ...process.env, HOME: home, TENJIN_SKILLS_DIR: path.join(home, '.tenjin-skills'), PATH: '/usr/bin:/bin' } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

export function fakeFetch(map) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const hit = Object.entries(map).filter(([k]) => url.startsWith(k)).sort((a, b) => b[0].length - a[0].length)[0];
    if (!hit) return { ok: false, status: 404, url, text: async () => '', json: async () => ({}) };
    const v = hit[1];
    if (typeof v === 'number') return { ok: v < 400, status: v, url, text: async () => '', json: async () => ({}) };
    if (typeof v === 'string') return { ok: true, status: 200, url, text: async () => v, json: async () => JSON.parse(v) };
    if (v && v.__page) return { ok: v.status < 400, status: v.status, url: v.url || url, text: async () => v.text, json: async () => ({}) };
    return { ok: true, status: 200, url, text: async () => JSON.stringify(v), json: async () => v };
  };
  f.calls = calls;
  return f;
}

export function mkJob(over = {}) {
  const ats = over.ats === undefined ? 'greenhouse' : over.ats;
  const key = over.key || `https://boards.greenhouse.io/acme/jobs/${Math.floor(Math.random() * 1e9)}`;
  const epUrl = { greenhouse: /^https:/.test(key) ? key : 'https://boards.greenhouse.io/acme/jobs/1', lever: 'https://jobs.lever.co/acme/abc-1', ashby: 'https://jobs.ashbyhq.com/acme/abc-1' }[ats] || key;
  const employerPosting = ats ? { url: epUrl, system: ats, token: 'acme', jobId: '1', source: 'apply_link', confidence: 'exact', checkedAt: new Date().toISOString() } : null;
  return { key, url: key, employerPosting, openConfirmed: true, ats: 'greenhouse', board: 'greenhouse:acme', title: 'Software Engineer', company: 'Acme', city: 'Berlin', region: '', country: '', remote: false, posted: new Date().toISOString(), type: 'Full-time', salary: null, desc: 'build things', place: 'Berlin|', hash: 'h1', status: 'new', firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), verifiedAt: new Date().toISOString(), warnings: [], parked: null, ...over };
}
