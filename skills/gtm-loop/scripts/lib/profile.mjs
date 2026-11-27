import path from 'node:path';
import { readJson, stateDir, writeJsonAtomic } from './paths.mjs';
import { withLock } from './store.mjs';

export const profileFile = () => path.join(stateDir(), 'profile.json');
export const readProfile = () => readJson(profileFile(), {});

const isStr = (v) => typeof v === 'string';
const strList = (v) => Array.isArray(v) && v.every(isStr);
const SOURCES = ['x', 'reddit', 'linkedin', 'hn', 'web'];
export const EMAIL_MODES = ['ask', 'drafts', 'show'];

// The shape of profile.json, checked when it is set. Fields: offer {name, what, who, link}, sender {name, company, postal,
// handles {x, reddit, hn, linkedin}, domain}, buyer {roles[], industry, size, place}, phrases[], sources[], frequency, emailMode,
// updates, unattended.
export function validateProfile(p) {
  const bad = [];
  const need = (ok, msg) => ok || bad.push(msg);
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['the profile must be a JSON object'];
  const has = (k) => p[k] !== undefined && p[k] !== null;
  if (has('offer')) {
    const o = p.offer;
    need(o && typeof o === 'object' && isStr(o.name) && o.name.trim() && isStr(o.what) && o.what.trim(), 'offer needs a name and a short "what it does" (text)');
    if (o && o.link !== undefined) need(isStr(o.link) && /^https:\/\//.test(o.link), 'offer.link must be an https link');
    if (o && o.who !== undefined) need(isStr(o.who), 'offer.who must be text');
  }
  if (has('sender')) {
    const s = p.sender;
    need(s && typeof s === 'object' && isStr(s.name) && s.name.trim(), 'sender needs a name');
    if (s && typeof s === 'object') {
      for (const k of ['company', 'postal', 'domain']) if (s[k] !== undefined) need(isStr(s[k]), `sender.${k} must be text`);
      if (s.handles !== undefined) need(s.handles && typeof s.handles === 'object' && Object.values(s.handles).every(isStr), 'sender.handles must be an object of text');
    }
  }
  if (has('buyer')) {
    const b = p.buyer;
    need(b && typeof b === 'object' && strList(b.roles || []) && ['industry', 'size', 'place'].every((k) => b[k] === undefined || isStr(b[k])), 'buyer is {roles: [text], industry, size, place}');
  }
  if (has('phrases')) need(strList(p.phrases) && p.phrases.every((s) => s.trim()), 'phrases must be a list of text');
  if (has('sources')) need(strList(p.sources) && p.sources.every((s) => SOURCES.includes(s)), `sources must be a list from ${SOURCES.join(', ')}`);
  if (has('frequency')) need(['daily', 'twice_daily', 'weekly'].includes(p.frequency), 'frequency must be daily, twice_daily or weekly');
  if (has('emailMode')) need(EMAIL_MODES.includes(p.emailMode), `emailMode must be one of ${EMAIL_MODES.join(', ')}`);
  if (has('updates')) need(typeof p.updates === 'boolean', 'updates must be true or false');
  if (has('sweepHour')) need(Number.isInteger(p.sweepHour) && p.sweepHour >= 0 && p.sweepHour <= 23, 'sweepHour must be a whole number from 0 to 23');
  return bad;
}

// A merge: an object value merges one level in, null removes the field.
export function setProfile(patch) {
  return withLock(() => {
    const cur = readProfile();
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else if (v && typeof v === 'object' && !Array.isArray(v) && cur[k] && typeof cur[k] === 'object' && !Array.isArray(cur[k])) next[k] = { ...cur[k], ...v };
      else next[k] = v;
    }
    const bad = validateProfile(next);
    if (bad.length) throw new Error(bad.join('; '));
    writeJsonAtomic(profileFile(), next);
    return next;
  });
}
