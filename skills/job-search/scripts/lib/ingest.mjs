import { graph } from './graph.mjs';
import { boardTarget, fetchBoard } from './boards.mjs';
import { careersFromLinks, classifyLinks, probeBoards, resolveFromCareersPage } from './employer.mjs';
import { isNeverAutomated, isYc } from './platforms.mjs';
import { loadSkipUrls } from './careerops.mjs';
import { parseBoardUrl } from './boards.mjs';
import { mergeJobs, normalizeUrl } from './dedupe.mjs';
import { effectiveProfile } from './overlay.mjs';
import { catchUpDays } from './sweep.mjs';
import { screenJob } from './verify.mjs';
import { updateState } from './store.mjs';

// The request tool's envelope status, copied exactly. Only a fulfilled result is clean. Every other word
// (unverified, running, needs_approval, needs_input, unpaid, failed, native) holds the source for this run.
export const DELIVERED = ['fulfilled'];
const NEEDS = ['job_postings', 'x_hiring_posts', 'hn_hiring_posts', 'careers_page', 'web_search'];
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
    for (const k of ['boardLinks', 'otherLinks']) if (o[k] !== undefined && !(Array.isArray(o[k]) && o[k].every(isStr))) return `${k} must be a list of links`;
    if (o.signIn !== undefined && typeof o.signIn !== 'boolean') return 'signIn must be true or false';
    return null;
  }
  const q = o.query;
  if (!q || typeof q !== 'object' || !isStr(q.role) || typeof q.place !== 'string' || typeof q.remote !== 'boolean' || !(q.since === null || isStr(q.since))) return 'query needs role, place, remote and since';
  if (!isStr(o.status)) return 'status is missing';
  // A free web search has no router envelope: its status is the skill's own word `ok` (the native WebSearch returned
  // results), or the envelope word when Tenjin answered it through `request`. Every other need needs `fulfilled`.
  const delivered = o.need === 'web_search' ? [...DELIVERED, 'ok'] : DELIVERED;
  if (!delivered.includes(o.status)) return `status "${o.status}" is not a delivered result (${delivered.join(' or ')})`;
  if (o.need === 'web_search') {
    if (!Array.isArray(o.results)) return 'results must be a list';
    if (!o.results.length) return 'the list is empty';
    for (const [i, r] of o.results.entries()) {
      const at = `result ${i}`;
      if (!r || !isStr(r.url) || !/^https?:\/\//.test(r.url)) return `${at}: url is required`;
      for (const k of ['title', 'company', 'city', 'region', 'country', 'snippet', 'author']) if (r[k] !== undefined && typeof r[k] !== 'string') return `${at}: ${k} must be text`;
      if (r.remote !== undefined && typeof r.remote !== 'boolean') return `${at}: remote must be true or false`;
      if (r.postedAt !== undefined && r.postedAt !== null && (!isStr(r.postedAt) || Number.isNaN(Date.parse(r.postedAt)))) return `${at}: postedAt must be a date or null`;
      if (!resultKind(r.url).board && !resultKind(r.url).x && !(isStr(r.title) && isStr(r.company))) return `${at}: a result that is not a board link or an X post needs title and company`;
    }
    return null;
  }
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

// A web search result is one of three things, decided by its URL alone: a board link, an X post, or the rest.
// A platform result (LinkedIn, Indeed and similar) is used only from the search result and never fetched.
export function resultKind(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {}
  const board = boardTarget([{ url }]);
  return { board, x: /(^|\.)(x|twitter)\.com$/.test(host), platform: isNeverAutomated(url) };
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
  plan.round = obj.query && obj.query.round;
  const skip = loadSkipUrls(profile);
  const boards = new Map();
  const getBoard = async (t) => {
    const id = `${t.ats}:${t.token}`;
    if (!boards.has(id)) boards.set(id, await fetchBoard({ ats: t.ats, token: t.token, region: t.region || 'us', name: '' }, fetch));
    return boards.get(id);
  };
  const via = need === 'hn_hiring_posts' ? 'hn' : need === 'web_search' ? 'web' : 'routed';
  let postings = obj.postings || [];
  if (need === 'web_search') {
    const w = await webPostings(obj.results, getBoard, state);
    postings = w.postings;
    plan.posts.push(...w.posts);
    plan.closed += w.closed;
    for (const d of w.held) if (!plan.held.some((h) => h.detail === d)) plan.held.push({ reason: 'source_empty', detail: `routed:web_search: ${d}` });
  }
  for (const p of postings) {
    const asJob = { title: p.title, company: p.employer, city: p.city, region: p.region, country: p.country, remote: p.remote, posted: p.postedAt, type: p.employmentType, salary: salaryText(p.salary), desc: p.description };
    const screen = screenJob(asJob, eff, overlay, now);
    // A routed posting older than the window stays only when its board confirms that it is open.
    const tooOld = screen.drop.includes('outside_date_window');
    if (screen.drop.filter((d) => d !== 'outside_date_window').length) {
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
    if (tooOld && !ep) {
      plan.dropped++; // too old, and no board confirms that it is open
      continue;
    }
    if (tooOld) screen.warnings.push(`posted ${String(p.postedAt).slice(0, 10)}, still open`);
    if (ep) {
      plan.jobs.push({ ...boardJob, openConfirmed: true, company: boardJob.company && boardJob.company !== ep.token ? boardJob.company : p.employer, salary: boardJob.salary || salaryText(p.salary), posted: boardJob.posted || p.postedAt, warnings: screen.warnings, via, employerPosting: ep, employerWebsite: p.employerWebsite || null });
      continue;
    }
    // Unresolved: kept as a job so review can run; it never reaches the apply queue without an exact or confirmed posting.
    const key = p.applyLinks.length ? p.applyLinks[0].url : p.sourceUrl;
    const yc = p.applyLinks.map((l) => l.url).find((u) => /workatastartup\.com/.test(u)) || p.applyLinks.map((l) => l.url).find(isYc) || null;
    plan.jobs.push({ url: key, ats: null, board: null, title: p.title, company: p.employer, city: p.city, region: p.region, country: p.country, remote: p.remote, posted: p.postedAt, type: p.employmentType, salary: salaryText(p.salary), desc: p.description, applyLinks: p.applyLinks.map((l) => l.url), place: `${p.city}|${p.region}`, warnings: [...screen.warnings, 'not confirmed open'], via, employerPosting: null, unresolved, otherSystem: cl.other, workAtStartupUrl: unresolved === 'yc_platform_only' ? yc : null, platformLinks: cl.platform, employerWebsite: p.employerWebsite || null, sourceUrl: p.sourceUrl, openConfirmed: false });
    plan.unresolved++;
  }
  // a job the person's career-ops folder already has is not added again
  plan.jobs = plan.jobs.filter((j) => !skip.has(j.url) && !(j.employerPosting && skip.has(j.employerPosting.url)));
  return plan;
}

// A web search result becomes a posting, a post for review, or nothing. A board link is read from the board's own API
// (the result's title and place are not trusted over it). A platform result is used only from the result itself.
async function webPostings(results, getBoard, state) {
  const out = { postings: [], posts: [], closed: 0, held: [] };
  const known = new Set((state.posts || []).map((p) => p.url));
  for (const r of results) {
    const k = resultKind(r.url);
    if (k.x) {
      if (!known.has(r.url)) {
        known.add(r.url);
        out.posts.push({ url: r.url, author: r.author || '', postedAt: r.postedAt || null, text: String(r.snippet || r.title || '').slice(0, 1000), status: 'new', source: 'x' });
      }
      continue;
    }
    if (k.board) {
      const b = await getBoard(k.board);
      if (!b.ok) {
        out.held.push(`board ${k.board.ats}:${k.board.token} unavailable (${b.reason})`);
        continue;
      }
      const j = b.jobs.find((x) => x.sourceId === String(k.board.jobId));
      if (!j) {
        out.closed++;
        continue;
      }
      out.postings.push({ title: j.title, employer: j.company, city: j.city, region: j.region, country: j.country, remote: j.remote, postedAt: j.posted, employmentType: j.type || '', salary: null, applyLinks: [{ url: k.board.url, publisher: k.board.ats }], description: j.desc || '', sourceUrl: r.url, __fromBoard: true });
      continue;
    }
    // everything else, a LinkedIn or Indeed result included, is used from the search result only
    out.postings.push({ title: r.title, employer: r.company, city: r.city || '', region: r.region || '', country: r.country || '', remote: r.remote === true, postedAt: r.postedAt || null, employmentType: '', salary: null, applyLinks: k.platform ? [] : [{ url: r.url, publisher: '' }], description: String(r.snippet || '').slice(0, 2000), sourceUrl: r.url, employerWebsite: undefined });
  }
  return out;
}

// Step 3: a Haiku step read the employer's careers page and returned its links. Code fetches nothing from that page;
// it runs the ownership and job checks through the board APIs only.
async function planCareers({ obj, state, fetch, now, plan }) {
  const job = state.jobs[obj.jobKey];
  if (!job) {
    plan.held.push({ reason: 'source_empty', detail: `routed:careers_page: unknown job ${obj.jobKey}` });
    return plan;
  }
  const page = careersFromLinks({ boardLinks: obj.boardLinks || [], otherLinks: obj.otherLinks || [], signIn: obj.signIn === true });
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
        j.openConfirmed = true;
        j.warnings = (j.warnings || []).filter((w) => w !== 'not confirmed open');
      } else {
        j.unresolved = r.reason;
        j.otherSystem = r.other || j.otherSystem || null;
      }
    }
    state.posts = [...(state.posts || []), ...plan.posts];
    if (plan.round !== undefined) {
      if (!state.search.session || (state.search.session.finished && plan.round === 0)) state.search.session = { startedAt: at, round: plan.round, roundAdded: 0, finished: false };
      if (plan.round === state.search.session.round) state.search.session.roundAdded += added.length;
    }
    state.held = [...state.held.filter((h) => !String(h.detail).startsWith(`routed:${plan.need}`)), ...plan.held];
    state.routed = { ...(state.routed || {}), skipReason: null, lastSearchAt: at, lastCost: plan.cost || (state.routed || {}).lastCost || null };
    return { added: added.length, applyYourself: plan.unresolved, careers: plan.careers ? (plan.careers.result.reason || 'resolved') : undefined, posts: plan.posts.length, closedOnBoard: plan.closed, dropped: plan.dropped, held: plan.held.map((h) => h.detail) };
  });
}

export async function ingest(args) {
  return persistIngest(await planIngest(args), args.now);
}

export { boardTarget, normalizeUrl };
