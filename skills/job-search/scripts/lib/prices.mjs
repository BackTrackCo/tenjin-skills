import { graph } from './graph.mjs';

// What each Tenjin capability costs, as estimates: the recorded provider price, plus the routing fee (15%) for a routed query only,
// rounded up to a tenth of a cent, kept in graph.json under `prices` with the date they were checked and how each need goes (`via`:
// a routed query, or a catalog tool id, which carries no routing fee). Every figure in a hint or the ask is built from this data, so
// a price change flows into the text.
const price = (need) => graph().prices.needs[need].estimateCents;
const tenths = (cents) => Math.round(cents * 10);

export const fmt = (cents) => `${Number.isInteger(cents) ? cents : (Math.round(cents * 10) / 10).toString()}¢`;
const sumTenths = (...needs) => needs.reduce((n, k) => n + tenths(price(k)), 0);

// A search round runs the postings, X and the board search for the role and for each variant in the person's own list, so its
// price follows the real number of variants (the role alone when there are none). A round that adds no new job stops early, so
// this is the most one round costs.
export const variantCount = (profile = {}) => 1 + (Array.isArray((profile.search || {}).variants) ? profile.search.variants.length : 0);
export const roundCents = (profile = {}) => (sumTenths('job_postings', 'x_hiring_posts', 'board_search') * variantCount(profile)) / 10;
const roundWords = (profile) => { const n = variantCount(profile); return n > 1 ? `a round, the role and ${n - 1} variant${n > 2 ? 's' : ''}` : 'a round'; };
export const contactsCents = () => price('people_search');
export const contactsWithLookupCents = () => (tenths(price('people_search')) + tenths(price('company_lookup'))) / 10;

export function paceText(frequency = 'daily', profile = {}) {
  const round = roundCents(profile);
  if (frequency === 'twice_daily') return `At two search rounds a day, that is about ${fmt(round * 2)} a day`;
  if (frequency === 'weekly') return `At one search round a week, that is about ${fmt(round)} a week`;
  return `At one search round a day, that is about ${fmt(round)} a day`;
}

// The hint lines, one per moment, said once. Writing has no line until the Neon switch.
export function hintLines(profile = {}) {
  return {
    daily_search: `With Tenjin, each search round can also cover job postings from LinkedIn, Indeed and other job boards, and hiring posts on X, and search company job boards directly, without using your Claude usage. About ${fmt(roundCents(profile))} ${roundWords(profile)}.`,
    employer_posting: `With Tenjin, I can look up this company's careers page to find its own application page, for about ${fmt(price('careers_page'))}.`,
    contacts: `With Tenjin, I can search for a hiring manager or team lead for the jobs where I found nobody: about ${fmt(contactsCents())} a job, or about ${fmt(contactsWithLookupCents())} when I first need to look up the company's website.`,
    events: `With Tenjin, I can also search the web, public X posts and public LinkedIn posts (also your contacts' own posts) for events by these companies, for about ${fmt(price('board_search') + price('x_hiring_posts') + price('event_posts_linkedin'))} a company, and a little more for each contact.`,
    linkedin_resume: `With Tenjin, I can read your LinkedIn profile from this link, once, for about ${fmt(price('linkedin_profile'))}.`,
  };
}
export const outdatedLine = (version) => `Your Tenjin${version ? ` (${version})` : ''} is out of date. Update it to turn these on again.`;

// The list in the ask: each capability with its own price.
export function offerItems() {
  return {
    sources: 'More job sources: postings from LinkedIn, Indeed and other job boards across the web, and hiring posts on X',
    boards: 'A direct search of company job boards (Greenhouse, Lever, Ashby)',
    posting: `The company's own application page for a job you saw on another site: about ${fmt(price('careers_page'))} a job`,
    contacts: `A hiring manager or team lead to contact when the free search finds nobody: about ${fmt(contactsCents())} a job, or about ${fmt(contactsWithLookupCents())} when the company's website must be looked up first`,
    linkedin: `Your LinkedIn profile link read as your resume: about ${fmt(price('linkedin_profile'))}, once`,
    background: 'These searches run in the background, so they use none of your Claude usage',
  };
}
export const searchRoundNote = (profile = {}) => `  These two run in each search round, for about ${fmt(roundCents(profile))} ${roundWords(profile)}.`;
export const pricesCheckedAt = () => graph().prices.checkedAt;
