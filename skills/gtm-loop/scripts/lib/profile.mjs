import path from 'node:path';
import { readJson, stateDir, writeJsonAtomic } from './paths.mjs';
import { withLock } from './store.mjs';
import { MAX_PHRASE_WORDS, wordsIn } from './queries.mjs';
import { checkQueries } from './querycheck.mjs';

export const profileFile = () => path.join(stateDir(), 'profile.json');
export const readProfile = () => readJson(profileFile(), {});

const isStr = (v) => typeof v === 'string';
const strList = (v) => Array.isArray(v) && v.every(isStr);
const SOURCES = ['x', 'reddit', 'linkedin', 'hn', 'web'];
export const EMAIL_MODES = ['ask', 'drafts', 'show'];

// The shape of profile.json, checked when it is set. Types only: a partial answer is saved as it comes (handles first, the sender's
// name later), and `G start status` lists what is still missing. Fields: offers [{id, name, what, who, link, phrases[], subreddits[],
// buyer {roles[], industry, size, place}, buyerAsked}], sender {name, company, postal, handles {x, reddit, hn, linkedin}, domain},
// sources[], frequency, emailMode, updates. A profile from before the list (offer, phrases, buyer, subreddits at the top) still loads.
export function validateProfile(p) {
  const bad = [];
  const need = (ok, msg) => ok || bad.push(msg);
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['the profile must be a JSON object'];
  const has = (k) => p[k] !== undefined && p[k] !== null;
  const checkBuyer = (b, at) => need(b && typeof b === 'object' && strList(b.roles || []) && ['industry', 'size', 'place'].every((k) => b[k] === undefined || isStr(b[k])), `${at} is {roles: [text], industry, size, place}`);
  const checkPhrases = (list, at) => {
    need(strList(list) && list.every((x) => x.trim()), `${at} must be a list of text`);
    if (strList(list)) for (const x of list) need(wordsIn(x).length <= MAX_PHRASE_WORDS, `a phrase is short, as a buyer writes a post (${MAX_PHRASE_WORDS} words at most): "${x.slice(0, 50)}"`);
  };
  if (has('offers')) {
    need(Array.isArray(p.offers), 'offers must be a list');
    if (Array.isArray(p.offers)) {
      const ids = new Set();
      p.offers.forEach((o, i) => {
        const at = `offers[${i}]`;
        if (!o || typeof o !== 'object') return bad.push(`${at}: not an object`);
        need(isStr(o.id) && /^[a-z0-9][a-z0-9-]*$/.test(o.id), `${at}.id is a short kebab-case name`);
        need(!ids.has(o.id), `${at}.id is used twice`);
        ids.add(o.id);
        for (const k of ['name', 'what', 'who']) if (o[k] !== undefined) need(isStr(o[k]), `${at}.${k} must be text`);
        if (o.link !== undefined) need(isStr(o.link) && /^https:\/\//.test(o.link), `${at}.link must be an https link`);
        if (o.phrases !== undefined) checkPhrases(o.phrases, `${at}.phrases`);
        if (o.subreddits !== undefined) need(strList(o.subreddits), `${at}.subreddits must be a list of subreddit names`);
        if (o.buyer !== undefined && o.buyer !== null) checkBuyer(o.buyer, `${at}.buyer`);
        if (o.buyerAsked !== undefined) need(typeof o.buyerAsked === 'boolean', `${at}.buyerAsked must be true or false`);
        if (o.queriesAsked !== undefined) need(typeof o.queriesAsked === 'boolean', `${at}.queriesAsked must be true or false`);
        for (const b of checkQueries(o.queries, o)) bad.push(`${at}.queries.${b}`);
      });
    }
  }
  if (has('offer')) {
    const o = p.offer;
    need(o && typeof o === 'object' && isStr(o.name) && o.name.trim() && isStr(o.what) && o.what.trim(), 'offer needs a name and a short "what it does" (text)');
    if (o && o.link !== undefined) need(isStr(o.link) && /^https:\/\//.test(o.link), 'offer.link must be an https link');
    if (o && o.who !== undefined) need(isStr(o.who), 'offer.who must be text');
  }
  if (has('sender')) {
    const s = p.sender;
    need(s && typeof s === 'object', 'sender must be an object');
    if (s && typeof s === 'object') {
      for (const k of ['name', 'company', 'postal', 'domain']) if (s[k] !== undefined) need(isStr(s[k]), `sender.${k} must be text`);
      if (s.handles !== undefined) need(s.handles && typeof s.handles === 'object' && Object.values(s.handles).every(isStr), 'sender.handles must be an object of text');
    }
  }
  if (has('buyer')) checkBuyer(p.buyer, 'buyer');
  if (has('phrases')) need(strList(p.phrases) && p.phrases.every((s) => s.trim()), 'phrases must be a list of text');
  if (has('subreddits')) need(strList(p.subreddits), 'subreddits must be a list of subreddit names');
  if (has('drafts')) need(p.drafts && typeof p.drafts === 'object' && (p.drafts.dir === undefined || isStr(p.drafts.dir)), 'drafts must be {dir: text}');
  if (has('sources')) need(strList(p.sources) && p.sources.every((s) => SOURCES.includes(s)), `sources must be a list from ${SOURCES.join(', ')}`);
  if (has('frequency')) need(['daily', 'twice_daily', 'weekly'].includes(p.frequency), 'frequency must be daily, twice_daily or weekly');
  if (has('emailMode')) need(EMAIL_MODES.includes(p.emailMode), `emailMode must be one of ${EMAIL_MODES.join(', ')}`);
  if (has('updates')) need(typeof p.updates === 'boolean', 'updates must be true or false');
  if (has('sweepHour')) need(Number.isInteger(p.sweepHour) && p.sweepHour >= 0 && p.sweepHour <= 23, 'sweepHour must be a whole number from 0 to 23');
  return bad;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
// An object merges into the saved one all the way down, so a handle given later never drops one given first; a list replaces.
const merge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  return out;
};
// A merge: an object value merges in, null removes the field.
export function setProfile(patch) {
  return withLock(() => {
    const cur = readProfile();
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else if (isObj(v) && isObj(cur[k])) next[k] = merge(cur[k], v);
      else next[k] = v;
    }
    const bad = validateProfile(next);
    if (bad.length) throw new Error(bad.join('; '));
    writeJsonAtomic(profileFile(), next);
    return next;
  });
}
