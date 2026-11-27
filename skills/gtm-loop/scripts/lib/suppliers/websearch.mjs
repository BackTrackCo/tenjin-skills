import { str, linksOf, listOf, isoOf } from './posts-shared.mjs';
import { DISCUSSION_HOSTS } from '../queries.mjs';

// Web research: pages where someone asks for what the offer is (forums, blogs, issues). Results are kept as leads, with the page's
// own link as the lead's source, never as board links. Input: `query`, `type`, `numResults`; Tenjin sets `contents` on every call.
// The answer is data and is not saved when its terms allow immediate use only (NO_CACHE). The text of a page is never fetched by
// code: only what the answer carries.
export const KIND = 'web_research';
export const exa = {
  HOST: 'api.exa.ai',
  KIND,
  RECORDED: true,
  NO_CACHE: true,
  // For a lead from a post only discussion pages are asked for: forums, community Q&A, Hacker News, Reddit, Indie Hackers and the like.
  // Company and fit research (mode other than "discussion") asks the whole web.
  mapper: ({ query, mode }) => {
    if (!str(query)) throw new Error('no query for the web research');
    // Discussion search describes the post to find in plain words and uses the meaning-based tier (`auto`); research stays on `lite`.
    return mode === 'discussion' ? { query: str(query).slice(0, 400), type: 'auto', numResults: 10, includeDomains: DISCUSSION_HOSTS.slice(0, 20) } : { query: str(query).slice(0, 400), type: 'lite', numResults: 10 };
  },
};

// The page's own site decides the lead's source: a page on a platform site would break the guard if opened by code, so it is
// kept as web and the person opens it. Hosts of X, LinkedIn and Reddit are re-labelled so they dedupe with the post sources.
const siteSource = (url) => (/^https?:\/\/([^/]+\.)?(x|twitter)\.com\//i.test(url) ? 'x' : /^https?:\/\/([^/]+\.)?reddit\.com\//i.test(url) ? 'reddit' : /^https?:\/\/([^/]+\.)?linkedin\.com\//i.test(url) ? 'linkedin' : /^https?:\/\/news\.ycombinator\.com\//i.test(url) ? 'hn' : 'web');
// The seller's input has no published-date field, so the window is applied here: a result older than it is dropped and counted, a
// result with no date is kept as undated and counted. `fields.since` is the round's window start (YYYY-MM-DD).
export function adapter(res, fields = {}) {
  const r = res && typeof res === 'object' ? res : {};
  const list = listOf(r, 'results', 'data.results', 'web.results', 'data.web.results') || (Array.isArray(r) ? r : null);
  if (!list) throw new Error('the result has no results list');
  const posts = list.map((x) => {
    const url = str(x && (x.url || x.link));
    if (!/^https?:\/\//i.test(url)) throw new Error('a result has no url');
    const text = [str(x.title), str(x.text || x.snippet || x.summary || x.description || (Array.isArray(x.highlights) ? x.highlights.join(' ') : ''))].filter(Boolean).join('\n');
    return { url, author: str(x.author), postedAt: isoOf(x.publishedDate || x.published_date || x.published || x.date), text: text.slice(0, 1000), links: linksOf(text), source: siteSource(url) };
  }).filter((p) => p.text);
  if (fields.mode !== 'discussion') return { posts, droppedOld: 0, undated: 0 };
  const since = /^\d{4}-\d{2}-\d{2}/.test(str(fields.since)) ? Date.parse(str(fields.since).slice(0, 10)) : null;
  const kept = posts.filter((p) => since === null || !p.postedAt || Date.parse(p.postedAt) >= since);
  return { posts: kept, droppedOld: posts.length - kept.length, undated: kept.filter((p) => !p.postedAt).length };
}
