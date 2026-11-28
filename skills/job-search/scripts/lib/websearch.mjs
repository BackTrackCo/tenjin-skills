import { variantFor } from './work.mjs';

// The free web searches, as code states them. The model only runs them (code cannot call WebSearch) and returns the raw
// results; code reads the URLs out, drops the repeats and sorts them (board links, X posts, then the rest).
const SITES = ['jobs.ashbyhq.com', 'job-boards.greenhouse.io', 'boards.greenhouse.io', 'jobs.lever.co'];

export function webPlan(profile, round, lastSearchAt = null, now = Date.now()) {
  const role = variantFor(profile, round) || profile.search.role;
  const place = profile.search.place || '';
  const where = [place ? `"${place}"` : '', profile.search.remote === true ? 'remote' : ''].filter(Boolean).join(' ');
  const since = lastSearchAt ? new Date(Math.max(Date.parse(lastSearchAt) - 86400000, now - 14 * 86400000)) : new Date(now - 14 * 86400000);
  const queries = [...SITES.map((site) => `site:${site} "${role}"${where ? ` ${where}` : ''}`), `site:x.com "hiring" "${role}"${place ? ` "${place}"` : ''}`];
  return {
    round,
    queries,
    query: { role, place, remote: profile.search.remote === true, since: since.toISOString().slice(0, 10), variant: variantFor(profile, round), round },
    returns: 'Run each query with the web search tool, once. Write {"need":"web_search","query":<query above>,"status":"ok","raw":[{"query":"<the query>","results":[{"url","title","snippet"}]}]}. For a result on a job platform (LinkedIn, Indeed and similar) also add company, city and remote, from the result only. Invent nothing.',
  };
}

const URL_OK = /^https?:\/\//i;
// Flattens the raw results of every query into one list: repeats dropped (a URL once, its first fields kept).
export function flattenRaw(raw) {
  const seen = new Set();
  const out = [];
  for (const q of raw) for (const r of q.results || []) {
    if (!r || typeof r.url !== 'string' || !URL_OK.test(r.url)) continue;
    const key = r.url.replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
