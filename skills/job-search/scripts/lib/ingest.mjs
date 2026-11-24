import { graph } from './graph.mjs';
import { fetchBoard, hostedUrl, parseBoardUrl } from './boards.mjs';
import { mergeJobs, normalizeUrl } from './dedupe.mjs';
import { effectiveProfile } from './overlay.mjs';
import { catchUpDays } from './sweep.mjs';
import { screenJob } from './verify.mjs';
import { updateState } from './store.mjs';

// The request tool's status as returned. The exact vocabulary is not verified, so a delivered result
// is one of these words; anything else holds the source.
export const DELIVERED = ['ok', 'completed', 'delivered', 'success', 'succeeded'];
const NEEDS = ['job_postings', 'x_hiring_posts'];
const isStr = (v) => typeof v === 'string' && v.trim() !== '';

// The skill's own shape, never a seller's raw body. Code never guesses a field.
export function validateIngest(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'not an object';
  if (!NEEDS.includes(o.need)) return `need must be one of ${NEEDS.join(', ')}`;
  const q = o.query;
  if (!q || typeof q !== 'object' || !isStr(q.role) || typeof q.place !== 'string' || typeof q.remote !== 'boolean' || !(q.since === null || isStr(q.since))) return 'query needs role, place, remote and since';
  if (!isStr(o.status)) return 'status is missing';
  if (!DELIVERED.includes(o.status.toLowerCase())) return `status "${o.status}" is not a delivered result`;
  const list = o.need === 'job_postings' ? o.postings : o.posts;
  if (!Array.isArray(list)) return o.need === 'job_postings' ? 'postings must be a list' : 'posts must be a list';
  if (!list.length) return 'the list is empty';
  for (const [i, p] of list.entries()) {
    const at = `${o.need === 'job_postings' ? 'posting' : 'post'} ${i}`;
    if (o.need === 'job_postings') {
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

// Where does a routed posting apply? Only a Greenhouse, Lever or Ashby link with a token and a job id goes to the queue.
export function boardTarget(links) {
  for (const l of links) {
    const p = parseBoardUrl(l.url);
    if (p && graph().hosts.includes(p.ats) && p.token && p.jobId && /^[A-Za-z0-9._-]+$/.test(p.token)) return { ...p, url: hostedUrl(p) };
  }
  return null;
}

// Pure with respect to state: reads a snapshot, returns what to persist.
export async function planIngest({ obj, state, profile, overlay, fetch, now = Date.now() }) {
  const reason = validateIngest(obj);
  const need = obj && NEEDS.includes(obj.need) ? obj.need : 'unknown';
  const plan = { need, held: [], jobs: [], applyYourself: [], posts: [], dropped: 0, closed: 0, cost: obj && obj.cost !== undefined ? String(typeof obj.cost === 'object' ? JSON.stringify(obj.cost) : obj.cost).slice(0, 80) : null };
  if (reason) {
    plan.held.push({ reason: 'source_empty', detail: `routed:${need}: ${reason}` });
    return plan;
  }
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
  const seenLinks = new Set((state.applyYourself || []).flatMap((a) => a.links.map((l) => l.url)));
  for (const p of obj.postings) {
    const asJob = { title: p.title, company: p.employer, city: p.city, region: p.region, country: p.country, remote: p.remote, posted: p.postedAt, type: p.employmentType, salary: salaryText(p.salary), desc: p.description };
    const screen = screenJob(asJob, eff, overlay, now);
    if (screen.drop.length) {
      plan.dropped++;
      continue;
    }
    const t = boardTarget(p.applyLinks);
    if (!t) {
      const links = p.applyLinks.length ? p.applyLinks : [{ url: p.sourceUrl, publisher: '' }];
      if (links.some((l) => seenLinks.has(l.url))) continue;
      links.forEach((l) => seenLinks.add(l.url));
      plan.applyYourself.push({ title: p.title, employer: p.employer, links, sourceUrl: p.sourceUrl, warnings: screen.warnings });
      continue;
    }
    const b = await getBoard(t);
    if (!b.ok) {
      const d = `routed:job_postings: board ${t.ats}:${t.token} unavailable (${b.reason})`;
      if (!plan.held.some((h) => h.detail === d)) plan.held.push({ reason: 'source_empty', detail: d });
      continue;
    }
    const live = b.jobs.find((j) => j.sourceId === String(t.jobId));
    if (!live) {
      plan.closed++; // absent from the board list means closed
      continue;
    }
    plan.jobs.push({ ...live, company: live.company && live.company !== t.token ? live.company : p.employer, salary: live.salary || salaryText(p.salary), posted: live.posted || p.postedAt, warnings: screen.warnings, via: 'routed' });
  }
  return plan;
}

export function persistIngest(plan, now = Date.now()) {
  const at = new Date(now).toISOString();
  return updateState((state) => {
    const added = mergeJobs(state, plan.jobs, at);
    state.applyYourself = [...(state.applyYourself || []), ...plan.applyYourself];
    state.posts = [...(state.posts || []), ...plan.posts];
    state.held = [...state.held.filter((h) => !String(h.detail).startsWith(`routed:${plan.need}`)), ...plan.held];
    state.routed = { ...(state.routed || {}), skipReason: null, lastSearchAt: at, lastCost: plan.cost || (state.routed || {}).lastCost || null };
    return { added: added.length, applyYourself: plan.applyYourself.length, posts: plan.posts.length, closedOnBoard: plan.closed, dropped: plan.dropped, held: plan.held.map((h) => h.detail) };
  });
}

export async function ingest(args) {
  return persistIngest(await planIngest(args), args.now);
}

export { normalizeUrl };
