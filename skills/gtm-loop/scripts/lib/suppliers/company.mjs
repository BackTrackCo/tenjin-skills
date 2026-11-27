import { str, listOf } from './posts-shared.mjs';

// Companies for a buyer: a list by industry, size and place, and one company by its domain. Both are built from their catalog
// entries, not from a recorded paid answer, so each adapter reads the usual places of a list and refuses an answer with none. A
// company answer is data. A bare domain is kept, never a full URL.
export const bareDomain = (v) => str(v).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0].toLowerCase();

export const list = {
  HOST: 'stableenrich.dev',
  KIND: 'company_list',
  RECORDED: false,
  mapper: ({ industry, size, place }) => {
    const given = (v) => str(v) && !/^(any|anywhere)$/i.test(str(v));
    if (!given(industry) && !given(place)) throw new Error('the company list needs an industry or a place');
    return { ...(given(industry) ? { industry: str(industry) } : {}), ...(given(size) ? { employeeRange: str(size) } : {}), ...(given(place) ? { location: str(place) } : {}), limit: 25 };
  },
  adapter: (res) => {
    const rows = listOf(res, 'companies', 'results', 'data.companies', 'data', 'items', 'organizations');
    if (!rows) throw new Error('the result has no companies list');
    const companies = [];
    for (const c of rows) {
      const domain = bareDomain(c && (c.domain || c.website || c.primary_domain || c.website_url));
      const name = str(c && (c.name || c.company_name));
      if (!domain || !name) continue;
      companies.push({ name, domain, linkedinUrl: str(c.linkedin_url || c.linkedinUrl || (c.socials && c.socials.linkedin_url)) || null, size: str(c.employees || c.employee_count || c.size) || null, country: str(c.country || c.countryCode) || null });
    }
    return { companies };
  },
};

// One company from its domain. The router picks the seller, so the answer's own fields decide.
export const profile = {
  ANY_HOST: true,
  KIND: 'company_profile',
  RECORDED: false,
  NO_CACHE: true,
  mapper: ({ domain }) => {
    const d = bareDomain(domain);
    if (!d || !d.includes('.')) throw new Error('not a company domain');
    return { domain: d };
  },
  adapter: (res) => {
    const r = res && (res.organization || res.company || res.data || res);
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('the result is not one company object');
    const domain = bareDomain(r.domain || r.website || r.primary_domain);
    if (!domain && !str(r.name)) throw new Error('the company has no name and no domain');
    return { name: str(r.name) || null, domain: domain || null, linkedinUrl: str((r.socials && r.socials.linkedin_url) || r.linkedin_url || r.linkedinUrl) || null, size: str(r.employees || r.estimated_num_employees || r.size) || null, country: str(r.country || (r.location && r.location.country)) || null };
  },
};
