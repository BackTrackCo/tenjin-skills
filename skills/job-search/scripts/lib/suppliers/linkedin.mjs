// The LinkedIn profile reader. UNRECORDED: built from the router's spec step (free), with no step 2 response recorded yet.
// Input: `url` (required), https://www.linkedin.com/in/<handle>. Result: {name, location, followers, about, experience[],
// education[], recentPosts[]} and credit counters; there is no headline and no skills field, so neither is required.
export const HOST = 'x402.orthogonal.com';
export const KIND = 'linkedin_profile';
export const RECORDED = false;

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
const line = (o) => Object.values(o && typeof o === 'object' ? o : {}).filter((v) => typeof v === 'string' && v).join(', ');
// The profile as the resume text: only what the result has. Requires a name or an about text, nothing else.
export function adapter(res) {
  const r = (res && (res.result || res.data || res)) || {};
  if (!str(r.name) && !str(r.about)) throw new Error('the profile has no name and no about text');
  const list = (a) => (Array.isArray(a) ? a : []);
  const parts = [
    str(r.name), str(r.location), str(r.about),
    list(r.experience).length ? `Experience:\n${list(r.experience).map((e) => `- ${line(e)}`).join('\n')}` : '',
    list(r.education).length ? `Education:\n${list(r.education).map((e) => `- ${line(e)}`).join('\n')}` : '',
  ].filter(Boolean);
  return { need: 'linkedin_profile', text: parts.join('\n\n') };
}
