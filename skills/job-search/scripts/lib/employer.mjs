import { boardTarget, fetchBoard, parseBoardUrl, hostedUrl } from './boards.mjs';
import { hostOf, isNeverAutomated, isYc } from './platforms.mjs';
import { normLabel } from './store.mjs';

const SYSTEMS = ['greenhouse', 'lever', 'ashby'];
const SUFFIXES = ['inc', 'llc', 'ltd', 'limited', 'corp', 'co', 'company', 'plc', 'gmbh', 'ag', 'sa', 'bv', 'oy', 'ab', 'pte'];
const DAY = 86400000;

// ---- the guess: three candidates, nothing else --------------------------------
export function employerWords(name) {
  const w = String(name).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (w.length > 1 && SUFFIXES.includes(w[w.length - 1])) w.pop();
  return w;
}
export const employerName = (name) => employerWords(name).join(' ');

const SECOND_LEVEL = ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'];
export function websiteLabel(site) {
  if (!site) return null;
  let host = String(site).trim().toLowerCase();
  try {
    host = new URL(/^https?:\/\//.test(host) ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  const parts = host.replace(/^www\./, '').split('.');
  if (parts.length < 2) return null;
  const label = parts.length >= 3 && SECOND_LEVEL.includes(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2];
  return /^[a-z0-9-]+$/.test(label) ? label : null;
}

export function candidates(name, website) {
  const w = employerWords(name);
  const list = [w.join(''), w.join('-'), websiteLabel(website)].filter((x) => x && /^[a-z0-9-]+$/.test(x));
  return [...new Set(list)];
}

// ---- matching one posting to one board job --------------------------------
const normTitle = (t) => normLabel(String(t).normalize('NFKC'));
export function jobMatches(posting, job, now = Date.now()) {
  if (normTitle(posting.title) !== normTitle(job.title)) return false;
  const placeOk = (posting.remote && job.remote) || (posting.city && job.city && normLabel(posting.city) === normLabel(job.city));
  if (!placeOk) return false;
  const a = posting.postedAt || posting.posted;
  const b = job.posted;
  if (a && b && Math.abs(Date.parse(a) - Date.parse(b)) > 60 * DAY) return false;
  return true;
}

function ownedBoard(sys, token, jobs, words, label) {
  if (label && token === label) return true;
  // only Greenhouse's board name is trusted
  return sys === 'greenhouse' && jobs.length > 0 && employerName(jobs[0].company) === words.join(' ');
}

const mk = (b, job, source, confidence, now) => ({ url: hostedUrl({ ats: b.ats, region: b.region || 'us', token: b.token, jobId: job.sourceId }), system: b.ats, token: b.token, jobId: job.sourceId, source, confidence, checkedAt: new Date(now).toISOString() });

// Step 2: probes. At most nine requests (three candidates, three systems). A 404 means no board.
// Returns {match: {employerPosting, job}} or {reason: no_board | unconfirmed_board | no_match | multiple_matches}.
export async function probeBoards(posting, { fetch, now = Date.now() }) {
  const label = websiteLabel(posting.employerWebsite);
  const words = employerWords(posting.employer);
  let found = 0;
  const owned = [];
  let requests = 0;
  for (const token of candidates(posting.employer, posting.employerWebsite)) {
    for (const ats of SYSTEMS) {
      requests++;
      const r = await fetchBoard({ ats, token, region: 'us', name: '' }, fetch);
      if (!r.ok) continue;
      found++;
      if (ownedBoard(ats, token, r.jobs, words, label)) owned.push({ ats, token, region: 'us', jobs: r.jobs });
    }
  }
  const res = matchInBoards(posting, owned, 'board_probe', now);
  if (res.match || res.reason) return { ...res, requests };
  return { reason: found ? 'unconfirmed_board' : 'no_board', requests };
}

export function matchInBoards(posting, boards, source, now = Date.now()) {
  if (!boards.length) return {};
  const hits = [];
  for (const b of boards) for (const j of b.jobs) if (jobMatches(posting, j, now)) hits.push([b, j]);
  if (hits.length > 1) return { reason: 'multiple_matches' };
  if (!hits.length) return { reason: 'no_match' };
  const [b, job] = hits[0];
  return { match: { employerPosting: mk(b, job, source, 'confirmed', now), job } };
}

// ---- other hiring systems (named in the report; any system off the deny list is filled) --------------------------
const OTHER = [[/myworkdayjobs\.com|myworkdaysite\.com/, 'Workday'], [/smartrecruiters\.com/, 'SmartRecruiters'], [/icims\.com/, 'iCIMS'], [/workable\.com/, 'Workable'], [/jobvite\.com/, 'Jobvite'], [/bamboohr\.com/, 'BambooHR'], [/recruitee\.com/, 'Recruitee'], [/teamtailor\.com/, 'Teamtailor'], [/personio\.(de|com)/, 'Personio'], [/rippling\.com/, 'Rippling'], [/breezy\.hr/, 'Breezy'], [/successfactors\.(com|eu)/, 'SuccessFactors'], [/taleo\.net/, 'Taleo']];
export function otherSystem(url) {
  let h;
  try {
    h = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const hit = OTHER.find(([re]) => re.test(h));
  return hit ? { system: hit[1], url } : null;
}

// Step 1 and the sorting of links: platform links are never used, a board pattern is exact.
export function classifyLinks(links) {
  const platform = links.filter((l) => isNeverAutomated(l.url));
  const usable = links.filter((l) => !isNeverAutomated(l.url));
  const t = boardTarget(usable);
  const other = null; // an employer system off the deny list is filled; a deny-listed host is a platform link above
  return { platform, usable, target: t, other, yc: platform.some((l) => isYc(l.url)) };
}

// ---- step 3: the employer's own careers page ---------------------------------
// A Haiku step reads the page (code fetches nothing from it) and returns the links it found, the jobs it lists, and whether
// it is a sign-in page. Code sorts the links and matches the listings.
export function careersFromLinks({ boardLinks = [], otherLinks = [], signIn = false, listings = [], careersUrl = null }) {
  if (signIn) return { kind: 'sign_in' };
  const boards = [];
  for (const u of boardLinks) {
    const p = parseBoardUrl(u);
    if (p && SYSTEMS.includes(p.ats) && p.token && /^[A-Za-z0-9._-]+$/.test(p.token) && p.token !== 'embed' && !boards.some((b) => b.ats === p.ats && b.token === p.token)) boards.push({ ats: p.ats, token: p.token, region: p.region });
  }
  if (boards.length) return { kind: 'board', boards };
  if (listings.length) return { kind: 'listing', listings, careersUrl };
  const other = [...boardLinks, ...otherLinks].map(otherSystem).find(Boolean);
  return other ? { kind: 'none', other } : { kind: 'none' };
}

// The careers page is the employer's own when its host is the employer website's domain or a subdomain of it.
export function onEmployerSite(url, website) {
  const a = websiteLabel(url);
  const b = websiteLabel(website);
  return Boolean(a && b && a === b);
}
const systemName = (url) => {
  const o = otherSystem(url);
  return o ? o.system.toLowerCase() : 'employer_site';
};

// A listing on the employer's own careers page counts as confirmed when its title and place match the job: the
// page is the open check, and the browser's first pass reads the live form. A listing on a deny-listed host is the
// "apply yourself" case.
export function matchListing(posting, page, website, now = Date.now()) {
  if (!onEmployerSite(page.careersUrl, website)) return { reason: 'no_careers_page' };
  const hits = page.listings.filter((l) => l && typeof l.url === 'string' && /^https:\/\//.test(l.url) && jobMatches(posting, { ...l, posted: l.postedAt || l.posted }, now));
  const urls = [...new Set(hits.map((l) => l.url))];
  if (urls.length > 1) return { reason: 'multiple_matches' };
  if (!urls.length) return { reason: 'no_match' };
  const url = urls[0];
  if (isNeverAutomated(url)) return { reason: 'other_system', other: { system: hostOf(url), url } };
  return { match: { employerPosting: { url, system: systemName(url), token: null, jobId: null, source: 'careers_page', confidence: 'confirmed', checkedAt: new Date(now).toISOString() }, job: null } };
}

// A board linked from the employer's own page counts as confirmed; the job is matched as in step 2.
export async function resolveFromCareersPage(posting, page, { fetch, now = Date.now(), website = null }) {
  if (page.kind === 'sign_in') return { reason: 'sign_in_wall' };
  if (page.kind === 'none') return { reason: 'no_careers_page', other: page.other || null };
  if (page.kind === 'listing') return matchListing(posting, page, website, now);
  const boards = [];
  for (const b of page.boards) {
    const r = await fetchBoard({ ...b, name: '' }, fetch);
    if (r.ok) boards.push({ ...b, jobs: r.jobs });
  }
  const res = matchInBoards(posting, boards, 'careers_page', now);
  if (res.match) return res;
  return { reason: res.reason || 'no_board' };
}
