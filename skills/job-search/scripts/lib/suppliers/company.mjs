// The company lookup, called by catalog tool id like the board search (a free spec first, then the run): "the best-matching company
// profile from its name or a social URL when the domain is unknown". Its inputs are all optional strings: name, linkedinUrl,
// linkedinId, twitterUrl, facebookUrl, instagramUrl, youTubeUrl; there is no url and no location input, so the board link and the
// city stay code context for the domain check. The ANSWER shape is still UNRECORDED (the fixture is hand-made): the adapter reads a
// website and a name under a few common keys, and whatever the answer says, code checks its domain against the company name and
// the board's company name before saving it.
export const HOST = null; // matched by the tool id, never by a host
export const TOOL = 'companyenrich-properties';
export const INPUTS = ['name', 'linkedinUrl', 'linkedinId', 'twitterUrl', 'facebookUrl', 'instagramUrl', 'youTubeUrl'];
export const KIND = 'company_lookup';
export const RECORDED = false;
export const NO_CACHE = true;
export const ANY_HOST = true;

export function mapper({ company, linkedinUrl }) {
  if (!company && !linkedinUrl) throw new Error('no company name for the lookup');
  return { ...(company ? { name: company } : {}), ...(linkedinUrl ? { linkedinUrl } : {}) };
}

const str = (v) => (typeof v === 'string' ? v : '');
export function adapter(res, { jobKey }) {
  const r = res && typeof res === 'object' ? (Array.isArray(res.companies) ? res.companies[0] : res.company && typeof res.company === 'object' ? res.company : res.data && typeof res.data === 'object' && !Array.isArray(res.data) ? res.data : res) : {};
  if (!r || typeof r !== 'object') throw new Error('the result has no company');
  const website = str(r.website || r.domain || r.homepage || r.url || r.websiteUrl);
  const name = str(r.name || r.companyName || r.company);
  return { jobKey, website: website ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : null, name: name || null };
}
