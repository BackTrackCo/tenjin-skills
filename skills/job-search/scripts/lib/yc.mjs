import { graph } from './graph.mjs';
import { guardedFetch } from './net.mjs';
import { planIngest, persistIngest } from './ingest.mjs';
import { loadOverlay } from './overlay.mjs';
import { loadState, updateState } from './store.mjs';
import { INTERVAL_MS, frequencyOf } from './schedule.mjs';

// The public Y Combinator job pages, read in code for discovery only, logged out, through guardedFetch and nothing else:
// the role page (and its place page) and the company page. The paths were checked against YC's robots.txt when they were chosen
// (a recorded copy is in the tests); robots.txt is never fetched at run time. The browser never opens a YC host and nothing is filled
// or applied there. A job found here goes through the employer-posting steps like any posting; the pages' relative dates are
// never used, and the employer's board says whether the job is open.
const ORIGIN = () => `https://${graph().ycRead.host}`;
export const ycPaceMs = () => graph().ycRead.paceMs; // between two YC requests, one at a time
export const DEFAULT_YC_BUDGET_MS = 90_000;
const SAVE_EVERY = 20;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// The role words of the profile mapped to YC's role pages. No fit: no YC read.
const ROLE_RULES = [
  [/scientist|research|machine learning|\bml\b/, 'science'],
  [/design|\bux\b|\bui\b/, 'designer'],
  [/product manag|product owner|\bpm\b/, 'product-manager'],
  [/recruit|talent|\bhr\b|people ops/, 'recruiting-hr'],
  [/sales|account exec|business development|\bsdr\b|\bbdr\b/, 'sales-manager'],
  [/marketing|growth|content|seo/, 'marketing'],
  [/support|customer success|customer service/, 'support'],
  [/operations|\bops\b|chief of staff/, 'operations'],
  [/engineer|developer|software|programmer|devops|\bsre\b|full.?stack|backend|frontend/, 'software-engineer'],
];
export function ycRoleSlug(profile) {
  const role = String((profile.search || {}).role || '').toLowerCase();
  const hit = ROLE_RULES.find(([re]) => re.test(role));
  return hit ? hit[1] : null;
}

const decode = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// The page is server-rendered: its data is JSON in the data-page attribute. Returns the parsed object or null.
export function dataPage(html) {
  const m = /\sdata-page="([^"]*)"/.exec(String(html || ''));
  if (!m) return null;
  try {
    return JSON.parse(decode(m[1]));
  } catch {
    return null;
  }
}

const ROLE_JOB = /^\/companies\/[a-z0-9-]+\/jobs\/[A-Za-z0-9-]+$/;
const COMPANY = /^\/companies\/[a-z0-9-]+$/;
// The listing: only postings of the expected shape are kept; null when the page is not the listing page or no posting fits.
export function parseListing(html) {
  const d = dataPage(html);
  if (!d || d.component !== 'WaasJobListingsPage' || !d.props || !Array.isArray(d.props.jobPostings)) return null;
  const postings = d.props.jobPostings.filter((j) => j && typeof j.title === 'string' && typeof j.companyName === 'string' && ROLE_JOB.test(String(j.url)) && COMPANY.test(String(j.companyUrl)) && typeof j.location === 'string');
  if (d.props.jobPostings.length && !postings.length) return null;
  const places = [];
  for (const l of d.props.jobLocations || []) if (l && typeof l.slug === 'string' && typeof l.name === 'string') places.push({ slug: l.slug, name: l.name });
  for (const l of d.props.sidebarLinks || []) {
    const slug = Array.isArray(l) && typeof l[1] === 'string' ? l[1].split('/').pop() : null;
    if (slug && typeof l[0] === 'string' && !places.some((p) => p.slug === slug)) places.push({ slug, name: l[0].replace(/ jobs$/i, '') });
  }
  return { postings: postings.map((j) => ({ title: j.title, company: j.companyName, url: j.url, companyUrl: j.companyUrl, location: j.location, type: typeof j.type === 'string' ? j.type : '' })), places };
}

// The employer's website from a company page: exactly props.company.website, when props.company.name is the company asked for.
// Nothing else on the page is read, and no person's data (the founders) is ever read or stored.
export function companyWebsite(html, name = null) {
  const d = dataPage(html);
  const c = d && d.props && d.props.company;
  if (!c || typeof c !== 'object' || typeof c.website !== 'string' || !/^https?:\/\//i.test(c.website) || /ycombinator\.com|workatastartup\.com/i.test(c.website)) return null;
  if (name !== null && String(c.name || '').trim().toLowerCase() !== String(name).trim().toLowerCase()) return null;
  return c.website;
}

// The place: a YC place page for the person's city when it lists one, else the role page filtered by the posting's own text.
export function placeSlug(places, profile) {
  const s = profile.search || {};
  const city = String(s.place || '').split(',')[0].trim().toLowerCase();
  if (city) return (places.find((p) => p.name.toLowerCase() === city) || {}).slug || null;
  return profile.remote ? (places.find((p) => p.slug === 'remote') || {}).slug || null : null;
}
export function keepPlace(location, profile) {
  const s = profile.search || {};
  const city = String(s.place || '').split(',')[0].trim().toLowerCase();
  const loc = String(location || '').toLowerCase();
  if (!city) return true;
  return loc.includes(city) || (profile.remote !== false && /\bremote\b/.test(loc));
}

export function toPosting(j, website) {
  const first = j.location.split('/')[0].split(',')[0].trim();
  const url = `${ORIGIN()}${j.url}`;
  return { title: j.title, employer: j.company, employerWebsite: website || null, city: /^remote/i.test(first) ? '' : first, region: '', country: '', employmentType: j.type || '', remote: /\bremote\b/i.test(j.location), postedAt: null, salary: null, applyLinks: [{ url, publisher: 'Y Combinator' }], description: '', sourceUrl: url };
}

export const ycDue = (state, profile, now) => Boolean(profile.search && profile.search.role && profile.yc !== false && ycRoleSlug(profile) && (!state.yc || !state.yc.lastAt || (state.yc.remaining || 0) > 0 || now - Date.parse(state.yc.lastAt) >= INTERVAL_MS[frequencyOf(profile)] - 4 * 3600000));

// One run. One request at a time with the fixed pace between them; a page that fails or changes
// shape is skipped with one line, never retried; the time budget leaves the rest for the next run.
export async function runYc({ fetch, profile, state = loadState(), sleep = sleepMs, clock = Date.now, budgetMs = DEFAULT_YC_BUDGET_MS, now = Date.now(), ingestImpl = null }) {
  const lines = [];
  const started = clock();
  let requests = 0;
  const done = new Set((state.yc || {}).done || []);
  const sites = { ...((state.yc || {}).sites || {}) };
  const save = (extra = {}) => updateState((s) => {
    s.yc = { ...(s.yc || {}), done: [...done], sites, ...extra };
    s.held = [...s.held.filter((h) => !String(h.detail).startsWith('yc:')), ...lines.map((detail) => ({ reason: 'source_empty', detail }))];
  });
  const skip = (detail) => { if (!lines.includes(detail)) lines.push(detail); };
  const finish = (r, extra) => { save({ lastAt: new Date(now).toISOString(), remaining: 0, ...extra }); return { ...r, lines, requests }; };
  const get = async (path) => {
    if (requests > 0) await sleep(ycPaceMs());
    requests++;
    let res;
    try {
      res = await guardedFetch(`${ORIGIN()}${path}`, {}, fetch, { yc: true });
    } catch (e) {
      return { ok: false, reason: `request failed: ${e.message}` };
    }
    if (res.status !== 200) return { ok: false, reason: `http ${res.status}` };
    try {
      return { ok: true, text: await res.text() };
    } catch {
      return { ok: false, reason: 'unreadable page' };
    }
  };
  const slug = ycRoleSlug(profile);
  if (!slug) return finish({ fetched: 0, kept: 0, remaining: 0 }, {});
  const rolePath = `/jobs/role/${slug}`;
  const page = await get(rolePath);
  let listing = page.ok ? parseListing(page.text) : null;
  if (!listing) {
    skip(`yc: ${rolePath} skipped (${page.ok ? 'the page changed shape' : page.reason})`);
    return finish({ fetched: 0, kept: 0, remaining: 0 }, {});
  }
  const ps = placeSlug(listing.places, profile);
  if (ps) {
    const pp = `${rolePath}/${ps}`;
    const p2 = await get(pp);
    const l2 = p2.ok ? parseListing(p2.text) : null;
    if (l2) listing = l2;
    else skip(`yc: ${pp} skipped (${p2.ok ? 'the page changed shape' : p2.reason}); the role page is used`);
  }
  const fresh = listing.postings.filter((j) => (ps || keepPlace(j.location, profile)) && !done.has(j.url));
  const q = profile.search || {};
  const run = ingestImpl || (async (postings) => {
    const prev = loadState().routed;
    const plan = await planIngest({ obj: { need: 'job_postings', status: 'fulfilled', query: { role: q.role, place: q.place || '', remote: profile.remote !== false, since: null }, postings }, state: loadState(), profile, overlay: loadOverlay(), fetch, now });
    for (const h of plan.held) skip(h.detail.replace(/^routed:job_postings/, 'yc'));
    plan.held = [];
    plan.need = 'yc';
    plan.noClock = true;
    const r = persistIngest(plan, now);
    updateState((s) => { s.routed = prev; }); // a YC read is not a routed search round
    return r;
  });
  let kept = 0;
  let pending = [];
  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const r = await run(batch.map((b) => b.posting));
    kept += r.added || 0;
    for (const b of batch) done.add(b.job.url);
    save();
  };
  let consumed = 0;
  const byCompany = new Map();
  for (const j of fresh) byCompany.set(j.companyUrl, [...(byCompany.get(j.companyUrl) || []), j]);
  for (const [companyUrl, jobs] of byCompany) {
    if (clock() - started >= budgetMs) break;
    if (!(companyUrl in sites)) {
      const c = await get(companyUrl);
      if (!c.ok) {
        skip(`yc: ${companyUrl} skipped (${c.reason}); its jobs are read without the company's website`);
        sites[companyUrl] = null;
      } else {
        sites[companyUrl] = companyWebsite(c.text, jobs[0].company);
        if (!sites[companyUrl]) skip(`yc: ${companyUrl} gave no website for the employer`);
      }
    }
    for (const j of jobs) {
      pending.push({ job: j, posting: toPosting(j, sites[companyUrl]) });
      consumed++;
    }
    if (pending.length >= SAVE_EVERY) await flush();
  }
  await flush();
  const remaining = fresh.length - consumed;
  save({ lastAt: new Date(now).toISOString(), remaining });
  return { fetched: consumed, kept, remaining, lines, requests, done: remaining === 0 };
}
