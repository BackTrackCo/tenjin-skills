import { str } from './posts-shared.mjs';

// The people search (recorded 2026-11-24). Input: `query` with filters, each {include: [...]}, and `pagination.size`. Result:
// {total, success, leads[], pagination}; a lead has firstname, lastname, headline, profileUrl, lastJobTitle, lastCompanyName and
// address (a place as free text). The skill never opens profileUrl: it keeps it as the person's LinkedIn identity and shows it.
export const HOST = 'x402.orthogonal.com';
export const KIND = 'people_search';

const roles = (role) => String(role || '').split(/\s*(?:,|;|\bor\b|\/)\s*/i).map((s) => s.trim()).filter(Boolean);
export function mapper({ role, domain }) {
  const d = str(domain).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
  if (!d) throw new Error('no company domain for the people search');
  const titles = roles(role);
  return { query: { currentCompanyWebsite: { include: [d] }, ...(titles.length ? { currentJobTitle: { include: titles } } : {}) }, pagination: { size: 5 } };
}

const hostOf = (u) => {
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};
export function adapter(res, fields = {}) {
  if (!res || typeof res.success !== 'boolean' || !Array.isArray(res.leads)) throw new Error('the result has no leads list');
  const domain = hostOf(fields.domain || '');
  const people = [];
  for (const l of res.leads) {
    const name = `${str(l && l.firstname)} ${str(l && l.lastname)}`.trim();
    const profileUrl = str(l && l.profileUrl);
    if (!name || !profileUrl) throw new Error('a lead has no name or profile link');
    // A person from another company is never kept: the filter alone is not enough.
    const h = hostOf(l.lastCompanyWebsite || '');
    if (domain && h && !(h === domain || h.endsWith(`.${domain}`) || domain.endsWith(`.${h}`))) continue;
    people.push({ name, title: str(l.lastJobTitle), headline: str(l.headline), profileUrl, company: str(l.lastCompanyName) || null, address: str(l.address) });
  }
  return { people, total: res.total === undefined ? people.length : res.total };
}
