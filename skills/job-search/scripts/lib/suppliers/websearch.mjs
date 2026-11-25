import { boardTarget } from '../boards.mjs';

// The web search need: one small input mapper per known supplier (their input names differ) and one result adapter that
// reads any result shaped as a list of title, URL and snippet, so it matches the result shape, not one host. The need's
// query keeps the `site:` form: a query that named the boards in words went to the job postings API instead. Results are
// for immediate use only, so none is ever saved and only job links confirmed on the employer's board are kept; a result's
// published date is free text, so it is read against the call's retrieval time or dropped, and the board's own date decides.
export const KIND = 'web_search';
export const BOARD_HOSTS = ['jobs.ashbyhq.com', 'boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co'];

const query = ({ role, place, remote }) => `${role} ${place || ''}${remote === true ? ' remote' : ''}`.replace(/\s+/g, ' ').trim().slice(0, 400);

// RECORDED 2026-11-25: a POST; `include_domains` an array of at most 5, `max_results` at most 10, `date_from` YYYY-MM-DD.
export const agentsearch = {
  HOST: 'api.agentsearchhq.com',
  KIND,
  RECORDED: true,
  NO_CACHE: true,
  mapper: ({ role, place, remote, since }) => ({ query: query({ role, place, remote }), include_domains: BOARD_HOSTS, max_results: 10, ...(since ? { date_from: since } : {}) }),
};

// UNRECORDED: built from the router's spec. `q` (at most 400 characters), `count` 1 to 20, `includeDomains` a comma list or
// a JSON array, `startPublishedDate` ISO 8601.
export const brave = {
  HOST: 'agent-data-tools.revmesh2074.workers.dev',
  KIND,
  RECORDED: false,
  NO_CACHE: true,
  mapper: ({ role, place, remote, since }) => ({ q: query({ role, place, remote }), count: 20, includeDomains: BOARD_HOSTS.join(','), ...(since ? { startPublishedDate: new Date(`${since}T00:00:00Z`).toISOString() } : {}) }),
};

const str = (v) => (typeof v === 'string' ? v : '');
const UNIT = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 };
// "Nov 13, 2026" or an ISO date is read as it is; "6 days ago" is read against the retrieval time; anything else is dropped.
export function readPublished(text, retrievedAt) {
  const t = str(text).trim();
  if (!t) return null;
  const ago = /^(\d+)\s+(minute|hour|day|week|month)s?\s+ago$/i.exec(t);
  if (ago) {
    const base = Date.parse(retrievedAt);
    return Number.isNaN(base) ? null : new Date(base - Number(ago[1]) * UNIT[ago[2].toLowerCase()]).toISOString();
  }
  const d = Date.parse(t);
  return Number.isNaN(d) ? null : new Date(d).toISOString();
}

export function adapter(res) {
  const r = res && typeof res === 'object' ? res : {};
  const list = [r.results, r.data && r.data.results, r.web && r.web.results, r.data && r.data.web && r.data.web.results, Array.isArray(r) ? r : null].find((x) => Array.isArray(x));
  if (!list) throw new Error('the result has no results list');
  const results = [];
  for (const x of list) {
    const url = str(x && (x.url || x.link));
    if (!/^https?:\/\//i.test(url)) throw new Error('a result has no url');
    if (!boardTarget([{ url }])) continue; // only a job link on a board is used; code then confirms it on the board's own API
    results.push({ url, title: str(x.title), postedAt: readPublished(x.publishedDate || x.published_date || x.published || x.date, x.retrieved_at || r.retrieved_at) });
  }
  return { results };
}
