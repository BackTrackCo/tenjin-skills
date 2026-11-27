import { graph } from './graph.mjs';
import { allPhrases } from './offers.mjs';

// What each router need costs, as estimates: the catalog's provider price plus the routing fee, upper end, in cents per call, kept
// in graph.json under `prices` with the date they were checked. Every figure in a hint, an ask or the report is built from
// this data, so a price change flows into the text.
const price = (need) => graph().prices.needs[need].estimateCents;
export const fmt = (cents) => `${Number.isInteger(cents) ? cents : (Math.round(cents * 10) / 10).toString()} cents`;
export const pricesCheckedAt = () => graph().prices.checkedAt;

const POST_NEEDS = { x: 'x_posts', reddit: 'reddit_posts', linkedin: 'linkedin_posts', web: 'web_research' };
export const postNeedKinds = (sources) => (sources && sources.length ? sources : Object.keys(POST_NEEDS)).filter((s) => POST_NEEDS[s]).map((s) => POST_NEEDS[s]);

// A round: one call per phrase per post source. Hacker News is free.
export function roundCents(profile = {}) {
  const phrases = Math.max(1, allPhrases(profile).length);
  return phrases * postNeedKinds(profile.sources).reduce((n, k) => n + price(k), 0);
}
export const centsOf = (cost) => {
  const m = /([\d.]+)\s*USD/i.exec(String(cost || ''));
  return m ? Math.round(parseFloat(m[1]) * 10000) / 100 : null;
};

export function hintLines(profile = {}) {
  return {
    search: `With Tenjin, each search round also covers posts on X, Reddit and LinkedIn and the web, in the background, with none of your Claude usage: about ${fmt(roundCents(profile))} a round.`,
    fit: `With Tenjin, I can also find people who fit your buyer: a company list (about ${fmt(price('company_list'))}), then people at each company (about ${fmt(price('people_search'))} a company).`,
    email: `With Tenjin, I can look up a work email only when you pick Email for a lead: about ${fmt(price('person_enrichment'))}, then a check for about ${fmt(price('email_check'))}.`,
  };
}
export const outdatedLine = (version) => `Your Tenjin${version ? ` (${version})` : ''} is out of date. Update it to turn these on again.`;
