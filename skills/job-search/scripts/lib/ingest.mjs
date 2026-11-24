import { graph } from './graph.mjs';
import { boardTarget, fetchBoard } from './boards.mjs';
import { classifyLinks, parseCareersPage, probeBoards, resolveFromCareersPage } from './employer.mjs';
import { fetchPublicPage } from './net.mjs';
import { isYc } from './platforms.mjs';
import { mergeJobs, normalizeUrl } from './dedupe.mjs';
import { effectiveProfile } from './overlay.mjs';
import { catchUpDays } from './sweep.mjs';
import { screenJob } from './verify.mjs';
import { updateState } from './store.mjs';

// The request tool's envelope status, copied exactly. Only a fulfilled result is clean. Every other word
// (unverified, running, needs_approval, needs_input, unpaid, failed, native) holds the source for this run.
export const DELIVERED = ['fulfilled'];
const NEEDS = ['job_postings', 'x_hiring_posts', 'hn_hiring_posts', 'careers_page'];
const POSTING_NEEDS = ['job_postings', 'hn_hiring_posts'];
const isStr = (v) => typeof v === 'string' && v.trim() !== '';

// The skill's own shape, never a seller's raw body. Code never guesses a field.
export function validateIngest(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'not an object';
  if (!NEEDS.includes(o.need)) return `need must be one of ${NEEDS.join(', ')}`;
  if (o.need === 'careers_page') {
    if (!isStr(o.status)) return 'status is missing';
    if (!DELIVERED.includes(o.status)) return `status "${o.status}" is not a delivered result (fulfilled)`;
    if (!isStr(o.jobKey) || !/^https:\/\//.test(String(o.careersUrl || ''))) return 'careers_page needs jobKey and an https careersUrl';
    return null;
  }
  const q = o.query;
  if (!q || typeof q !== 'object' || !isStr(q.role) || typeof q.place !== 'string' || typeof q.remote !== 'boolean' || !(q.since === null || isStr(q.since))) return 'query needs role, place, remote and since';
  if (!isStr(o.status)) return 'status is missing';
  if (!DELIVERED.includes(o.status)) return `status "${o.status}" is not a delivered result (fulfilled)`;
  const list = POSTING_NEEDS.includes(o.need) ? o.postings : o.posts;
  if (!Array.isArray(list)) return POSTING_NEEDS.includes(o.need) ? 'postings must be a list' : 'posts must be a list';
  if (!list.length) return 'the list is empty';
  for (const [i, p] of list.entries()) {
    const at = `${POSTING_NEEDS.includes(o.need) ? 'posting' : 'post'} ${i}`;
    if (POSTING_NEEDS.includes(o.need)) {
      if (p.employerWebsite !== undefined && p.employerWebsite !== null && typeof p.employerWebsite !== 'string') return `${at}: employerWebsite must be text`;
      if (!isStr(p.title) || !isStr(p.employer)) return `${at}: title and employer are required`;
      for (const k of ['city', 'region', 'country', 'employmentType']) if (typeof p[k] !== 'string') return `${at}: ${k} must be a string`;
      if (typeof p.remote !== 'boolean') return `${at}: remote must be true or false`;
      if (!(p.postedAt === null || isStr(p.postedAt)) || (p.postedAt && Number.isNaN(Date.parse(p.postedAt)))) return `${at}: postedAt must be a date or null`;
      const s = p.salary;
      if (s !== null && !(s && typeof s === 'object' && ['min', 'max'].every((k) => s[k] === null || typeof s[k] === 'number') && typeof s.currency === 'string' && typeof s.period === 'string')) return `${at}: salary must be null or {min, max, currency, period}`;
      if (!Array.isArray(p.applyLinks) || p.applyLinks.some((l) => !l || !isStr(l.url) || typeof l.publisher !== 'string')) return `${at}: applyLinks must be a list of {url, publisher}`;
      if (typeof p.description !== 'string' || p.description.length > 2000) return `${at}: description must be text of at most 2,000 characters`;
      if (!isStr(p.sourceUrl)) return `${at}: sourceUrl is required`;
    } else {
      if (!isStr(p.url) || typeof p.author !== 'string' || typeof p.text !== 'string' || !(p.postedAt === null || isStr(p.postedAt))) return `${at}: url, author, postedAt and text are required`;
    }
  }
  return null;
}

const salaryText = (s) => (s ? `${s.min ?? ''}-${s.max ?? ''} ${s.currency}/${s.period}` : null);

// Pure with respect to state: reads a snapshot, returns what to persist.
export async function planIngest({ obj, state, profile, overlay, fetch, now = Date.now() }) {
  const reason = validateIngest(obj);
  const need = obj && NEEDS.includes(obj.need) ? obj.need : 'unknown';
  const plan = { need, held: [], jobs: [], unresolved: 0, careers: null, posts: [], dropped: 0, closed: 0, cost: obj && obj.cost !== undefined ? String(typeof obj.cost === 'object' ? JSON.stringify(obj.cost) : obj.cost).slice(0, 80) : null };
  if (reason) {
    plan.held.push({ reason: 'source_empty', detail: `routed:${need}: ${reason}` });
    return plan;
  }
  if (need === 'careers_page') return planCareers({ obj, state, fetch, now, plan });
  if (need === 'x_hiring_posts') {
    const known = new Set((state.posts || []).map((p) => p.url));
    for (const p of obj.posts) if (!known.has(p.url)) plan.posts.push({ url: p.url, author: p.author, postedAt: p.postedAt, text: p.text.slice(0, 1000), status: 'new' });
    return plan;
  }
  const eff = effectiveProfile(profile, overlay);
  eff.windowDays = catchUpDays(state, now, profile.windowDays || 14);
  const boards = new Map();
  const getBoard = async (t) => {
    const id = `${t.ats}:${t.token}`;
    if (!boards.has(id)) boards.set(id, await fetchBoard({ ats: t.ats, token: t.token, region: t.region || 'us', name: '' }, fetch));
    return boards.get(id);
  };
  const via = need === 'hn_hiring_posts' ? 'hn' : 'routed';
  for (const p of obj.postings) {
    const asJob = { title: p.title, company: p.employer, city: p.city, region: p.region, country: p.country, remote: p.remote, posted: p.postedAt, type: p.employmentType, salary: salaryText(p.salary), desc: p.description };
    const screen = screenJob(asJob, eff, overlay, now);
    if (screen.drop.length) {
      plan.dropped++;
      continue;
    }
    // Step 1: an apply link on Greenhouse, Lever or Ashby is exact. A platform link is never used or opened.
    const cl = classifyLinks(p.applyLinks);
    let boardJob = null;
    let ep = null;
    let unresolved = null;
    if (cl.target) {
      const t = cl.target;
      const b = await getBoard(t);
      if (!b.ok) {
        const d = `routed:${need}: board ${t.ats}:${t.token} unavailable (${b.reason})`;
        if (!plan.held.some((h) => h.detail === d)) plan.held.push({ reason: 'source_empty', detail: d });
        continue;
      }
      boardJob = b.jobs.find((j) => j.sourceId === String(t.jobId));
      if (!boardJob) {
        plan.closed++; // absent from the board list means closed
        continue;
      }
      ep = { url: t.url, system: t.ats, token: t.token, jobId: String(t.jobId), source: 'apply_link', confidence: 'exact', checkedAt: new Date(now).toISOString() };
    } else {
      // Step 2: board probes, free, at most nine requests.
      const r = await probeBoards({ ...p }, { fetch, now });
      if (r.match) {
        boardJob = r.match.job;
        ep = r.match.employerPosting;
      } else {
        unresolved = r.reason;
        if (!p.applyLinks.length && r.reason === 'no_board') unresolved = 'no_apply_link';
        if (cl.yc && !cl.other && ['no_board', 'no_apply_link', 'unconfirmed_board', 'no_match'].includes(unresolved)) unresolved = 'yc_platform_only';
      }
    }
    if (ep) {
      plan.jobs.push({ ...boardJob, company: boardJob.company && boardJob.company !== ep.token ? boardJob.company : p.employer, salary: boardJob.salary || salaryText(p.salary), posted: boardJob.posted || p.postedAt, warnings: screen.warnings, via, employerPosting: ep, employerWebsite: p.employerWebsite || null });
      continue;
    }
    // Unresolved: kept as a job so review can run; it never reaches the apply queue without an exact or confirmed posting.
    const key = p.applyLinks.length ? p.applyLinks[0].url : p.sourceUrl;
    const yc = p.applyLinks.map((l) => l.url).find((u) => /workatastartup\.com/.test(u)) || p.applyLinks.map((l) => l.url).find(isYc) || null;
    plan.jobs.push({ url: key, ats: null, board: null, title: p.title, company: p.employer, city: p.city, region: p.region, country: p.country, remote: p.remote, posted: p.postedAt, type: p.employmentType, salary: salaryText(p.salary), desc: p.description, applyLinks: p.applyLinks.map((l) => l.url), place: `${p.city}|${p.region}`, warnings: screen.warnings, via, employerPosting: null, unresolved, otherSystem: cl.other, workAtStartupUrl: unresolved === 'yc_platform_only' ? yc : null, platformLinks: cl.platform, employerWebsite: p.employerWebsite || null, sourceUrl: p.sourceUrl });
    plan.unresolved++;
  }
  return plan;
}

// Step 3: the person's Haiku step found the employer's careers page; code fetches it for free.
async function planCareers({ obj, state, fetch, now, plan }) {
  const job = state.jobs[obj.jobKey];
  if (!job) {
    plan.held.push({ reason: 'source_empty', detail: `routed:careers_page: unknown job ${obj.jobKey}` });
    return plan;
  }
  let page;
  try {
    page = parseCareersPage(await fetchPublicPage(obj.careersUrl, fetch));
  } catch (e) {
    page = { kind: 'none', error: e.message };
  }
  const posting = { title: job.title, employer: job.company, city: job.city, remote: job.remote, postedAt: job.posted };
  const r = await resolveFromCareersPage(posting, page, { fetch, now });
  plan.careers = { key: obj.jobKey, result: r.match ? { employerPosting: r.match.employerPosting, job: r.match.job } : { reason: r.reason, other: r.other || null } };
  return plan;
}

export function persistIngest(plan, now = Date.now()) {
  const at = new Date(now).toISOString();
  return updateState((state) => {
    const added = mergeJobs(state, plan.jobs, at);
    if (plan.careers) {
      const j = state.jobs[plan.careers.key];
      const r = plan.careers.result;
      j.careersChecked = true;
      if (r.employerPosting) {
        j.employerPosting = r.employerPosting;
        j.unresolved = null;
        j.ats = r.employerPosting.system;
        j.board = `${r.employerPosting.system}:${r.employerPosting.token}`;
        j.sourceId = r.employerPosting.jobId;
        j.applyLinks = [r.employerPosting.url];
      } else {
        j.unresolved = r.reason;
        j.otherSystem = r.other || j.otherSystem || null;
      }
    }
    state.posts = [...(state.posts || []), ...plan.posts];
    state.held = [...state.held.filter((h) => !String(h.detail).startsWith(`routed:${plan.need}`)), ...plan.held];
    state.routed = { ...(state.routed || {}), skipReason: null, lastSearchAt: at, lastCost: plan.cost || (state.routed || {}).lastCost || null };
    return { added: added.length, applyYourself: plan.unresolved, careers: plan.careers ? (plan.careers.result.reason || 'resolved') : undefined, posts: plan.posts.length, closedOnBoard: plan.closed, dropped: plan.dropped, held: plan.held.map((h) => h.detail) };
  });
}

export async function ingest(args) {
  return persistIngest(await planIngest(args), args.now);
}

export { boardTarget, normalizeUrl };
