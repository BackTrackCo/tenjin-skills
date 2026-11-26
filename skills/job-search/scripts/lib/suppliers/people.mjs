// The people search (recorded 2026-11-24). Input: `query` with filters, each {include: [...]}, and `pagination.size`.
// Result: {total, success, leads[], pagination}; a lead has firstname, lastname, headline, profileUrl, lastJobTitle,
// lastCompanyName and address (a place as free text). The skill never opens profileUrl: it only shows it to the person.
import { nameMatches } from '../company.mjs';
export const HOST = 'x402.orthogonal.com';
export const KIND = 'people_search';

// With no website known, the search runs by company name and city (RECORDED 2026-11-25: the name filter works); its results are weak unless their company matches a known domain or the board's company name (see `adapter`).
export function mapper({ website, company, titles, city, count, pastCompany }) {
  const domain = String(website || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
  if (!domain && !company) throw new Error('no employer website or company name for the people search');
  const query = { ...(domain ? { currentCompanyWebsite: { include: [domain] } } : { currentCompanyName: { include: [company] } }), ...(Array.isArray(titles) && titles.length ? { currentJobTitle: { include: titles } } : {}), ...(pastCompany ? { pastCompanyName: { include: [pastCompany] } } : {}) };
  if (city) query.location = { include: [city] };
  return { query, pagination: { size: Number.isInteger(count) && count > 0 ? Math.min(count, 25) : 5 } };
}

const str = (v) => (typeof v === 'string' ? v : '');
const norm = (t) => String(t).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
// With a city, a person whose address does not name it is dropped here, in code: the filter alone is not enough.
export const inPlace = (address, city) => !str(city).trim() || norm(address).includes(norm(String(city).split(',')[0]));
// A normal empty answer ({total: 0}) is not an error: nobody was found. A person found this way is a likely contact, not
// a confirmed hiring manager, so the contact is marked not confirmed.
const hostOfUrl = (u) => {
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};
const liPath = (u) => str(u).toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
// A title the loose filter let through that is a sales or solutions role ("CTO" matched "Field CTO").
const SALESY = /\b(field|solutions?|sales|account)\b/i;
// A headline that names a company other than lastCompanyName ("Director of Engineering at <other>") shows an out-of-date record.
const headlineCompany = (h) => {
  const m = /\bat\s+([^|,;]+?)\s*$/i.exec(str(h));
  return m ? m[1].trim() : '';
};

// `known`: the company's names (the posting's and the board's), a domain (`website`) and the company's LinkedIn page (`linkedinUrl`,
// from a company lookup). A person from a different company is never recorded. A person whose company name, LinkedIn page or website
// host matches is a likely contact; one with no company on the lead, found without a website, is weak. A sales or solutions title,
// or a headline naming another company, makes the lead weak too. Leads dropped for their place are counted, so an empty result is
// never a mystery.
export function adapter(res, { jobKey, city, names = [], website = null, linkedinUrl = null }) {
  if (!res || typeof res.success !== 'boolean' || !Array.isArray(res.leads)) throw new Error('the result has no leads list');
  const known = (names || []).filter(Boolean);
  const domain = website ? hostOfUrl(website) : '';
  // true: the lead's company is the one; false: it is another company; null: nothing on the lead to tell
  const sameCompany = (l) => {
    const c = str(l && l.lastCompanyName);
    const host = hostOfUrl(l && l.lastCompanyWebsite);
    if (domain && host) return host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`); // the host, never the path
    if (linkedinUrl && str(l && l.lastCompanyUrl) && liPath(l.lastCompanyUrl) === liPath(linkedinUrl)) return true;
    if (domain) return null; // a domain is known and the lead shows none: the search filter did the matching
    if (c && known.length) return known.some((n) => nameMatches(n, c));
    return null;
  };
  const inCity = res.leads.filter((l) => inPlace(l && l.address, city));
  const outside = res.leads.length - inCity.length;
  const kept = inCity.filter((l) => sameCompany(l) !== false);
  const contacts = kept.map((l) => {
    const name = `${str(l.firstname)} ${str(l.lastname)}`.trim();
    if (!name || !str(l.profileUrl)) throw new Error('a lead has no name or profile link');
    const title = str(l.lastJobTitle);
    const hc = headlineCompany(l.headline);
    const outdated = Boolean(hc) && Boolean(str(l.lastCompanyName)) && !nameMatches(hc, str(l.lastCompanyName));
    const weak = (!website && sameCompany(l) !== true) || SALESY.test(title) || outdated;
    return { name, title, sourceUrl: l.profileUrl, how: 'LinkedIn profile (write from your own account; the skill never opens LinkedIn)', cares: str(l.headline) || title || `engineering at ${str(l.lastCompanyName) || 'the company'}`, channel: 'linkedin', basis: 'likely', notConfirmed: true, ...(weak ? { weak: true } : {}) };
  });
  return { jobKey, contacts, total: res.total === undefined ? contacts.length : res.total, found: res.leads.length, outside, city: str(city) };
}
