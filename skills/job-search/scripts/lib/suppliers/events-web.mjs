import { graph } from '../../../../loop-base/lib/graph.mjs';

// The event search with Tenjin: the same web search the board search uses, called by catalog tool id (a free spec first, then the
// run), with the event domains as the filter and the company's name and the place in the query. Results are pages, never saved;
// the skill reads a Luma page itself and leaves the rest for the model's fetch, which confirms an event on its own page.
export const TOOL = 'exa-search';
export const KIND = 'event_web';
export const RECORDED = true;
export const NO_CACHE = true;
export const HOST = 'api.exa.ai';

export function mapper({ company, place }) {
  if (!company) throw new Error('no company for the event search');
  const where = place ? ` ${place}` : '';
  return { query: `${company} meetup OR talk OR hackathon OR "office hours" OR "demo day" OR "recruiting event"${where}`.slice(0, 400), type: 'lite', includeDomains: graph().events.domains.slice(0, 20), numResults: 10 };
}
const str = (v) => (typeof v === 'string' ? v.trim() : '');
export function adapter(res) {
  const r = res && typeof res === 'object' ? res : {};
  const list = [r.results, r.data && r.data.results, Array.isArray(r) ? r : null].find((x) => Array.isArray(x));
  if (!list) throw new Error('the result has no results list');
  return { results: list.map((x) => ({ url: str(x && (x.url || x.link)), title: str(x && x.title).slice(0, 200) })).filter((x) => /^https:\/\//.test(x.url)) };
}
