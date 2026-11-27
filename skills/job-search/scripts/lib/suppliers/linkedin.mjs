// The LinkedIn profile reader (RECORDED 2026-11-25; the cleaned response is in the router fixtures). Input: `url`
// (required), https://www.linkedin.com/in/<handle>. Result: {name, location, followers, about, experience[], education[],
// recentPosts[], articles[]} and credit counters. It is a thin profile: `experience[]` names employers with dates and no
// job title or description; `member.startDate` is a string ("2014-02") or a number (2018); `education[]` mixes schools
// (`@type` "EducationalOrganization") with board seats ("Organization"), and only schools are education. There is no
// headline and no skills field, so neither is required or invented.
export const HOST = 'x402.orthogonal.com';
export const KIND = 'linkedin_profile';
export const RECORDED = true;

export function mapper({ url }) {
  let u;
  try {
    u = new URL(String(url || '').trim());
  } catch {
    throw new Error('the profile link is not a link');
  }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname) || !/^\/in\/[^/]+/i.test(u.pathname)) throw new Error('not a linkedin.com/in/ profile link');
  return { url: `https://www.linkedin.com/in/${u.pathname.split('/')[2]}` };
}

const str = (v) => (typeof v === 'string' ? v : '');
// "2014-02" stays, 2018 becomes "2018", anything else is no date.
export const normDate = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' && /^\d{4}(-\d{2})?(-\d{2})?$/.test(v.trim()) ? v.trim() : null);
const stint = (e) => ({ name: str(e && e.name), location: str(e && e.location) || null, start: normDate(e && e.member && e.member.startDate), end: normDate(e && e.member && e.member.endDate) });
const span = (s) => (s.start || s.end ? ` (${s.start || '?'} to ${s.end || 'now'})` : '');

// The profile as the resume text, from what the result has. Requires a name or an about text, nothing else. `thin` is
// always true: there are no job titles, so the target role is confirmed with the person.
export function adapter(res) {
  const r = (res && (res.result || res.data || res)) || {};
  if (!str(r.name) && !str(r.about)) throw new Error('the profile has no name and no about text');
  const list = (a) => (Array.isArray(a) ? a : []);
  const employers = list(r.experience).map(stint).filter((e) => e.name);
  const schools = list(r.education).filter((e) => e && e['@type'] === 'EducationalOrganization').map(stint).filter((e) => e.name);
  const parts = [
    str(r.name), str(r.location), str(r.about),
    employers.length ? `Employers:\n${employers.map((e) => `- ${e.name}${span(e)}`).join('\n')}` : '',
    schools.length ? `Education:\n${schools.map((e) => `- ${e.name}${span(e)}`).join('\n')}` : '',
  ].filter(Boolean);
  return { need: 'linkedin_profile', text: parts.join('\n\n'), employers, schools, thin: true };
}
