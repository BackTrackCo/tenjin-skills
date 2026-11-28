import { boardTarget } from '../boards.mjs';

// The board search, with Tenjin (code only, never a model step): one call to the router's catalog tool by id. Step 1 is
// `{tool}`, which answers a spec with a fresh offer id; step 2 is `{id, input}`, which pays once. An offer id pays once,
// so code fetches a fresh spec before every search and never sends a used id again. Results are data only, never saved;
// only job links that sit on a known board are kept, and code then confirms each on the board's own API, whose date decides
// (the result's `publishedDate` is ISO when present and sometimes missing). The need names no seller and never goes through
// the `{query}` route, which could answer native or pick another API.
export const KIND = 'web_search';
export const BOARD_HOSTS = ['jobs.ashbyhq.com', 'boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co'];

const query = ({ role, place, remote }) => `${role} ${place || (remote === true ? 'remote' : '')}`.replace(/\s+/g, ' ').trim().slice(0, 400);

// RECORDED 2026-11-25: `type` lite ($0.004), `includeDomains` an array of at most 20, `numResults` 1 to 10. Tenjin sets `contents`
// on every call, so the input leaves it out.
export const exa = {
  HOST: 'api.exa.ai',
  KIND,
  TOOL: 'exa-search',
  RECORDED: true,
  NO_CACHE: true,
  mapper: (need) => ({ query: query(need), type: 'lite', includeDomains: BOARD_HOSTS, numResults: 10 }),
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
