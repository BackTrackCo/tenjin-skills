// The company lookup, called by catalog tool id like the board search (a free spec first, then the run): "the best-matching company
// profile from its name or a social URL when the domain is unknown". RECORDED 2026-11-25. Its inputs are all optional strings: name,
// linkedinUrl, linkedinId, twitterUrl, facebookUrl, instagramUrl, youTubeUrl; there is no url and no location input, so the board
// link and the city stay code context. The answer is ONE company object with no match score: the tool returns its best match for the
// name, so code trusts `domain` (a bare domain; `website` is a full URL) only when `name` or `legalName` matches the job's company
// name, and never reads `location` (the registered address) as the job's city. `socials.linkedin_url` is the company's LinkedIn page.
export const HOST = null; // matched by the tool id, never by a host
export const TOOL = 'companyenrich-properties';
export const KIND = 'company_lookup';
export const RECORDED = true;
export const NO_CACHE = true;
export const ANY_HOST = true;

export function mapper({ company, linkedinUrl }) {
  if (!company && !linkedinUrl) throw new Error('no company name for the lookup');
  return { ...(company ? { name: company } : {}), ...(linkedinUrl ? { linkedinUrl } : {}) };
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
export function adapter(res, { jobKey }) {
  if (!res || typeof res !== 'object' || Array.isArray(res)) throw new Error('the result is not one company object');
  const domain = str(res.domain).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  return { jobKey, name: str(res.name) || null, legalName: str(res.legalName) || null, domain: domain || null, linkedinUrl: str(res.socials && res.socials.linkedin_url) || null };
}
