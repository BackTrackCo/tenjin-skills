// The company lookup (a company, found by name or link, in the router's catalog): the need names the company, the board link and the
// city, and the answer is read as a company with a website. UNRECORDED: built before any recorded spec, so the input is the
// company's name, its link and its place, and the adapter reads a website and a name under a few common keys. Whatever the answer
// says, code checks its domain against the company name and the board's company name before saving it.
export const HOST = null; // the router picks the seller; matched by the need's kind, never by a host
export const KIND = 'company_lookup';
export const RECORDED = false;
export const NO_CACHE = true;
export const ANY_HOST = true;

export function mapper({ company, url, city }) {
  if (!company) throw new Error('no company name for the lookup');
  return { name: company, ...(url ? { url } : {}), ...(city ? { location: city } : {}) };
}

const str = (v) => (typeof v === 'string' ? v : '');
export function adapter(res, { jobKey }) {
  const r = res && typeof res === 'object' ? (Array.isArray(res.companies) ? res.companies[0] : res.company && typeof res.company === 'object' ? res.company : res.data && typeof res.data === 'object' && !Array.isArray(res.data) ? res.data : res) : {};
  if (!r || typeof r !== 'object') throw new Error('the result has no company');
  const website = str(r.website || r.domain || r.homepage || r.url || r.websiteUrl);
  const name = str(r.name || r.companyName || r.company);
  return { jobKey, website: website ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : null, name: name || null };
}
