import crypto from 'node:crypto';
import path from 'node:path';
import { graph } from './graph.mjs';
import { readJson, stateDir, writeJsonAtomic } from './paths.mjs';
import { withLock } from './store.mjs';

export const rulesFile = () => path.join(stateDir(), 'rules.json');
export const loadOverlay = () => readJson(rulesFile(), { rules: [] });

function mutate(fn) {
  return withLock(() => {
    const o = loadOverlay();
    const out = fn(o);
    writeJsonAtomic(rulesFile(), o);
    return out;
  });
}

const whole = (n) => Number.isInteger(Number(n)) && Number(n) > 0;

// The person's rules: their words verbatim, the date, and an effect from the vocabulary. The skill has no lessons and no default
// rule: nothing here is written but on the person's own words.
export function addRule({ effect, value = null, words, date }) {
  const g = graph();
  if (!g.ruleEffects.includes(effect)) throw new Error(`rule effect not in the vocabulary: ${effect}`);
  if (!words || !String(words).trim()) throw new Error('a rule keeps the words the person said');
  if (g.capEffects.includes(effect) && !whole(value)) throw new Error(`${effect} is a whole number`);
  if (effect === 'min_score' && !(Number(value) >= 1 && Number(value) <= 100)) throw new Error('min_score is a number from 1 to 100');
  if (effect === 'follow_up' && !(value === null || value === '' || whole(value))) throw new Error('follow_up is a whole number of days');
  if (['exclude_term', 'exclude_domain', 'exclude_person'].includes(effect) && !String(value || '').trim()) throw new Error(`${effect} needs a value`);
  return mutate((o) => {
    const rule = { id: `r${Date.now().toString(36)}${o.rules.length}`, effect, value, words: String(words), date: date || new Date().toISOString().slice(0, 10) };
    o.rules.push(rule);
    return rule;
  });
}
export function removeRule(id) {
  return mutate((o) => {
    const n = o.rules.length;
    o.rules = o.rules.filter((r) => r.id !== id);
    return n - o.rules.length;
  });
}

export function ruleValue(overlay, effect) {
  const r = (overlay.rules || []).filter((x) => x.effect === effect).pop();
  return r ? r.value : undefined;
}
export const capOf = (overlay, effect) => {
  const v = ruleValue(overlay, effect);
  return v === undefined ? null : Number(v);
};
export const followUpDays = (overlay) => {
  const r = (overlay.rules || []).filter((x) => x.effect === 'follow_up').pop();
  if (!r) return null;
  return r.value ? Number(r.value) : graph().followUp.defaultDays;
};

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// The hash a consent is bound to: the person's sender facts and the rules that decide who may be written to. Caps and
// notification rules only tighten, so they do not change it.
export function rulesHash(profile, overlay) {
  const excluded = graph().hashExcluded;
  const rules = (overlay.rules || []).filter((r) => !excluded.includes(r.effect)).map((r) => [r.effect, r.value]).sort();
  const sender = profile.sender || {};
  return crypto.createHash('sha256').update(canonical({ sender: { name: sender.name || null, company: sender.company || null, postal: sender.postal || null }, offer: (profile.offer || {}).name || null, rules })).digest('hex');
}
