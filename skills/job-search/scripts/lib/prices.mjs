import { graph } from './graph.mjs';

// What each Tenjin capability costs, as estimates: the recorded provider price, plus the routing fee (15%) for a routed query only,
// rounded up to a tenth of a cent, kept in graph.json under `prices` with the date they were checked and how each need goes (`via`:
// a routed query, or a catalog tool id, which carries no routing fee). Every figure in a hint or the ask is built from this data, so
// a price change flows into the text.
const price = (need) => graph().prices.needs[need].estimateCents;
const tenths = (cents) => Math.round(cents * 10);

// The estimate from a recorded provider price in USD: the price, plus the fee share for a routed query (none for a tool-id call),
// rounded up to a tenth of a cent, in integers.
export function estimateCentsFromUsd(usd, via = 'routed_query') {
  const micro = Math.round(usd * 1e6); // millionths of a dollar
  const pct = via === 'tool_id' ? 100 : Math.round((1 + graph().prices.routingFeeShare) * 100);
  return Math.ceil((micro * pct) / 100 / 1000) / 10; // tenths of a cent, rounded up
}

export const fmt = (cents) => `${Number.isInteger(cents) ? cents : (Math.round(cents * 10) / 10).toString()}¢`;
const sumTenths = (...needs) => needs.reduce((n, k) => n + tenths(price(k)), 0);

// One search round covers the role and its variants: postings, X and the board search for each.
export const roundCents = () => (sumTenths('job_postings', 'x_hiring_posts', 'board_search') * graph().prices.variantsPerRound) / 10;
export const contactsCents = () => price('people_search');
export const contactsWithLookupCents = () => (tenths(price('people_search')) + tenths(price('company_lookup'))) / 10;

export function paceText(frequency = 'daily') {
  const round = roundCents();
  if (frequency === 'twice_daily') return `At two search rounds a day, that is about ${fmt(round * 2)} a day`;
  if (frequency === 'weekly') return `At one search round a week, that is about ${fmt(round)} a week`;
  return `At one search round a day, that is about ${fmt(round)} a day`;
}

// The hint lines, one per moment, said once. Writing has no line until the Neon switch.
export function hintLines() {
  return {
    daily_search: `With Tenjin, each search round can also cover job postings from LinkedIn, Indeed and other job boards, and hiring posts on X, and search company job boards directly, without using your Claude usage. About ${fmt(roundCents())} a round.`,
    employer_posting: `With Tenjin, I can look up this company's careers page to find its own application page, for about ${fmt(price('careers_page'))}.`,
    contacts: `With Tenjin, I can search for a hiring manager or team lead for the jobs where I found nobody: about ${fmt(contactsCents())} a job, or about ${fmt(contactsWithLookupCents())} when I first need to look up the company's website.`,
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
export const searchRoundNote = () => `  These two run in each search round, for about ${fmt(roundCents())} a round.`;
export const pricesCheckedAt = () => graph().prices.checkedAt;
