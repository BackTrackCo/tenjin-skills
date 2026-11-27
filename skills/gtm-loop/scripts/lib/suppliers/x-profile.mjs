import { str, listOf, linksOf } from './posts-shared.mjs';

// The identity reads: an X profile by handle (name, bio, location, links) and a LinkedIn profile by link. They feed the email
// gates (the country, the company) and nothing else. Built from the catalog entries; an answer with no name, bio or location is
// refused. Links inside the answer are evidence for identity linking, never fetched.
export const KIND = 'x_profile';
export const RECORDED = false;
export const HOST = 'glim.sh';

export const mapper = ({ handle }) => {
  const h = str(handle).replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) throw new Error('not an X handle');
  return { username: h };
};

export function adapter(res) {
  const r = (res && (res.user || res.data || res.result || res)) || {};
  const name = str(r.name);
  const bio = str(r.description || r.bio);
  const location = str(r.location);
  if (!name && !bio && !location) throw new Error('the profile has no name, bio or location');
  const urls = [...(listOf(r, 'entities.url.urls', 'entities.description.urls') || []).map((u) => str(u && u.expanded_url)), str(r.url)].filter(Boolean);
  return { name: name || null, bio, location, links: [...new Set([...urls, ...linksOf(bio)])] };
}
