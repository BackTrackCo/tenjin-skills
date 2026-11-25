// The web search API for a script. UNRECORDED: built from the router's spec step (free), with no step 2 response recorded.
// Input: `q` (required, at most 400 characters), `count` (1 to 20), `includeDomains` (a comma list or a JSON array, up to
// 20), `excludeDomains`, `startPublishedDate` and `endPublishedDate` (ISO 8601) and others. Result: the top results as
// JSON (title, URL, snippet, published date, domain). Its description says the results are for immediate use only (its
// upstream search provider's terms): they are never saved, and only job links confirmed on the employer's board are kept.
// Two other web search APIs were offered, so the adapter reads the result shape, not only this host.
export const HOST = 'agent-data-tools.revmesh2074.workers.dev';
export const KIND = 'web_search';
export const RECORDED = false;
export const NO_CACHE = true;
import { boardTarget } from '../boards.mjs';

const BOARD_HOSTS = ['jobs.ashbyhq.com', 'boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co'];

export function mapper({ role, place, remote, since }) {
  const q = `${role} ${place || ''}${remote === true ? ' remote' : ''}`.replace(/\s+/g, ' ').trim().slice(0, 400);
  const out = { q, count: 20, includeDomains: BOARD_HOSTS.join(',') };
  if (since) out.startPublishedDate = new Date(`${since}T00:00:00Z`).toISOString();
  return out;
}

const str = (v) => (typeof v === 'string' ? v : '');
export function adapter(res) {
  const r = res && typeof res === 'object' ? res : {};
  const list = [r.results, r.data && r.data.results, r.web && r.web.results, r.data && r.data.web && r.data.web.results, Array.isArray(r) ? r : null].find((x) => Array.isArray(x));
  if (!list) throw new Error('the result has no results list');
  const results = [];
  for (const x of list) {
    const url = str(x && (x.url || x.link));
    if (!/^https?:\/\//i.test(url)) throw new Error('a result has no url');
    if (!boardTarget([{ url }])) continue; // only a job link on a board is used; code then confirms it on the board's own API
    const d = str(x.publishedDate || x.published_date || x.published || x.date);
    results.push({ url, title: str(x.title), postedAt: d && !Number.isNaN(Date.parse(d)) ? d : null });
  }
  return { results };
}
