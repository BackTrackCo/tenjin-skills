import { str } from './posts-shared.mjs';

// The LinkedIn profile reader, two sellers (the shape recorded 2026-11-25 for the first; the second built from its catalog entry).
// Input: `url`, https://www.linkedin.com/in/<handle>. The answer gives a name, a headline, a place and the company; it feeds the
// country and company of a person, nothing else. The skill never opens LinkedIn: only the router's seller reads it.
export const KIND = 'linkedin_profile';

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

const firstOf = (a) => (Array.isArray(a) && a[0] && typeof a[0] === 'object' ? a[0] : {});
// The first seller: {name, location, about, experience[]}.
export const profile = {
  HOST: 'x402.orthogonal.com',
  KIND,
  RECORDED: true,
  mapper,
  adapter: (res) => {
    const r = (res && (res.result || res.data || res)) || {};
    if (!str(r.name) && !str(r.about)) throw new Error('the profile has no name and no about text');
    const cur = firstOf(r.experience);
    return { name: str(r.name) || null, headline: null, location: str(r.location), company: str(cur.name) || null, about: str(r.about).slice(0, 500) };
  },
};
// The second seller: {output: {found, data: {firstName, lastName, headline, location, about, currentPosition[], experience[]}}}.
export const history = {
  HOST: 'api.getanyapi.com',
  KIND,
  RECORDED: false,
  mapper,
  adapter: (res) => {
    const out = (res && res.output) || res || {};
    if (out.found === false) throw new Error('the profile was not found');
    const r = out.data || out.result || {};
    const name = [str(r.firstName), str(r.lastName)].filter(Boolean).join(' ');
    if (!name && !str(r.headline) && !str(r.about)) throw new Error('the profile has no name, headline or about text');
    const cur = firstOf(r.currentPosition);
    return { name: name || null, headline: str(r.headline) || null, location: str(r.location), company: str(cur.companyName) || null, about: str(r.about).slice(0, 500) };
  },
};
