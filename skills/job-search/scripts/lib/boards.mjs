import { guardedFetch } from './net.mjs';
import { normalizeUrl } from './dedupe.mjs';

// URL parsing -----------------------------------------------------------
export function parseBoardUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const region = host.includes('.eu.') ? 'eu' : 'us';
    if (parts[0] === 'embed') return { ats: 'greenhouse', region, token: u.searchParams.get('for'), jobId: u.searchParams.get('token') };
    if (parts[1] === 'jobs') return { ats: 'greenhouse', region, token: parts[0], jobId: parts[2] || u.searchParams.get('gh_jid') };
    return { ats: 'greenhouse', region, token: parts[0] || null, jobId: u.searchParams.get('gh_jid') };
  }
  if (/(^|\.)lever\.co$/.test(host)) {
    return { ats: 'lever', region: host.includes('.eu.') ? 'eu' : 'us', token: parts[0] || null, jobId: parts[1] || null };
  }
  if (host === 'jobs.ashbyhq.com') return { ats: 'ashby', region: 'us', token: parts[0] || null, jobId: parts[1] || null };
  // a company's own page that carries a Greenhouse job id
  if (u.searchParams.get('gh_jid')) return { ats: 'greenhouse', region: 'us', token: null, jobId: u.searchParams.get('gh_jid') };
  return null;
}

export function hostedUrl({ ats, region = 'us', token, jobId }) {
  if (!token || !jobId) return null;
  if (ats === 'greenhouse') return `https://${region === 'eu' ? 'job-boards.eu.greenhouse.io' : 'boards.greenhouse.io'}/${token}/jobs/${jobId}`;
  if (ats === 'lever') return `https://${region === 'eu' ? 'jobs.eu.lever.co' : 'jobs.lever.co'}/${token}/${jobId}`;
  if (ats === 'ashby') return `https://jobs.ashbyhq.com/${token}/${jobId}`;
  return null;
}

export function boardApiUrl({ ats, region = 'us', token }) {
  if (!/^[A-Za-z0-9._-]+$/.test(token || '')) throw new Error('bad board token');
  // The EU API hosts (boards-api.eu.greenhouse.io, api.eu.lever.co) are not verified.
  if (ats === 'greenhouse') return `https://${region === 'eu' ? 'boards-api.eu.greenhouse.io' : 'boards-api.greenhouse.io'}/v1/boards/${token}/jobs?content=true`;
  if (ats === 'lever') return `https://${region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co'}/v0/postings/${token}?mode=json`;
  if (ats === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${token}`;
  throw new Error(`unsupported ats: ${ats}`);
}

// A watched company is a careers URL the person pastes. Code reads the system and the token.
// Returns {ats, region, token, jobId} or {needsBoard: true} (a page with only ?gh_jid=) or null.
export function parseCareersUrl(raw) {
  const p = parseBoardUrl(raw);
  if (!p) return null;
  if (!p.token || !/^[A-Za-z0-9._-]+$/.test(p.token)) return { needsBoard: true, ats: p.ats, jobId: p.jobId };
  return p;
}

// Normalizers -----------------------------------------------------------
const strip = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&amp;|&#39;|&quot;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
function splitPlace(loc) {
  const first = String(loc || '').split(/[•|;]/)[0].trim();
  const [city = '', region = ''] = first.split(',').map((s) => s.trim());
  return { city, region };
}
const isRemote = (...xs) => xs.some((x) => /remote/i.test(String(x || '')));

export function normalizeGreenhouse(json, entry) {
  return (json.jobs || []).map((j) => {
    const place = splitPlace(j.location && j.location.name);
    const url = hostedUrl({ ats: 'greenhouse', region: entry.region, token: entry.token, jobId: j.id });
    return {
      url, ats: 'greenhouse', board: `greenhouse:${entry.token}`, title: j.title, company: j.company_name || entry.name,
      city: place.city, region: place.region, country: '', remote: isRemote(j.location && j.location.name, j.title),
      posted: j.first_published || j.updated_at || null, type: '', salary: null, applyLinks: [url], desc: strip(j.content),
      place: `${place.city}|${place.region}`, sourceId: String(j.id),
    };
  });
}

export function normalizeLever(json, entry) {
  return (Array.isArray(json) ? json : []).map((j) => {
    const c = j.categories || {};
    const place = splitPlace(c.location);
    const url = hostedUrl({ ats: 'lever', region: entry.region, token: entry.token, jobId: j.id });
    const sr = j.salaryRange;
    return {
      url, ats: 'lever', board: `lever:${entry.token}`, title: j.text, company: entry.name || entry.token,
      city: place.city, region: place.region, country: j.country || '', remote: j.workplaceType === 'remote' || isRemote(c.location),
      posted: j.createdAt ? new Date(j.createdAt).toISOString() : null, type: c.commitment || '',
      salary: sr ? `${sr.min}-${sr.max} ${sr.currency}` : null, applyLinks: [url], desc: strip(j.descriptionPlain || j.openingPlain || j.description),
      place: `${place.city}|${place.region}`, sourceId: String(j.id),
    };
  });
}

export function normalizeAshby(json, entry) {
  return (json.jobs || []).filter((j) => j.isListed !== false).map((j) => {
    const place = splitPlace(j.location);
    const url = hostedUrl({ ats: 'ashby', token: entry.token, jobId: j.id });
    return {
      url, ats: 'ashby', board: `ashby:${entry.token}`, title: j.title, company: entry.name || entry.token,
      city: place.city, region: place.region, country: (j.address && j.address.postalAddress && j.address.postalAddress.addressCountry) || '',
      remote: j.isRemote === true || j.workplaceType === 'Remote', posted: j.publishedAt || null, type: j.employmentType || '',
      salary: null, applyLinks: [j.applyUrl || url], desc: strip(j.descriptionPlain || j.descriptionHtml),
      place: `${place.city}|${place.region}`, sourceId: String(j.id),
    };
  });
}

export function normalizeBoard(ats, json, entry) {
  if (ats === 'greenhouse') return normalizeGreenhouse(json, entry);
  if (ats === 'lever') return normalizeLever(json, entry);
  if (ats === 'ashby') return normalizeAshby(json, entry);
  throw new Error(`unsupported ats: ${ats}`);
}

// Fetch one board. Returns {ok, jobs} or {ok:false, reason}.
export async function fetchBoard(entry, fetchImpl) {
  let res;
  try {
    res = await guardedFetch(boardApiUrl(entry), {}, fetchImpl);
  } catch (e) {
    return { ok: false, reason: `request failed: ${e.message}` };
  }
  if (res.status === 429) return { ok: false, reason: 'rate limited (429)' };
  if (!res.ok) return { ok: false, reason: `http ${res.status}` };
  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: 'not json' };
  }
  const jobs = normalizeBoard(entry.ats, json, entry);
  if (!jobs.length) return { ok: false, reason: 'no postings returned' };
  return { ok: true, jobs };
}

export { normalizeUrl };
