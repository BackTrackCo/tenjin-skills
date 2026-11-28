import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR } from './paths.mjs';

// Self-repair, the reading side. The per-service readers in suppliers/ stay as they are: they know today's services. This file adds what
// they cannot do. A MAPPING (plain data, never code) says where each field sits in a service's answer, and how the loop's inputs fill the
// service's input fields. A mapping builds the answer in the CANONICAL shape of its need (the shape the need's first reader takes), and
// that reader is the check. With no mapping and no reader for a service, a generic reader tries the usual names (reads.json).
let READS;
export const reads = () => (READS ||= JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'reads.json'), 'utf8')));
export const kindOf = (kind) => reads().needs[kind] || null;

// ---- paths -----------------------------------------------------------------------------------------------------------------
// a.b[].c : `[]` takes every element and flattens, `[0]` one element. Only own keys are read.
const TOK = /([^.[\]]+)|\[(\d*)\]/g;
export const SAFE_PATH = /^[A-Za-z0-9_$.[\]-]{0,200}$/;
export const PROTO = /(^|[.[])(__proto__|prototype|constructor)($|[.\][])/;
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
function setPath(obj, p, value) {
  const keys = String(p).split('.').filter(Boolean);
  if (!keys.length) return value;
  let cur = obj;
  keys.slice(0, -1).forEach((k) => { cur = cur[k] && typeof cur[k] === 'object' ? cur[k] : (cur[k] = {}); });
  cur[keys[keys.length - 1]] = value;
  return obj;
}

// ---- values ----------------------------------------------------------------------------------------------------------------
const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const URL_RE = /https:\/\/[^\s<>"')\]]+/g;
const linksOf = (text) => [...new Set((str(text).match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, '')))];
const flat = (v) => (Array.isArray(v) ? v.flatMap(flat) : [v]);
const empty = (v) => v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length);
const toDate = (v) => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v > 1e12 ? v : v * 1000);
  const s = typeof v === 'string' ? v.trim() : '';
  const d = s ? Date.parse(s) : NaN;
  return Number.isNaN(d) ? null : new Date(d);
};
function coerce(type, v) {
  if (v === undefined || v === null) return '';
  const one = Array.isArray(v) ? v[0] : v;
  switch (type) {
    case 'url': { const s = str(one); return /^https?:\/\//i.test(s) ? s : ''; }
    case 'text': return flat(v).map(str).filter(Boolean).join(' ');
    case 'date': { const d = toDate(one); return d ? d.toISOString() : ''; }
    case 'unix': { const d = toDate(one); return d ? Math.floor(d.getTime() / 1000) : ''; }
    case 'number': { const n = typeof one === 'number' ? one : Number(str(one)); return Number.isFinite(n) && str(one) !== '' ? n : ''; }
    case 'bool': return one === true || /^(true|yes|1)$/i.test(str(one)) ? true : one === false || /^(false|no|0)$/i.test(str(one)) ? false : '';
    case 'urlobjs': return [...new Set(flat(v).map(str).filter((s) => /^https:\/\//i.test(s)))].map((u) => ({ expanded_url: u }));
    default: return str(one);
  }
}
// One field. A spec is a path, a list of paths (the first with a value wins) or {join: [path or [paths]], sep}.
function fieldOf(rec, spec, type) {
  if (spec === undefined || spec === null) return '';
  const first = (ps) => { for (const p of [].concat(ps)) { const v = coerce(type, getPath(rec, p)); if (!empty(v)) return v; } return ''; };
  if (typeof spec === 'object' && !Array.isArray(spec)) return (spec.join || []).map((p) => first(p)).filter((x) => !empty(x)).join(typeof spec.sep === 'string' ? spec.sep : '\n');
  return first(spec);
}

// ---- reading with a mapping ------------------------------------------------------------------------------------------------
const foundFalse = (res) => Boolean(res && typeof res === 'object' && ((res.output && res.output.found === false) || res.found === false));
const asList = (res, paths) => { for (const p of [].concat(paths || [])) { const v = getPath(res, p); if (Array.isArray(v)) return v; } return null; };
const asRoot = (res, paths) => { for (const p of [].concat(paths === undefined ? [''] : paths)) { const v = getPath(res, p); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } return null; };

function build(k, output, rec) {
  const item = {};
  const fields = output.fields || {};
  for (const [key, type] of Object.entries(k.keys)) {
    if (type === 'urlobjs') continue;
    const v = fieldOf(rec, fields[key], type);
    if (!empty(v) || v === false) setPath(item, key, v);
  }
  // Links: the ones a mapped field holds, and the ones in the text.
  for (const [key, type] of Object.entries(k.keys)) {
    if (type !== 'urlobjs') continue;
    const mapped = [].concat(fields[key] || []).flatMap((p) => flat(getPath(rec, p) ?? []));
    const v = coerce(type, [...mapped, ...linksOf(getPath(item, 'text'))]);
    if (!empty(v)) setPath(item, key, v);
  }
  return item;
}
const has = (item, key) => { const v = getPath(item, key); return !empty(v); };

// Builds the answer in the need's canonical shape from `result` with the mapping's `output`. Returns {ok, canon, reason, empty}.
export function toCanon(kind, output, result) {
  const k = kindOf(kind);
  if (!k) return { ok: false, reason: `unknown need ${kind}` };
  const wrap = (x) => setPath({ ...(k.fixed ? JSON.parse(JSON.stringify(k.fixed)) : {}) }, k.wrap, x);
  if (k.shape === 'object') {
    if (foundFalse(result)) return { ok: false, notFound: true, reason: 'the service says it found nothing' };
    const root = asRoot(result, output.root);
    if (!root) return { ok: false, reason: 'no answer object at the mapped place' };
    const item = build(k, output, root);
    if (!k.requiredAny.some((f) => has(item, f) || getPath(item, f) === false)) return { ok: false, reason: `none of ${k.requiredAny.join(', ')} was found` };
    return { ok: true, canon: k.wrap ? wrap(item) : item };
  }
  if (foundFalse(result)) return { ok: true, canon: wrap([]), empty: true };
  const list = asList(result, output.list);
  if (!list) return { ok: false, reason: 'no list of items at the mapped place' };
  const rows = [];
  for (const raw of list) {
    let rec = raw;
    if (output.itemRoot && rec && typeof rec === 'object' && rec[output.itemRoot] && typeof rec[output.itemRoot] === 'object') rec = rec[output.itemRoot];
    const item = build(k, output, rec);
    if (k.required.every((f) => has(item, f)) && (!k.oneOf || k.oneOf.some((f) => has(item, f)))) rows.push(item);
  }
  if (list.length && rows.length / list.length < (k.minShare || reads().minShare)) return { ok: false, reason: `only ${rows.length} of ${list.length} items have ${k.required.join(' and ')}` };
  return { ok: true, canon: wrap(rows), empty: !list.length, rows: rows.length };
}

// ---- the generic reader ----------------------------------------------------------------------------------------------------
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
function leaves(v, depth, pre, out) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (depth >= 3) return out;
    for (const [key, x] of Object.entries(v)) { if (!BAD_KEY.has(key)) leaves(x, depth + 1, pre ? `${pre}.${key}` : key, out); }
  } else if (v !== undefined && v !== null && !(Array.isArray(v) && v.length && typeof v[0] === 'object')) out.push({ path: pre, depth, last: pre.split('.').pop() });
  return out;
}
function infer(k, sample) {
  const fields = {};
  const all = sample.flatMap((rec) => leaves(rec, 0, '', []));
  for (const [key, type] of Object.entries(k.keys)) {
    if (type === 'urlobjs') continue;
    const names = [...((k.names || {})[key] || []), key, key.split('.').pop()];
    for (const n of names) {
      const hits = [...new Set(all.filter((l) => norm(l.last) === norm(n) || norm(l.path) === norm(n)).sort((a, b) => a.depth - b.depth).map((l) => l.path))];
      const p = hits.find((h) => sample.filter((rec) => !empty(coerce(type, getPath(rec, h)))).length * 2 >= sample.length);
      if (p) { fields[key] = p; break; }
    }
  }
  return fields;
}
function arraysIn(v, depth, pre, out) {
  if (Array.isArray(v)) { if (v.length && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])) out.push({ path: pre, depth, n: v.length }); return out; }
  if (v && typeof v === 'object' && depth < 5) for (const [key, x] of Object.entries(v)) { if (!BAD_KEY.has(key)) arraysIn(x, depth + 1, pre ? `${pre}.${key}` : key, out); }
  return out;
}
// The shallowest list of objects that fills the need's required keys by their usual names; or the shallow fields of one object.
export function genericCanon(kind, result) {
  const k = kindOf(kind);
  if (!k) return null;
  if (k.shape === 'object') {
    for (const rp of ['', ...['data', 'result', 'output', 'output.data'].filter((p) => asRoot(result, p))]) {
      const root = asRoot(result, rp);
      if (!root) continue;
      const output = { root: [rp], fields: infer(k, [root]) };
      const r = toCanon(kind, output, result);
      if (r.ok) return { output, ...r };
    }
    return null;
  }
  const lists = Array.isArray(result) && result.length && typeof result[0] === 'object' ? [{ path: '', depth: 0, n: result.length }] : [];
  lists.push(...arraysIn(result, 0, '', []).sort((a, b) => a.depth - b.depth || b.n - a.n));
  for (const l of lists) {
    const arr = l.path === '' ? result : getPath(result, l.path);
    const output = { list: [l.path], fields: infer(k, arr.slice(0, 8).filter((x) => x && typeof x === 'object')) };
    const r = toCanon(kind, output, result);
    if (r.ok && !r.empty) return { output, ...r };
  }
  return null;
}

// ---- inputs ----------------------------------------------------------------------------------------------------------------
const WINDOWS = [1, 7, 31];
const OMIT = Symbol('omit');
const PLACE = /\[([^[\]]*)\]|\{(\w+)\}/g;
// The need's own values (strings, numbers, booleans, lists) and the age of its window in days.
export function loopVars(fields, now = Date.now()) {
  const v = Object.fromEntries(Object.entries(fields || {}).filter(([, x]) => ['string', 'number', 'boolean'].includes(typeof x) || (Array.isArray(x) && x.every((y) => typeof y === 'string'))));
  v.days = typeof fields.days === 'number' ? fields.days : fields.since ? Math.max(0, (now - Date.parse(fields.since)) / 86400000) : 30;
  return v;
}
function evalString(s, vars) {
  const exact = /^\{(\w+)\}$/.exec(s);
  if (exact) { const v = vars[exact[1]]; return empty(v) && v !== false ? OMIT : v; }
  let bad = false;
  const text = (t, optional) => t.replace(PLACE, (m, opt, name) => {
    if (opt !== undefined) { try { return text(opt, true); } catch { return ''; } }
    const v = vars[name];
    if (empty(v)) { if (optional) throw new Error('skip'); bad = true; return ''; }
    return Array.isArray(v) ? v.join(', ') : String(v);
  });
  const out = text(s, false);
  return bad ? OMIT : out;
}
function evalNode(node, vars) {
  if (typeof node === 'string') return evalString(node, vars);
  if (Array.isArray(node)) { const a = node.map((x) => evalNode(x, vars)).filter((x) => x !== OMIT); return a.length ? a : OMIT; }
  if (node && typeof node === 'object') {
    if ('if' in node) {
      const ok = Object.entries(node.if || {}).every(([key, x]) => String(vars[key] ?? '') === String(x));
      return ok ? ('then' in node ? evalNode(node.then, vars) : OMIT) : 'else' in node ? evalNode(node.else, vars) : OMIT;
    }
    if ('byAge' in node) { const i = WINDOWS.findIndex((w) => vars.days <= w); return node.byAge[Math.min(i < 0 ? 3 : i, node.byAge.length - 1)]; }
    const o = {};
    let n = 0;
    for (const [key, x] of Object.entries(node)) { if (BAD_KEY.has(key)) continue; n += 1; const r = evalNode(x, vars); if (r !== OMIT) o[key] = r; }
    return n && !Object.keys(o).length ? OMIT : o;
  }
  return node;
}
export const buildInput = (template, vars) => { const r = evalNode(template || {}, vars); return r === OMIT ? {} : r; };

// What a mapping's input may hold: text, numbers, booleans, null, lists and objects; {if,then,else} and {byAge}; `{name}` placeholders
// that are inputs of this need.
export function inputProblems(kind, template) {
  const k = kindOf(kind);
  const known = new Set([...(k ? k.inputs : []), 'days']);
  const bad = [];
  const walk = (n, where) => {
    if (typeof n === 'string') {
      for (const m of n.matchAll(/\{(\w+)\}/g)) if (!known.has(m[1])) bad.push(`${where}: {${m[1]}} is not an input of ${kind} (use ${[...known].join(', ')})`);
      // A constant is a short fixed word or operator, never free text, a command or a link: nothing the loop later sends can instruct.
      const rest = n.replace(/\{\w+\}/g, '').replace(/[[\]]/g, '');
      if (rest.includes('://') || rest.length > 40 || rest.trim().split(/\s+/).length > 3 || !/^[A-Za-z0-9 _.,:;+*/"'()|=<>@#-]*$/.test(rest)) bad.push(`${where}: a constant is a short word or operator (at most 3 words, 40 characters), no link and no sentence`);
    } else if (Array.isArray(n)) n.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (n && typeof n === 'object') {
      if ('byAge' in n && !(Array.isArray(n.byAge) && n.byAge.length >= 2 && n.byAge.length <= 4)) bad.push(`${where}: byAge is a list of 2 to 4 values`);
      for (const [key, x] of Object.entries(n)) {
        if (BAD_KEY.has(key) || !/^[A-Za-z_][\w.-]{0,40}$/.test(key)) bad.push(`${where}: the key ${key} is not a field name`);
        else if (key === 'if') { if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).some((c) => !known.has(c))) bad.push(`${where}.if: name inputs of ${kind}`); } else if (key !== 'byAge') walk(x, `${where}.${key}`);
      }
    } else if (typeof n !== 'number' && typeof n !== 'boolean' && n !== null) bad.push(`${where}: only text, numbers, true, false and null`);
  };
  if (!template || typeof template !== 'object' || Array.isArray(template)) return ['input must be an object'];
  walk(template, 'input');
  return bad;
}

// ---- the service's own input fields (its spec) -------------------------------------------------------------------------------
// Today the router's spec answer carries the input fields as text: an "Inputs:" block of lines `- name (type, required); about`. This one
// function reads them; when the router passes a service's own input fields in another form, only this function changes. An answer with
// no such block gives null, and then nothing is checked before payment.
export function specInput(spec) {
  const text = [spec && spec.__text, spec && spec.text].filter((x) => typeof x === 'string').join('\n');
  const block = /(?:^|\n)Inputs:[ \t]*\n((?:[ \t]*- .*(?:\n|$))+)/.exec(text);
  if (!block) return null;
  const fields = [];
  for (const line of block[1].split('\n')) {
    const m = /^\s*- ([A-Za-z_][\w.-]*) \((.*?)\)(?:;|$)/.exec(line);
    if (!m) continue;
    const kind = m[2].trim();
    fields.push({ name: m[1], type: kind.replace(/\s*,\s*required\s*$/, '').replace(/\{.*$/, '').trim() || null, required: /(^|,)\s*required\s*$/.test(kind), about: line.split(';').slice(1).join(';').trim().slice(0, 120) });
  }
  return fields.length ? { fields } : null;
}
// Does `input` have every field the spec lists as required. A field the text does not list is never a break: the text can be shorter than the service.
export function fitsSpec(input, specIn) {
  if (!specIn) return { ok: true, missing: [] };
  const missing = specIn.fields.filter((f) => f.required && empty(input[f.name]) && input[f.name] !== false).map((f) => f.name);
  return { ok: !missing.length, missing };
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
  if (v && typeof v === 'object') return depth >= 5 ? 'object' : Object.fromEntries(Object.entries(v).filter(([key]) => !BAD_KEY.has(key)).map(([key, x]) => [key, skeleton(x, depth + 1)]));
  return v === null ? 'null' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string';
}
const cut = (v, n, depth = 0) => {
  if (typeof v === 'string') return v.length > n ? `${v.slice(0, n)}...` : v;
  if (Array.isArray(v)) return v.slice(0, 2).map((x) => cut(x, n, depth + 1));
  if (v && typeof v === 'object') return depth >= 5 ? '{...}' : Object.fromEntries(Object.entries(v).filter(([key]) => !BAD_KEY.has(key)).slice(0, 24).map(([key, x]) => [key, cut(x, n, depth + 1)]));
  return v;
};
// A few items, every string cut short. The text is the seller's data: the agent reads it for its shape only.
export const sample = (result, n = 60) => cut(result, n);
