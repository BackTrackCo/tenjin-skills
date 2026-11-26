import { graph } from '../../../loop-base/lib/graph.mjs';
import { boardTarget, fetchBoard } from './boards.mjs';
import { employerName } from './employer.mjs';
import { companyNames, nameMatches } from './company.mjs';
import { applyOp, bump, normLabel } from './store.mjs';
import { careersFromLinks, classifyLinks, probeBoards, resolveFromCareersPage } from './employer.mjs';
import { HN_SITE, isNeverAutomated, isYc, linkedinOf, siteLinksOf } from './platforms.mjs';
import { parseBoardUrl } from './boards.mjs';
import { mergeJobs, normalizeUrl, sha } from './dedupe.mjs';
import { effectiveProfile } from './overlay.mjs';
import { catchUpDays } from './sweep.mjs';
import { screenJob } from './verify.mjs';
import { loadState, updateState } from './store.mjs';
import { flattenRaw } from './websearch.mjs';
import { postLinks, boardLinksOf, emailsIn, handleOf } from './postinfo.mjs';

// The request tool's envelope status, copied exactly. Only a fulfilled result is clean. Every other word
// (unverified, running, needs_approval, needs_input, unpaid, failed, native) holds the source for this run.
// One status word for every need, model-written files included: the router envelope's word, `fulfilled`. Any other word
// holds the source, and the refusal names the word to write.
export const DELIVERED = ['fulfilled'];
const NEEDS = ['job_postings', 'x_hiring_posts', 'hn_hiring_posts', 'careers_page', 'web_search', 'people_search', 'company_lookup'];
const POSTING_NEEDS = ['job_postings', 'hn_hiring_posts'];
export const OUTCOMES = ['job', 'lead', 'not_hiring', 'no_fit'];
const isStr = (v) => typeof v === 'string' && v.trim() !== '';

// The skill's own shape, never a seller's raw body. Code never guesses a field.
export function validateIngest(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'not an object';
  const nulls = (name, list) => (Array.isArray(list) && list.some((x) => !x || typeof x !== 'object' || Array.isArray(x)) ? `${name} must hold objects only: rewrite the entry that is empty or not an object` : null);
  if (!NEEDS.includes(o.need)) return `need must be one of ${NEEDS.join(', ')}`;
  if (o.need === 'company_lookup') {
    if (!isStr(o.status) || !DELIVERED.includes(o.status)) return `status "${o.status}" is not a delivered result: write "fulfilled"`;
    if (!isStr(o.jobKey)) return 'company_lookup needs jobKey';
    for (const k of ['domain', 'name', 'legalName', 'linkedinUrl']) if (o[k] !== null && o[k] !== undefined && typeof o[k] !== 'string') return `${k} must be text or null`;
    return null;
  }
  if (o.need === 'people_search') {
    if (!isStr(o.status)) return 'status is missing';
    if (!DELIVERED.includes(o.status)) return `status "${o.status}" is not a delivered result: write "fulfilled" (any other word holds the source)`;
    if (!isStr(o.jobKey) || !Array.isArray(o.contacts)) return 'people_search needs jobKey and a contacts list (empty is a normal answer)';
    for (const c of o.contacts) if (!c || !isStr(c.name) || !isStr(c.sourceUrl) || !isStr(c.how) || !isStr(c.cares)) return 'a contact needs name, sourceUrl, how and cares';
    return null;
  }
  if (o.need === 'careers_page') {
    if (!isStr(o.status)) return 'status is missing';
    if (!DELIVERED.includes(o.status)) return `status "${o.status}" is not a delivered result: write "fulfilled" (any other word holds the source)`;
    if (!isStr(o.jobKey) || !/^https:\/\//.test(String(o.careersUrl || ''))) return 'careers_page needs jobKey and an https careersUrl';
    for (const k of ['boardLinks', 'otherLinks']) if (o[k] !== undefined && !(Array.isArray(o[k]) && o[k].every(isStr))) return `${k} must be a list of links`;
    if (o.signIn !== undefined && typeof o.signIn !== 'boolean') return 'signIn must be true or false';
    if (o.found !== undefined && typeof o.found !== 'boolean') return 'found must be true or false';
    if (o.linkedinUrl !== undefined && o.linkedinUrl !== null && !linkedinOf([o.linkedinUrl])) return 'linkedinUrl must be the job\'s own LinkedIn https link';
    if (o.listings !== undefined) {
      if (!Array.isArray(o.listings)) return 'listings must be a list of {title, url, city, remote}';
      for (const [i, l] of o.listings.entries()) {
        if (!l || !isStr(l.title) || !/^https:\/\//.test(String(l.url || ''))) return `listing ${i}: title and an https url are required`;
        if (l.city !== undefined && typeof l.city !== 'string') return `listing ${i}: city must be text`;
        if (l.remote !== undefined && typeof l.remote !== 'boolean') return `listing ${i}: remote must be true or false`;
      }
    }
    return null;
  }
  const q = o.query;
  if (!q || typeof q !== 'object' || !isStr(q.role) || typeof q.place !== 'string' || typeof q.remote !== 'boolean' || !(q.since === null || isStr(q.since))) return 'query needs role, place, remote and since';
  if (!isStr(o.status)) return 'status is missing';
  if (!DELIVERED.includes(o.status)) return `status "${o.status}" is not a delivered result: write "fulfilled" (any other word holds the source)`;
  if (o.need === 'web_search') {
    if (o.raw !== undefined) {
      if (!Array.isArray(o.raw) || !o.raw.every((q) => q && typeof q.query === 'string' && Array.isArray(q.results))) return 'raw must be a list of {query, results[]}';
      { const n = nulls('a raw query result list', o.raw.flatMap((q) => q.results)); if (n) return n; }
      o = normalizeWeb(o);
    }
    if (!Array.isArray(o.results)) return 'results must be a list';
    { const n = nulls('results', o.results); if (n) return n; }
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
  { const n = nulls(POSTING_NEEDS.includes(o.need) ? 'postings' : 'posts', list); if (n) return n; if (o.leads !== undefined) { const m = nulls('leads', o.leads); if (m) return m; } if (o.outcomes !== undefined) { const m = nulls('outcomes', o.outcomes); if (m) return m; } }
  const reviewed = Array.isArray(o.batch);
  if (!list.length && !reviewed) return 'the list is empty';
  if (reviewed) {
    if (!o.batch.every(isStr)) return 'batch must be a list of post links';
    if (!Array.isArray(o.outcomes)) return 'outcomes must be a list: every post in the batch needs one';
    for (const x of o.outcomes) if (!x || !isStr(x.url) || !OUTCOMES.includes(x.outcome)) return `each outcome needs a url and one of ${OUTCOMES.join(', ')}`;
    const seen = new Set();
    for (const x of o.outcomes) {
      if (seen.has(x.url)) return `post ${x.url} has two outcomes`;
      seen.add(x.url);
    }
    const missing = o.batch.filter((u) => !seen.has(u));
    if (missing.length) return `no outcome for ${missing.length} post${missing.length > 1 ? 's' : ''} (${missing[0]}${missing.length > 1 ? ', ...' : ''}); the posts stay in the queue`;
    if (o.leads !== undefined && !Array.isArray(o.leads)) return 'leads must be a list';
  }
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
      if (Array.isArray(p.applyLinks) && p.applyLinks.some((l) => l && isStr(l.url) && !/^https?:\/\//i.test(l.url))) return `${at}: every apply link must start with http:// or https://`;
      if (!Array.isArray(p.applyLinks) || p.applyLinks.some((l) => !l || !isStr(l.url) || typeof l.publisher !== 'string')) return `${at}: applyLinks must be a list of {url, publisher}`;
      if (typeof p.description !== 'string' || p.description.length > 2000) return `${at}: description must be text of at most 2,000 characters`;
      if (!isStr(p.sourceUrl)) return `${at}: sourceUrl is required`;
    } else {
      if (!isStr(p.url) || typeof p.author !== 'string' || typeof p.text !== 'string' || !(p.postedAt === null || isStr(p.postedAt))) return `${at}: url, author, postedAt and text are required`;
      if (p.links !== undefined && !(Array.isArray(p.links) && p.links.every(isStr))) return `${at}: links must be a list of links`;
    }
  }
  return null;
}

// Raw results from the free web searches: code reads the URLs, drops repeats, keeps board links first, then X posts, then
// platform results. A result that is none of those and has no title and company from the model cannot be used and is dropped.
export function normalizeWeb(o) {
  if (!o || o.need !== 'web_search' || !Array.isArray(o.raw)) return o;
  const rank = (r) => { const k = resultKind(r.url); return k.board ? 0 : k.x ? 1 : 2; };
  const all = flattenRaw(o.raw);
  const usable = all.filter((r) => rank(r) < 2 || (isStr(r.title) && isStr(r.company)));
  return { ...o, results: usable.sort((a, b) => rank(a) - rank(b)), droppedRaw: all.length - usable.length };
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
export async function planIngest({ obj: given, state, profile, overlay, fetch, now = Date.now() }) {
  const obj = normalizeWeb(given);
  const reason = validateIngest(obj);
  const need = obj && NEEDS.includes(obj.need) ? obj.need : 'unknown';
  const plan = { need, held: [], jobs: [], unresolved: 0, careers: null, posts: [], dropped: (obj && obj.droppedRaw) || 0, closed: 0, cost: obj && obj.cost !== undefined ? String(typeof obj.cost === 'object' ? JSON.stringify(obj.cost) : obj.cost).slice(0, 80) : null };
  if (reason) {
    plan.held.push({ reason: 'source_empty', detail: `routed:${need}: ${reason}` });
    return plan;
  }
  if (need === 'careers_page') return planCareers({ obj, state, fetch, now, plan });
  if (need === 'people_search') return planPeople({ obj, state, plan, now });
  if (need === 'company_lookup') return planCompany({ obj, state, plan });
  if (need === 'x_hiring_posts') {
    const known = new Set((state.posts || []).map((p) => p.url));
    const seenAlready = (p) => known.has(p.url) || postSeen(state, p);
    // A post with a Greenhouse, Lever or Ashby link goes to the board check (the board API is the source of the job);
    // the others are kept for review, where a post with no posting can become a lead.
    const withBoard = obj.posts.filter((p) => postLinks(p).some((u) => resultKind(u).board));
    for (const p of obj.posts) if (!withBoard.includes(p) && !seenAlready(p)) plan.posts.push({ url: p.url, author: p.author, postedAt: p.postedAt, text: p.text.slice(0, 1000), status: 'new', source: 'x' });
    if (withBoard.length) {
      const sub = await planIngest({ obj: { ...obj, need: 'web_search', status: 'fulfilled', results: withBoard.flatMap((p) => postLinks(p).filter((u) => resultKind(u).board).map((url) => ({ url }))) }, state, profile, overlay, fetch, now });
      plan.jobs.push(...sub.jobs);
      plan.closed += sub.closed;
      plan.unresolved += sub.unresolved;
      plan.dropped += sub.dropped;
      plan.held.push(...sub.held.map((h) => ({ ...h, detail: h.detail.replace('routed:web_search', 'routed:x_hiring_posts') })));
    }
    return plan;
  }
  const eff = effectiveProfile(profile, overlay);
  // The routed window runs from the last routed search, never from the board sweep's clock; a window the person set holds.
  eff.windowDays = profile.windowDays || catchUpDays({ sweep: { lastAt: (state.routed || {}).lastSearchAt || null } }, now, 14);
  plan.round = obj.query && obj.query.round;
  const boards = new Map();
  const getBoard = async (t) => {
    const id = `${t.ats}:${t.token}`;
    if (!boards.has(id)) boards.set(id, await fetchBoard({ ats: t.ats, token: t.token, region: t.region || 'us', name: '' }, fetch));
    return boards.get(id);
  };
  if (Array.isArray(obj.batch)) {
    const r = planPosts({ obj, state, plan });
    if (r) {
      plan.outcomes = undefined; // a refused file records nothing: its posts stay in the queue
      plan.leads = undefined;
      plan.held.push({ reason: 'source_empty', detail: `routed:${need}: ${r}` });
      return plan;
    }
  }
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
    // A Hacker News post is dated from its own comment, so its age says nothing about the job: the board decides whether it is open.
    const tooOld = need !== 'hn_hiring_posts' && screen.drop.includes('outside_date_window');
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
      plan.jobs.push({ ...boardJob, siteLinks: siteLinksOf(p.applyLinks), openConfirmed: true, company: boardJob.company && boardJob.company !== ep.token ? boardJob.company : p.employer, salary: boardJob.salary || salaryText(p.salary), posted: boardJob.posted || p.postedAt, warnings: screen.warnings, via, employerPosting: ep, employerWebsite: p.employerWebsite || null, ...(p.employerWebsite ? { employerWebsiteSource: 'posting' } : {}), fromPost: p.sourceUrl });
      continue;
    }
    // Unresolved: kept as a job so review can run; it never reaches the apply queue without an exact or confirmed posting.
    const key = p.applyLinks.length ? p.applyLinks[0].url : p.sourceUrl;
    const yc = p.applyLinks.map((l) => l.url).find((u) => /workatastartup\.com/.test(u)) || p.applyLinks.map((l) => l.url).find(isYc) || null;
    plan.jobs.push({ url: key, ats: null, board: null, title: p.title, company: p.employer, city: p.city, region: p.region, country: p.country, remote: p.remote, posted: p.postedAt, type: p.employmentType, salary: salaryText(p.salary), desc: p.description, applyLinks: p.applyLinks.map((l) => l.url), siteLinks: siteLinksOf(p.applyLinks), place: `${p.city}|${p.region}`, warnings: [...screen.warnings, 'not confirmed open'], via, employerPosting: null, unresolved, fromPost: p.sourceUrl, otherSystem: cl.other, workAtStartupUrl: unresolved === 'yc_platform_only' ? yc : null, platformLinks: cl.platform, employerWebsite: p.employerWebsite || null, ...(p.employerWebsite ? { employerWebsiteSource: 'posting' } : {}), sourceUrl: p.sourceUrl, openConfirmed: false });
    plan.unresolved++;
  }
  return plan;
}

// Each post in a reviewed batch has one outcome. A lead needs its record: the X handle comes from the post record, an email
// or a handle in an HN comment only when it appears word for word in the comment. A post's text cannot steer an intro to
// someone else. Returns a reason when the file is refused (and then nothing is recorded).
function planPosts({ obj, state, plan }) {
  const posts = new Map((state.posts || []).map((p) => [p.url, p]));
  const leads = new Map((obj.leads || []).map((l) => [l.url, l]));
  plan.outcomes = [];
  plan.leads = [];
  for (const o of obj.outcomes) {
    if (!posts.has(o.url)) return `outcome for a post that is not in the queue: ${o.url}`;
    if (o.outcome === 'job' && !(obj.postings || []).some((p) => p.sourceUrl === o.url)) return `post ${o.url} is marked job but has no posting with that sourceUrl`;
    if (o.outcome === 'lead') {
      const post = posts.get(o.url);
      // The handle and the email are read by code from the post's own record and text; the model's record is optional.
      const emails = emailsIn(post.text || '');
      const l = leads.get(o.url) || (post.source === 'x' || /^https?:\/\/(x|twitter)\.com\//i.test(o.url) || emails.length === 1 ? { url: o.url, ...(emails.length === 1 ? { email: emails[0] } : {}) } : null);
      if (!l) return `post ${o.url} is marked lead but has no lead record`;
      const text = post.text || '';
      const handle = l.handle ? String(l.handle).replace(/^@/, '') : null;
      let channel = null;
      const isX = post.source === 'x' || /^https?:\/\/(x|twitter)\.com\//i.test(o.url);
      if (isX) {
        if (!post.author) return `post ${o.url} has no author in its record`;
        // An address published word for word in an X post counts like one in an HN comment; with a handle and an address
        // both, the channel is email, and the report still shows the DM link next to it with no second draft.
        if (l.email && !emailsIn(text).includes(l.email)) return `lead ${o.url}: the email is not word for word in the post`;
        channel = l.email ? 'email' : 'x';
        if (handle && handle.toLowerCase() !== String(post.author).replace(/^@/, '').toLowerCase()) return `lead ${o.url}: the handle must be the post's author from the record`;
      } else if (l.email || handle) {
        if (l.email && !emailsIn(text).includes(l.email)) return `lead ${o.url}: the email is not word for word in the post`;
        if (!l.email && handle && !text.includes(handle)) return `lead ${o.url}: the handle is not word for word in the post`;
        channel = l.email ? 'email' : 'other';
      } else return `lead ${o.url}: an HN comment needs an email or a handle that appears in it`;
      plan.leads.push({ url: o.url, key: leadKey(o.url), source: isX ? 'x' : 'hn', channel, author: post.author || '', handle: isX ? String(post.author).replace(/^@/, '') : handle, email: l.email || null, emailFromPost: Boolean(l.email) && emailsIn(text).includes(l.email), employer: o.employer || l.employer || '', role: o.role || l.role || '', place: o.place || l.place || '', excerpt: text.slice(0, 280), status: 'new', foundAt: new Date().toISOString(), intro: null, joinedJob: null });
    }
    plan.outcomes.push({ url: o.url, outcome: o.outcome, reason: o.reason || null });
  }
  return null;
}

// A post that left the queue is remembered by its text: it comes back only when its text changes.
const postHash = (p) => sha(String(p.text || '')).slice(0, 12);
export const postSeen = (state, p) => Boolean(state.postsDone && state.postsDone[p.url] && state.postsDone[p.url] === postHash(p));

// One lead per post: x.com and twitter.com links normalize to the status id, HN to the item id.
export function leadKey(url) {
  const m = /(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i.exec(url);
  if (m) return `x:${m[1]}`;
  return /^hn:/.test(url) ? url : normalizeUrl(url);
}

// A web search result becomes a posting, a post for review, or nothing. A board link is read from the board's own API
// (the result's title and place are not trusted over it). A platform result is used only from the result itself.
async function webPostings(results, getBoard, state) {
  const out = { postings: [], posts: [], closed: 0, held: [] };
  const known = new Set((state.posts || []).map((p) => p.url));
  for (const r of results) {
    const k = resultKind(r.url);
    if (k.x) {
      if (!known.has(r.url) && !postSeen(state, { url: r.url, text: String(r.snippet || r.title || '').slice(0, 1000) })) {
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

// The router's people search for one job: a normal empty answer is not an error. Each person is a likely contact, marked
// not confirmed, stored as a contact on the job; the intro comes from the writer call.
// The company lookup: the domain is saved as the job's employer website only after code checks it against the company name and the
// board's company name. A domain that does not match is not saved, and the people search then runs by name and city.
function planCompany({ obj, state, plan }) {
  const job = Object.hasOwn(state.jobs, obj.jobKey) ? state.jobs[obj.jobKey] : undefined;
  if (!job) {
    plan.held.push({ reason: 'source_empty', detail: `routed:company_lookup: unknown job ${obj.jobKey}` });
    return plan;
  }
  // The tool returns its best match for the name: the domain is trusted only when the company's name or legal name matches the job's
  // company name or the board's company name. The registered address is never read as the job's city.
  const names = companyNames(job);
  const matches = [obj.name, obj.legalName].some((n) => n && names.some((m) => nameMatches(m, n)));
  const ok = Boolean(obj.domain) && matches && !isNeverAutomated(`https://${obj.domain}`);
  plan.company = { key: obj.jobKey, website: ok ? obj.domain : null, rejected: obj.domain && !ok ? obj.domain : null, linkedinUrl: ok ? obj.linkedinUrl || null : null };
  return plan;
}

function planPeople({ obj, state, plan }) {
  if (!Object.hasOwn(state.jobs, obj.jobKey)) {
    plan.held.push({ reason: 'source_empty', detail: `routed:people_search: unknown job ${obj.jobKey}` });
    return plan;
  }
  plan.people = { key: obj.jobKey, contacts: obj.contacts, found: obj.found, outside: obj.outside || 0, city: obj.city || '' };
  return plan;
}

// Step 3: a Haiku step read the employer's careers page and returned its links. Code fetches nothing from that page;
// it runs the ownership and job checks through the board APIs only.
async function planCareers({ obj, state, fetch, now, plan }) {
  const job = Object.hasOwn(state.jobs, obj.jobKey) ? state.jobs[obj.jobKey] : undefined;
  if (!job) {
    plan.held.push({ reason: 'source_empty', detail: `routed:careers_page: unknown job ${obj.jobKey}` });
    return plan;
  }
  if (obj.careersPageOnly) {
    // The router found the employer's page but not what it lists: the page's address is kept, and the employer_page item
    // has the model read the listings (the open check goes through that page).
    plan.careers = { key: obj.jobKey, pageOnly: obj.careersUrl, result: { reason: 'careers_page_found' } };
    return plan;
  }
  const page = careersFromLinks({ boardLinks: obj.boardLinks || [], otherLinks: obj.otherLinks || [], signIn: obj.signIn === true, listings: obj.listings || [], careersUrl: obj.careersUrl });
  const posting = { title: job.title, employer: job.company, city: job.city, remote: job.remote, postedAt: job.posted };
  const r = await resolveFromCareersPage(posting, page, { fetch, now, website: job.employerWebsite });
  // A job already confirmed from the careers page stays open while the page lists it; a page that lists jobs and no longer
  // lists this one closes it (the re-verify).
  const reverify = Boolean(job.employerPosting && !job.employerPosting.token && job.employerPosting.source === 'careers_page');
  plan.careers = { key: obj.jobKey, linkedinUrl: linkedinOf([obj.linkedinUrl]), closed: reverify && !r.match && page.kind === 'listing' && r.reason === 'no_match', reverify, result: r.match ? { employerPosting: r.match.employerPosting, job: r.match.job } : { reason: r.reason, other: r.other || null } };
  return plan;
}

// A lead whose employer and role later match exactly one job (the board probes' rule) joins that job, with its intro.
export function joinLeads(state) {
  for (const l of state.leads || []) {
    if (l.joinedJob || !l.employer || !l.role || ['done', 'not_interested'].includes(l.status)) continue;
    const hits = Object.values(state.jobs).filter((j) => employerName(j.company) === employerName(l.employer) && normLabel(j.title) === normLabel(l.role) && (!l.place || /remote/i.test(l.place) && j.remote || normLabel(j.city || '') === normLabel(String(l.place).split(',')[0])));
    if (hits.length !== 1) continue;
    (state.contacts[hits[0].key] ||= []).push({ ...(l.channel === 'email' && l.emailFromPost ? { email: l.email, emailFromPost: true } : {}), name: l.author || l.handle || 'the poster', title: '', sourceUrl: l.url, how: l.channel === 'email' ? l.email : `DM @${l.handle} on X`, cares: `hiring for ${l.role}`, channel: l.channel, notConfirmed: false, intro: l.intro });
    l.joinedJob = hits[0].key;
  }
}

export function persistIngest(plan, now = Date.now()) {
  const at = new Date(now).toISOString();
  return updateState((state) => {
    const added = mergeJobs(state, plan.jobs, at);
    if (plan.company) {
      const cj = state.jobs[plan.company.key];
      if (plan.company.website) {
        cj.employerWebsite = plan.company.website;
        cj.employerWebsiteSource = 'company_lookup';
        if (plan.company.linkedinUrl) cj.companyLinkedinUrl = plan.company.linkedinUrl;
      }
      cj.companyLookedUp = at;
    }
    if (plan.people) {
      const job = state.jobs[plan.people.key];
      for (const c of plan.people.contacts) {
        if ((state.contacts[job.key] || []).some((x) => x.sourceUrl === c.sourceUrl)) continue;
        try {
          applyOp(state, { op: 'contact', key: job.key, ...c });
        } catch {} // a contact the rules refuse is simply not stored
      }
      job.contactsSearched = at;
      job.contactsStatus = { state: 'searched', found: plan.people.found === undefined ? plan.people.contacts.length : plan.people.found, kept: plan.people.contacts.length, outside: plan.people.outside, city: plan.people.city, at };
      state.contactsRequested = (state.contactsRequested || []).filter((k) => k !== job.key);
    }
    for (const pj of plan.jobs) authorContact(state, pj, plan);
    if (plan.careers && plan.careers.pageOnly) {
      const j = state.jobs[plan.careers.key];
      j.careersUrl = plan.careers.pageOnly;
      bump(j);
    } else if (plan.careers) {
      const j = state.jobs[plan.careers.key];
      const r = plan.careers.result;
      j.careersChecked = true;
      if (plan.careers.linkedinUrl) j.siteLinks = siteLinksOf([...(j.siteLinks || []).map((x) => x.url), plan.careers.linkedinUrl]);
      bump(j); // the careers-page result is news about this job
      if (plan.careers.closed) {
        j.status = 'closed';
        j.statusAt = at;
        j.openConfirmed = false;
      } else if (r.employerPosting) {
        j.employerPosting = r.employerPosting;
        j.unresolved = null;
        j.ats = r.employerPosting.system;
        j.board = r.employerPosting.token ? `${r.employerPosting.system}:${r.employerPosting.token}` : null;
        j.sourceId = r.employerPosting.jobId;
        j.applyLinks = [r.employerPosting.url];
        j.openConfirmed = true;
        j.verifiedAt = at;
        j.warnings = (j.warnings || []).filter((w) => w !== 'not confirmed open');
      } else if (plan.careers.reverify) {
        // the page could not be read this time (a sign-in, no listings): nothing changes about an open job
      } else {
        j.unresolved = r.reason;
        j.otherSystem = r.other || j.otherSystem || null;
      }
    }
    state.posts = [...(state.posts || []), ...plan.posts];
    if (plan.outcomes) {
      // the batch is done: its posts leave the queue, each counted by outcome; leads join the list, once per post
      const done = new Set(plan.outcomes.map((o) => o.url));
      for (const p of state.posts) if (done.has(p.url)) (state.postsDone ||= {})[p.url] = postHash(p);
      state.posts = state.posts.filter((p) => !done.has(p.url));
      for (const o of plan.outcomes) {
        (state.postOutcomes ||= {})[o.outcome] = (state.postOutcomes[o.outcome] || 0) + 1;
        if (o.reason && o.outcome === 'not_hiring') (state.postReasons ||= {})[o.reason] = (state.postReasons[o.reason] || 0) + 1;
      }
      for (const l of plan.leads) if (!(state.leads || []).some((x) => x.key === l.key)) (state.leads ||= []).push(l);
      joinLeads(state);
    }
    if (plan.round !== undefined) {
      if (!state.search.session || (state.search.session.finished && plan.round === 0)) state.search.session = { startedAt: at, round: plan.round, roundAdded: 0, finished: false };
      if (plan.round === state.search.session.round) state.search.session.roundAdded += added.length;
    }
    state.held = [...state.held.filter((h) => !String(h.detail).startsWith(`routed:${plan.need}`)), ...plan.held];
    state.routed = { ...(state.routed || {}), skipReason: null, lastSearchAt: plan.noClock || plan.need === 'people_search' ? (state.routed || {}).lastSearchAt || null : at, lastCost: plan.cost || (state.routed || {}).lastCost || null };
    return { added: added.length, contacts: plan.people ? plan.people.contacts.length : undefined, applyYourself: plan.unresolved, careers: plan.careers ? (plan.careers.result.reason || 'resolved') : undefined, posts: plan.posts.length, closedOnBoard: plan.closed, dropped: plan.dropped, held: plan.held.map((h) => h.detail) };
  });
}

export async function ingest(args) {
  return persistIngest(await planIngest(args), args.now);
}

export { boardTarget, normalizeUrl };

// The author of a post that led to a job is a contact, made in code from the post's own record: the X handle, or the one
// email that appears in the text. A contact the rules refuse is simply not stored.
function authorContact(state, pj, plan) {
  if (!pj.fromPost) return;
  const post = (state.posts || []).find((p) => p.url === pj.fromPost);
  if (!post) return;
  let key;
  try {
    key = normalizeUrl(pj.url);
  } catch {
    return;
  }
  const job = state.jobs[key];
  if (!job || (state.contacts[key] || []).some((c) => c.sourceUrl === post.url)) return;
  const handle = handleOf(post);
  const emails = emailsIn(post.text || '');
  if (isYc(post.url) && !post.author) return;
  // an address in the post, an X post's included, makes the contact an email one; the handle stays the DM link
  const email = emails.length === 1 ? emails[0] : null;
  const how = email || (handle ? `DM @${handle} on X` : null);
  if (!how) return;
  try {
    applyOp(state, { op: 'contact', key, name: post.author || handle || 'the poster', title: '', sourceUrl: isYc(post.url) ? `https://${HN_SITE}/user?id=${encodeURIComponent(post.author)}` : post.url, how, cares: `hiring for ${job.title}`, channel: email ? 'email' : 'x' });
    // set by code only, never by an op: the address appeared word for word in the poster's own post
    if (email) Object.assign(state.contacts[key][state.contacts[key].length - 1], { email, emailFromPost: true, ...(handle ? { handle } : {}) });
  } catch {}
}

// A hiring post with a Greenhouse, Lever or Ashby link becomes a posting in code, with no model step: the board API is
// the source of the job, and the post's author becomes its contact.
export async function resolveBoardPosts({ profile, overlay, fetch, now = Date.now() }) {
  const state = loadState();
  const found = (state.posts || []).filter((p) => p.status === 'new' && boardLinksOf(p).length);
  if (!found.length) return { resolved: 0 };
  const results = found.flatMap((p) => boardLinksOf(p).map((url) => ({ url })));
  const plan = await planIngest({ obj: { need: 'web_search', status: 'fulfilled', query: { role: 'post', place: '', remote: false, since: null }, results }, state, profile, overlay, fetch, now });
  if (plan.held.length) return { resolved: 0, held: plan.held.length }; // a board that did not answer: the posts stay queued
  plan.noClock = true;
  plan.outcomes = found.map((p) => ({ url: p.url, outcome: 'job', reason: null }));
  plan.leads = [];
  for (const j of plan.jobs) {
    const ep = j.employerPosting;
    const p = ep && found.find((x) => boardLinksOf(x).some((u) => { const t = boardTarget([{ url: u }]); return t && t.token === ep.token && String(t.jobId) === String(ep.jobId); }));
    if (p) j.fromPost = p.url;
  }
  persistIngest(plan, now);
  return { resolved: found.length, added: plan.jobs.length };
}
