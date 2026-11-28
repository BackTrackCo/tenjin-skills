import { graph } from './graph.mjs';

// Platforms where automation is not allowed, and the YC properties, whose Terms of Use ban automated access
// (news.ycombinator.com and workatastartup.com included). Nothing here is ever opened by the browser or fetched.
// Hacker News is read only through its official API host, hacker-news.firebaseio.com (see hn.mjs).
export const HN_API_HOST = 'hacker-news.firebaseio.com';
// Only shown to the person as a post author's source link; never fetched or opened.
export const HN_SITE = 'news.ycombinator.com';

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return null;
  }
}
export function isNeverAutomated(url) {
  const h = hostOf(url);
  return Boolean(h && h !== HN_API_HOST && graph().neverHosts.some((b) => h === b || h.endsWith(`.${b}`)));
}
export const isYc = (url) => {
  const h = hostOf(url);
  return Boolean(h && (/(^|\.)ycombinator\.com$/.test(h) || /(^|\.)workatastartup\.com$/.test(h)));
};
export const isLinkedIn = (url) => {
  const h = hostOf(url);
  return Boolean(h && /(^|\.)linkedin\.com$/.test(h));
};
// The job's own LinkedIn link, from a postings source's apply options or the employer's posting: only ever shown to the
// person, never opened, fetched or filled.
export const linkedinOf = (links) => (links || []).map((l) => (typeof l === 'string' ? l : l && l.url)).find((u) => typeof u === 'string' && /^https:\/\//.test(u) && isLinkedIn(u)) || null;

// The job sites: the never-automated sites where a job can be applied to. A job's link on one is shown and opened in the
// person's own browser for them; the skill does nothing on the page. One link per site, in the order the job's links came
// (the site it was found on first).
const JOB_SITES = [['linkedin.com', 'LinkedIn'], ['indeed.com', 'Indeed'], ['glassdoor.com', 'Glassdoor'], ['ziprecruiter.com', 'ZipRecruiter'], ['monster.com', 'Monster'], ['simplyhired.com', 'SimplyHired'], ['careerbuilder.com', 'CareerBuilder'], ['dice.com', 'Dice'], ['wellfound.com', 'Wellfound']];
export function jobSiteOf(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (h === 'www.ycombinator.com' || h === 'ycombinator.com') return /^\/companies\/[a-z0-9-]+\/jobs\/[A-Za-z0-9-]+\/?$/.test(u.pathname) ? 'Y Combinator' : null;
  if (h === 'www.workatastartup.com' || h === 'workatastartup.com') return /^\/jobs\/\d+/.test(u.pathname) ? 'Work at a Startup' : null;
  const hit = JOB_SITES.find(([d]) => h === d || h.endsWith(`.${d}`));
  return hit ? hit[1] : null;
}
export function siteLinksOf(links) {
  const out = [];
  for (const l of links || []) {
    const url = typeof l === 'string' ? l : l && l.url;
    const site = typeof url === 'string' ? jobSiteOf(url) : null;
    if (site && !out.some((x) => x.site === site)) out.push({ site, url });
  }
  return out;
}
