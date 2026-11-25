// The people search (recorded 2026-11-24). Input: `query` with filters, each {include: [...]}, and `pagination.size`.
// Result: {total, success, leads[], pagination}; a lead has firstname, lastname, headline, profileUrl, lastJobTitle,
// lastCompanyName and address (a place as free text). The skill never opens profileUrl: it only shows it to the person.
import { nameMatches } from '../company.mjs';
export const HOST = 'x402.orthogonal.com';
export const KIND = 'people_search';

// With no website known, the search runs by company name and city (the name filter is named in the recorded spec, though no recorded answer used it yet);
// its results are weak unless their company matches a known domain or the board's company name (see `adapter`).
export function mapper({ website, company, titles, city, count }) {
  const domain = String(website || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
  if (!domain && !company) throw new Error('no employer website or company name for the people search');
  const query = { ...(domain ? { currentCompanyWebsite: { include: [domain] } } : { currentCompanyName: { include: [company] } }), currentJobTitle: { include: titles } };
  if (city) query.location = { include: [city] };
  return { query, pagination: { size: Number.isInteger(count) && count > 0 ? Math.min(count, 25) : 5 } };
}

const str = (v) => (typeof v === 'string' ? v : '');
const norm = (t) => String(t).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
// With a city, a person whose address does not name it is dropped here, in code: the filter alone is not enough.
export const inPlace = (address, city) => !str(city).trim() || norm(address).includes(norm(String(city).split(',')[0]));
// A normal empty answer ({total: 0}) is not an error: nobody was found. A person found this way is a likely contact, not
// a confirmed hiring manager, so the contact is marked not confirmed.
export function adapter(res, { jobKey, city, names = [], website = null }) {
  if (!res || typeof res.success !== 'boolean' || !Array.isArray(res.leads)) throw new Error('the result has no leads list');
  // A person from a different company is never recorded. A person whose company matches the board's company name, or a known
  // domain, is a likely contact; one with no company on the lead, found without a website, is weak.
  const known = (names || []).filter(Boolean);
  const sameCompany = (l) => {
    const c = str(l && l.lastCompanyName);
    if (!c) return null;
    return known.length ? known.some((n) => nameMatches(n, c)) : null;
  };
  const kept = res.leads.filter((l) => inPlace(l && l.address, city)).filter((l) => sameCompany(l) !== false);
  const contacts = kept.map((l) => {
    const name = `${str(l.firstname)} ${str(l.lastname)}`.trim();
    if (!name || !str(l.profileUrl)) throw new Error('a lead has no name or profile link');
    const title = str(l.lastJobTitle);
    return { name, title, sourceUrl: l.profileUrl, how: 'LinkedIn profile (write from your own account; the skill never opens LinkedIn)', cares: str(l.headline) || title || `engineering at ${str(l.lastCompanyName) || 'the company'}`, channel: 'linkedin', basis: 'likely', notConfirmed: true, ...(!website && sameCompany(l) !== true ? { weak: true } : {}) };
  });
  return { jobKey, contacts, total: res.total === undefined ? contacts.length : res.total };
}
