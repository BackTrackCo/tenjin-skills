import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR } from './paths.mjs';
import { DISCUSSION_HOSTS } from './queries.mjs';

// The one reader of a service's answer, and the one builder of its input. Both take a MAPPING: plain data that says where each
// field the loop needs sits in the answer, and how the loop's own inputs fill the service's input fields. A mapping is never code.
// Today's services ship as default mappings (scripts/lib/suppliers/defaults.json); a person's repaired ones sit in the state folder.
// When no mapping fits, a generic reader tries the usual names (reads.json); when that fails the check, the caller holds the need and
// writes one repair request (repairs.mjs).
let READS;
export const reads = () => (READS ||= JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'reads.json'), 'utf8')));
export const kindOf = (kind) => reads().needs[kind] || null;

// ---- paths -----------------------------------------------------------------------------------------------------------------
// a.b[].c[0].d : `[]` takes every element and flattens, `[0]` one element. Only own keys are read.
const TOK = /([^.[\]]+)|\[(\d*)\]/g;
export const SAFE_PATH = /^[A-Za-z0-9_$.[\]-]{0,200}$/;
const BAD_KEY = new Set(['__proto__', 'prototype', 'constructor']);
export function getPath(root, p) {
  if (p === '' || p === undefined || p === null) return root;
  let cur = [root];
  let many = false;
  for (const m of String(p).matchAll(TOK)) {
    const next = [];
    for (const c of cur) {
      if (m[1] !== undefined) {
        if (!BAD_KEY.has(m[1]) && c && typeof c === 'object' && !Array.isArray(c) && Object.hasOwn(c, m[1])) next.push(c[m[1]]);
      } else if (Array.isArray(c)) {
        if (m[2] === '') { many = true; next.push(...c); } else if (c[Number(m[2])] !== undefined) next.push(c[Number(m[2])]);
      }
    }
    cur = next;
  }
  return many ? cur : cur[0];
}

// ---- values ----------------------------------------------------------------------------------------------------------------
export const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const URL_RE = /https:\/\/[^\s<>"')\]]+/g;
export const linksOf = (text) => [...new Set((str(text).match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, '')))];
export const isoOf = (v) => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return null;
  const d = Date.parse(s);
  return Number.isNaN(d) ? null : new Date(d).toISOString();
};
export const bareDomain = (v) => str(v).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0].toLowerCase();
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const flat = (v) => (Array.isArray(v) ? v.flatMap(flat) : [v]);
function coerce(type, v, ctx = {}) {
  if (v === undefined || v === null) return '';
  switch (type) {
    case 'url': {
      const s = str(Array.isArray(v) ? v[0] : v);
      if (/^https?:\/\//i.test(s)) return s;
      return s.startsWith('/') && ctx.urlBase ? `${String(ctx.urlBase).replace(/\/+$/, '')}${s}` : '';
    }
    case 'text': return flat(v).map(str).filter(Boolean).join(' ');
    case 'date': return isoOf(Array.isArray(v) ? v[0] : v) || '';
    case 'urls': return [...new Set(flat(v).map(str).filter((s) => /^https:\/\//i.test(s)))];
    case 'domain': return bareDomain(Array.isArray(v) ? v[0] : v);
    case 'email': return str(Array.isArray(v) ? v[0] : v).toLowerCase();
    default: return str(Array.isArray(v) ? v[0] : v);
  }
}
const empty = (v) => v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length);

// One field of one record. A spec is a path, a list of paths (the first with a value wins) or {join: [path or [paths]], sep}.
function fieldOf(rec, spec, type, ctx) {
  if (spec === undefined || spec === null) return type === 'urls' ? [] : '';
  const one = (p) => coerce(type, getPath(rec, p), ctx);
  const first = (ps) => { for (const p of [].concat(ps)) { const v = one(p); if (!empty(v)) return v; } return type === 'urls' ? [] : ''; };
  if (typeof spec === 'object' && !Array.isArray(spec)) {
    const parts = (spec.join || []).map((p) => first(p)).filter((x) => !empty(x));
    return parts.join(typeof spec.sep === 'string' ? spec.sep : '\n');
  }
  return first(spec);
}

// ---- reading with a mapping ------------------------------------------------------------------------------------------------
const foundFalse = (res) => Boolean(res && typeof res === 'object' && ((res.output && res.output.found === false) || res.found === false));
const asList = (res, paths) => { for (const p of [].concat(paths || [])) { const v = getPath(res, p); if (Array.isArray(v)) return v; } return null; };
const asRoot = (res, paths) => { for (const p of [].concat(paths === undefined ? [''] : paths)) { const v = getPath(res, p); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } return null; };

// Reads `result` with the mapping's `output`. Returns {ok, rows|row, dropped, reason, notFound}. `rows` hold the fields by the loop's own names.
export function readWith(kind, output, result) {
  const k = kindOf(kind);
  const types = reads().types;
  const ctx = { urlBase: output.urlBase };
  if (!k) return { ok: false, reason: `unknown need ${kind}` };
  if (k.shape === 'object') {
    if (foundFalse(result)) return { ok: false, notFound: true, reason: 'the service says it found nothing' };
    const root = asRoot(result, output.root);
    if (!root) return { ok: false, reason: 'no answer object at the mapped place' };
    const row = {};
    for (const f of k.fields) row[f] = fieldOf(root, (output.fields || {})[f], types[f] || 'string', ctx);
    const lf = output.linksFromText;
    if (lf && row.links !== undefined) row.links = [...new Set([...row.links, ...linksOf(row[lf === true ? 'text' : lf])])];
    if (kind === 'person_enrichment' && !empty(row.email) && !EMAIL.test(row.email)) return { ok: false, reason: 'the email field holds something that is not an address' };
    const miss = k.requiredAny.length && k.requiredAny.every((f) => empty(row[f]));
    return miss ? { ok: false, reason: `none of ${k.requiredAny.join(', ')} was found` } : { ok: true, row };
  }
  if (foundFalse(result)) return { ok: true, rows: [], dropped: 0, empty: true };
  const list = asList(result, output.list);
  if (!list) return { ok: false, reason: 'no list of items at the mapped place' };
  const rows = [];
  let dropped = 0;
  for (const raw of list) {
    let item = raw;
    if (output.itemRoot && item && typeof item === 'object' && item[output.itemRoot] && typeof item[output.itemRoot] === 'object') item = item[output.itemRoot];
    const row = {};
    for (const f of k.fields) row[f] = fieldOf(item, (output.fields || {})[f], types[f] || 'string', ctx);
    if (output.linksFromText !== false && row.links !== undefined) row.links = [...new Set([...row.links, ...linksOf(row.text)])];
    if (k.required.every((f) => !empty(row[f]))) rows.push(row); else dropped += 1;
  }
  const share = list.length ? rows.length / list.length : 1;
  if (list.length && share < (k.minShare || reads().minShare)) return { ok: false, reason: `only ${rows.length} of ${list.length} items have ${k.required.join(' and ')}` };
  return { ok: true, rows, dropped, empty: !list.length };
}

// ---- the generic reader ----------------------------------------------------------------------------------------------------
// No mapping, no seller: the shallowest list of objects whose items carry a link and a text, or the shallow fields of one object, by
// the usual names in reads.json. The result is a mapping, so a repair can start from it, and the same check decides.
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
function leaves(v, depth, pre, out, max = 3) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (depth >= max) return out;
    for (const [k, x] of Object.entries(v)) { if (!BAD_KEY.has(k)) leaves(x, depth + 1, pre ? `${pre}.${k}` : k, out, max); }
  } else if (v !== undefined && v !== null && !(Array.isArray(v) && v.length && typeof v[0] === 'object')) out.push({ path: pre, depth, last: pre.split('.').pop() });
  return out;
}
function pickPath(sample, names, type, ctx) {
  const all = sample.flatMap((item) => leaves(item, 0, '', []));
  for (const n of names) {
    const hits = [...new Set(all.filter((l) => norm(l.last) === norm(n) || norm(l.path) === norm(n)).sort((a, b) => a.depth - b.depth).map((l) => l.path))];
    for (const p of hits) { const have = sample.filter((i) => !empty(coerce(type, getPath(i, p), ctx))).length; if (have * 2 >= sample.length) return p; }
  }
  return null;
}
function arraysIn(v, depth, pre, out) {
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === 'object' && v[0] && !Array.isArray(v[0])) out.push({ path: pre, depth, n: v.length });
    return out;
  }
  if (v && typeof v === 'object' && depth < 5) for (const [k, x] of Object.entries(v)) { if (!BAD_KEY.has(k)) arraysIn(x, depth + 1, pre ? `${pre}.${k}` : k, out); }
  return out;
}
function inferFields(kind, sample) {
  const k = kindOf(kind);
  const { names, types } = reads();
  const fields = {};
  for (const f of k.fields) {
    if (f === 'links') continue;
    const p = f === 'text' ? null : pickPath(sample, names[f] || [f], types[f] || 'string', {});
    if (f === 'text') {
      const body = pickPath(sample, names.text, 'text', {});
      const title = pickPath(sample, ['title'], 'text', {});
      if (title && body && title !== body) fields.text = { join: [title, body] };
      else if (body || title) fields.text = body || title;
    } else if (p) fields[f] = p;
  }
  if (k.fields.includes('name') && !fields.name) {
    const a = pickPath(sample, names.firstName, 'string', {});
    const b = pickPath(sample, names.lastName, 'string', {});
    if (a && b) fields.name = { join: [a, b], sep: ' ' };
  }
  return fields;
}
export function genericRead(kind, result) {
  const k = kindOf(kind);
  if (!k) return null;
  if (k.shape === 'object') {
    for (const rootPath of ['', ...['data', 'result', 'output', 'output.data', 'user', 'organization', 'company', 'person'].filter((p) => asRoot(result, p))]) {
      const root = asRoot(result, rootPath);
      const fields = inferFields(kind, [root]);
      const output = { root: [rootPath], fields };
      const r = readWith(kind, output, result);
      if (r.ok) return { output, ...r };
    }
    return null;
  }
  if (foundFalse(result)) return { output: { list: [] }, ok: true, rows: [], dropped: 0, empty: true };
  const lists = Array.isArray(result) && result.length && typeof result[0] === 'object' ? [{ path: '', depth: 0, n: result.length }] : [];
  lists.push(...arraysIn(result, 0, '', []).sort((a, b) => a.depth - b.depth || b.n - a.n));
  for (const l of lists) {
    const arr = l.path === '' ? result : getPath(result, l.path);
    const sample = arr.slice(0, 8).filter((x) => x && typeof x === 'object');
    const fields = inferFields(kind, sample);
    const output = { list: [l.path], fields };
    const r = readWith(kind, output, result);
    if (r.ok && !r.empty) return { output, ...r };
  }
  return null;
}

// ---- shapes: the rows become what the rest of the loop already takes -----------------------------------------------------------
const SITE = (url) => (/^https?:\/\/([^/]+\.)?(x|twitter)\.com\//i.test(url) ? 'x' : /^https?:\/\/([^/]+\.)?reddit\.com\//i.test(url) ? 'reddit' : /^https?:\/\/([^/]+\.)?linkedin\.com\//i.test(url) ? 'linkedin' : /^https?:\/\/news\.ycombinator\.com\//i.test(url) ? 'hn' : 'web');
const slugOf = (u) => (/linkedin\.com\/in\/([^/?#\s]+)/i.exec(str(u)) || [])[1] || '';
const subOf = (url) => (/reddit\.com\/r\/([^/?#]+)/i.exec(String(url)) || [])[1]?.toLowerCase() || null;
const hostOf = (u) => { try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

export function shape(kind, read, fields = {}) {
  const k = kindOf(kind);
  if (k.shape === 'object') {
    const r = read.row;
    if (kind === 'x_profile') return { name: r.name || null, bio: r.bio, location: r.location, links: r.links };
    if (kind === 'linkedin_profile') return { name: r.name || null, headline: r.headline || null, location: r.location, company: r.company || null, about: r.about.slice(0, 500) };
    if (kind === 'company_profile') return { name: r.name || null, domain: r.domain || null, linkedinUrl: r.linkedinUrl || null, size: r.size || null, country: r.country || null };
    if (kind === 'person_enrichment') return { email: r.email || null, status: r.status ? r.status : null };
    return { status: r.status.toLowerCase() === 'valid' || r.status.toLowerCase() === 'deliverable' ? 'valid' : r.status.toLowerCase() };
  }
  if (k.out === 'companies') return { companies: read.rows.map((c) => ({ name: c.name, domain: c.domain, linkedinUrl: c.linkedinUrl || null, size: c.size || null, country: c.country || null })) };
  if (k.out === 'people') {
    const domain = bareDomain(fields.domain || '');
    const people = [];
    for (const l of read.rows) {
      const h = hostOf(l.companyWebsite || '');
      // A person from another company is never kept: the filter alone is not enough.
      if (domain && h && !(h === domain || h.endsWith(`.${domain}`) || domain.endsWith(`.${h}`))) continue;
      people.push({ name: l.name, title: l.title, headline: l.headline, profileUrl: l.profileUrl, company: l.company || null, address: l.address });
    }
    return { people, total: people.length };
  }
  let posts = read.rows.map((p) => {
    const o = { url: p.url, author: p.author || (p.authorUrl ? slugOf(p.authorUrl) : ''), postedAt: p.postedAt || null, text: p.text.slice(0, 1000), links: p.links, source: k.source === 'web' ? SITE(p.url) : k.source };
    if (kind === 'reddit_posts') o.subreddit = subOf(p.url) || str(p.subreddit).toLowerCase() || null;
    if (kind === 'linkedin_posts') { o.authorUrl = p.authorUrl || ''; o.name = p.name || ''; o.author = p.author || slugOf(p.authorUrl); }
    return o;
  });
  if (kind !== 'web_research') return { posts };
  // The window is applied here: older than it is dropped and counted, undated is kept and counted.
  if (fields.mode !== 'discussion') return { posts, droppedOld: 0, undated: 0 };
  const since = /^\d{4}-\d{2}-\d{2}/.test(str(fields.since)) ? Date.parse(str(fields.since).slice(0, 10)) : null;
  const kept = posts.filter((p) => since === null || !p.postedAt || Date.parse(p.postedAt) >= since);
  return { posts: kept, droppedOld: posts.length - kept.length, undated: kept.filter((p) => !p.postedAt).length };
}

// Read one result: the mapping first, then the generic reader. Returns {ok, via, ingest, mapping?} or {ok:false, reason}.
export function readResult(kind, mapping, result, fields) {
  if (mapping && mapping.output) {
    const r = readWith(kind, mapping.output, result);
    if (r.ok) return { ok: true, via: mapping.via || 'mapping', ingest: shape(kind, r, fields) };
    if (r.notFound) return { ok: false, notFound: true, reason: r.reason };
    const g = genericRead(kind, result);
    if (g) return { ok: true, via: 'generic', ingest: shape(kind, g, fields), generic: g.output };
    return { ok: false, reason: r.reason };
  }
  const g = genericRead(kind, result);
  if (g) return { ok: true, via: 'generic', ingest: shape(kind, g, fields), generic: g.output };
  const k = kindOf(kind);
  return { ok: false, reason: k && k.shape === 'object' ? `none of ${k.requiredAny.join(', ') || 'the fields'} was found by the usual names` : 'no list of items with a link and a text was found' };
}

// ---- inputs ----------------------------------------------------------------------------------------------------------------
const WINDOWS = [1, 7, 31];
const daysSince = (since, now = Date.now()) => (since ? Math.max(0, (now - Date.parse(since)) / 86400000) : 30);
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const given = (v) => str(v) && !/^(any|anywhere)$/i.test(str(v));

// What the loop itself knows how to give, checked by code, whatever the service. A bad value is the loop's bug: it never reaches the router.
export function loopInputs(kind, f, now = Date.now()) {
  const v = { ...Object.fromEntries(Object.entries(f).filter(([, x]) => typeof x === 'string' || Array.isArray(x)).map(([k, x]) => [k, typeof x === 'string' ? x.trim() : x])) };
  v.days = daysSince(f.since, now);
  switch (kind) {
    case 'x_posts':
      if (!str(f.query)) throw new Error('no query for the X search');
      break;
    case 'reddit_posts': {
      const subs = String(f.subreddits || '').split(/[,\s+]+/).map((x) => x.replace(/^\/?r\//i, '').trim()).filter(Boolean);
      if (!str(f.query)) throw new Error('no query for the Reddit search');
      if (!subs.length) throw new Error('no subreddits for the Reddit search');
      // A stored query already holds its subreddit operators (checked against the offer's list); a built one gets them here.
      v.query = /\bsubreddit:/i.test(str(f.query)) ? str(f.query) : `(${subs.map((r) => `subreddit:${r}`).join(' OR ')}) ${str(f.query)}`;
      v.subreddits = subs;
      break;
    }
    case 'linkedin_posts':
      if (!str(f.query)) throw new Error('no phrase for the LinkedIn search');
      v.query = str(f.query).slice(0, 300);
      break;
    case 'web_research':
      if (!str(f.query)) throw new Error('no query for the web research');
      v.query = str(f.query).slice(0, 400);
      v.mode = f.mode || '';
      v.hosts = f.mode === 'discussion' ? DISCUSSION_HOSTS.slice(0, 20) : [];
      break;
    case 'x_profile':
    case 'x_timeline': {
      const h = str(f.handle).replace(/^@/, '');
      if (!HANDLE.test(h)) throw new Error('not an X handle');
      v.handle = h;
      break;
    }
    case 'linkedin_profile':
    case 'linkedin_author_posts': {
      let u;
      try { u = new URL(String(f.url || '').trim()); } catch { throw new Error('the profile link is not a link'); }
      if (!/(^|\.)linkedin\.com$/i.test(u.hostname) || !/^\/in\/[^/]+/i.test(u.pathname)) throw new Error('not a linkedin.com/in/ profile link');
      v.url = `https://www.linkedin.com/in/${u.pathname.split('/')[2]}`;
      break;
    }
    case 'company_list':
      if (!given(f.industry) && !given(f.place)) throw new Error('the company list needs an industry or a place');
      for (const k of ['industry', 'size', 'place']) if (!given(f[k])) delete v[k];
      break;
    case 'company_profile': {
      const d = bareDomain(f.domain);
      if (!d || !d.includes('.')) throw new Error('not a company domain');
      v.domain = d;
      break;
    }
    case 'people_search': {
      const d = bareDomain(f.domain);
      if (!d) throw new Error('no company domain for the people search');
      v.domain = d;
      v.roles = String(f.role || '').split(/\s*(?:,|;|\bor\b|\/)\s*/i).map((s) => s.trim()).filter(Boolean);
      break;
    }
    case 'person_enrichment': {
      const n = str(f.name);
      const d = bareDomain(f.domain);
      if (!n || !d.includes('.')) throw new Error('the lookup needs a name and a company domain');
      const parts = n.split(/\s+/);
      Object.assign(v, { name: n, domain: d, firstName: parts[0], lastName: parts.slice(1).join(' ') });
      break;
    }
    case 'email_check':
      if (!EMAIL.test(str(f.email))) throw new Error('not an email address');
      v.email = str(f.email).toLowerCase();
      break;
    default:
      break;
  }
  return v;
}

const OMIT = Symbol('omit');
const PLACE = /\[([^[\]]*)\]|\{(\w+)\}/g;
function evalString(s, vars) {
  const exact = /^\{(\w+)\}$/.exec(s);
  if (exact) { const v = vars[exact[1]]; return empty(v) ? OMIT : v; }
  let bad = false;
  const sub = (text, optional) => text.replace(PLACE, (m, opt, name) => {
    if (opt !== undefined) return sub(opt, true);
    const v = vars[name];
    if (empty(v)) { if (optional) throw new Error('skip'); bad = true; return ''; }
    return Array.isArray(v) ? v.join(', ') : String(v);
  });
  const out = s.replace(PLACE, (m, opt, name) => {
    if (opt !== undefined) { try { return sub(opt, true); } catch { return ''; } }
    const v = vars[name];
    if (empty(v)) { bad = true; return ''; }
    return Array.isArray(v) ? v.join(', ') : String(v);
  });
  return bad ? OMIT : out;
}
function evalNode(node, vars) {
  if (typeof node === 'string') return evalString(node, vars);
  if (Array.isArray(node)) { const a = node.map((x) => evalNode(x, vars)).filter((x) => x !== OMIT); return a.length ? a : OMIT; }
  if (node && typeof node === 'object') {
    if ('if' in node) {
      const ok = Object.entries(node.if || {}).every(([k, x]) => String(vars[k] ?? '') === String(x));
      return ok ? ('then' in node ? evalNode(node.then, vars) : OMIT) : 'else' in node ? evalNode(node.else, vars) : OMIT;
    }
    if ('byAge' in node) { const a = node.byAge; return a[Math.min(WINDOWS.findIndex((w) => vars.days <= w) < 0 ? 3 : WINDOWS.findIndex((w) => vars.days <= w), a.length - 1)]; }
    const o = {};
    let n = 0;
    for (const [k, x] of Object.entries(node)) { if (BAD_KEY.has(k)) continue; n += 1; const r = evalNode(x, vars); if (r !== OMIT) o[k] = r; }
    return n && !Object.keys(o).length ? OMIT : o;
  }
  return node;
}
export function buildInput(template, vars) {
  const r = evalNode(template || {}, vars);
  return r === OMIT ? {} : r;
}

// What a mapping's input may hold: strings, numbers, booleans, null, arrays and objects; {if,then,else} and {byAge}; {name} placeholders that are inputs of this need.
export function inputProblems(kind, template) {
  const k = kindOf(kind);
  const known = new Set([...(k ? k.inputs : []), 'days']);
  const bad = [];
  const walk = (n, where) => {
    if (typeof n === 'string') {
      for (const m of n.matchAll(/\{(\w+)\}/g)) if (!known.has(m[1])) bad.push(`${where}: {${m[1]}} is not an input of ${kind} (use ${[...known].join(', ')})`);
    } else if (Array.isArray(n)) n.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (n && typeof n === 'object') {
      if ('byAge' in n && !(Array.isArray(n.byAge) && n.byAge.length >= 2 && n.byAge.length <= 4)) bad.push(`${where}: byAge is a list of 2 to 4 values`);
      for (const [key, x] of Object.entries(n)) {
        if (BAD_KEY.has(key)) bad.push(`${where}: the key ${key} is not allowed`);
        else if (key === 'if') { if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).some((c) => !known.has(c))) bad.push(`${where}.if: name inputs of ${kind}`); } else if (key !== 'byAge') walk(x, `${where}.${key}`);
      }
    } else if (typeof n !== 'number' && typeof n !== 'boolean' && n !== null) bad.push(`${where}: only text, numbers, true, false and null`);
  };
  if (!template || typeof template !== 'object' || Array.isArray(template)) return ['input must be an object'];
  walk(template, 'input');
  return bad;
}

// ---- the service's own input fields (its spec) -------------------------------------------------------------------------------
// The spec the router returns carries the input as a JSON Schema: `properties`, `required`, and `pinned` fields Tenjin sets itself.
export function specInput(spec) {
  const s = spec && spec.spec && typeof spec.spec === 'object' ? spec.spec : spec || {};
  const schema = s.input && typeof s.input === 'object' ? s.input : null;
  if (!schema || !schema.properties || typeof schema.properties !== 'object') return null;
  const pinned = s.pinned && typeof s.pinned === 'object' ? Object.keys(s.pinned) : [];
  const props = Object.entries(schema.properties).filter(([n]) => !pinned.includes(n)).map(([n, p]) => ({ name: n, type: p && p.type ? String(p.type) : null, required: Array.isArray(schema.required) && schema.required.includes(n), ...(p && Array.isArray(p.enum) ? { enum: p.enum.slice(0, 12) } : {}), ...(p && typeof p.description === 'string' ? { about: p.description.slice(0, 120) } : {}) }));
  return { fields: props, strict: schema.additionalProperties === false };
}

// Does `input` fit the spec: every required field present, and no field the spec does not list.
export function fitsSpec(input, specIn) {
  if (!specIn) return { ok: true, missing: [], unknown: [] };
  const names = new Set(specIn.fields.map((f) => f.name));
  const missing = specIn.fields.filter((f) => f.required && empty(input[f.name])).map((f) => f.name);
  const unknown = Object.keys(input).filter((k) => !names.has(k));
  return { ok: !missing.length && !unknown.length, missing, unknown };
}

// The generic filler: each input field of the spec that a loop input matches by its usual name.
export function fillFromSpec(vars, specIn) {
  if (!specIn) return null;
  const syn = reads().inputNames;
  const input = {};
  for (const f of specIn.fields) {
    const canon = Object.keys(syn).find((c) => syn[c].some((n) => norm(n) === norm(f.name)) && !empty(vars[c]));
    if (!canon) continue;
    const v = vars[canon];
    input[f.name] = f.type === 'array' ? [].concat(v) : Array.isArray(v) ? v.join(', ') : v;
  }
  return input;
}

// ---- what the agent sees of an answer --------------------------------------------------------------------------------------
export function skeleton(v, depth = 0) {
  if (Array.isArray(v)) {
    if (!v.length) return [];
    const objs = v.slice(0, 5).filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    return [skeleton(objs.length ? Object.assign({}, ...objs) : v[0], depth + 1)];
  }
  if (v && typeof v === 'object') return depth >= 5 ? 'object' : Object.fromEntries(Object.entries(v).filter(([k]) => !BAD_KEY.has(k)).map(([k, x]) => [k, skeleton(x, depth + 1)]));
  return v === null ? 'null' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string';
}
const cut = (v, n, depth = 0) => {
  if (typeof v === 'string') return v.length > n ? `${v.slice(0, n)}...` : v;
  if (Array.isArray(v)) return v.slice(0, 2).map((x) => cut(x, n, depth + 1));
  if (v && typeof v === 'object') return depth >= 5 ? '{...}' : Object.fromEntries(Object.entries(v).filter(([k]) => !BAD_KEY.has(k)).slice(0, 24).map(([k, x]) => [k, cut(x, n, depth + 1)]));
  return v;
};
// A few items, every string cut short. The text is the seller's data: the agent reads it for its shape only.
export const sample = (result, n = 70) => cut(result, n);
