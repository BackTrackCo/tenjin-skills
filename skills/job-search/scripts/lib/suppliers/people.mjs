// The people search (recorded 2026-11-24; the result came back empty). Input: `query` with filters, each {include: [...]},
// and `pagination.size`. Lead fields below are from the spec ("first and last name, headline, LinkedIn profileUrl, current
// job title and company"), not yet seen in a recorded response; the one recorded answer was {success, leads: [], total: 0}.
export const HOST = 'x402.orthogonal.com';
export const KIND = 'people_search';

export function mapper({ website, titles, city, count }) {
  const domain = String(website || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
  if (!domain) throw new Error('no employer website for the people search');
  const query = { currentCompanyWebsite: { include: [domain] }, currentJobTitle: { include: titles } };
  if (city) query.location = { include: [city] };
  return { query, pagination: { size: Number.isInteger(count) && count > 0 ? Math.min(count, 25) : 5 } };
}

const str = (v) => (typeof v === 'string' ? v : '');
// A normal empty answer ({total: 0}) is not an error: nobody was found. A person found this way is a likely contact, not
// a confirmed hiring manager, so the contact is marked not confirmed.
export function adapter(res, { jobKey }) {
  if (!res || typeof res.success !== 'boolean' || !Array.isArray(res.leads)) throw new Error('the result has no leads list');
  const contacts = res.leads.map((l) => {
    const name = `${str(l.firstname)} ${str(l.lastname)}`.trim();
    if (!name || !str(l.profileUrl)) throw new Error('a lead has no name or profile link');
    return { name, title: str(l.currentJobTitle), sourceUrl: l.profileUrl, how: 'LinkedIn profile (write from your own account; the skill never opens LinkedIn)', cares: str(l.headline) || str(l.currentJobTitle) || 'engineering at the company', channel: 'linkedin', basis: 'likely', notConfirmed: true };
  });
  return { jobKey, contacts, total: res.total === undefined ? contacts.length : res.total };
}
