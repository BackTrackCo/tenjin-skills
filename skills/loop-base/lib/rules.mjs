import crypto from 'node:crypto';
import path from 'node:path';
import { getApp } from './app.mjs';
import { canonical } from './hash.mjs';
import { readJson, stateDir, writeJsonAtomic } from './paths.mjs';
import { withLock } from './store.mjs';

// The person's rules and the app's own lessons. The app declares the vocabulary:
//   rules: { effects(), check(effect, value), lessonEffects(), lessonDays(), lessonTemplates: { effect: (lesson) => text },
//            exempt: [effects that only tighten], hashParts(profile) }
// A rule keeps the person's own words, the date and an effect from the vocabulary. A lesson only tightens, takes its text from a
// template over evidence ids (never from page text), and expires.
const DAY = 86400000;
const decl = () => {
  const r = getApp().rules;
  if (!r || typeof r.effects !== 'function') throw new Error(`the app ${getApp().name} has not declared its rules vocabulary`);
  return r;
};

export const rulesFile = () => path.join(stateDir(), 'rules.json');

export function loadOverlay() {
  return readJson(rulesFile(), { rules: [], lessons: [] });
}
function mutate(fn) {
  return withLock(() => {
    const o = loadOverlay();
    const out = fn(o);
    writeJsonAtomic(rulesFile(), o);
    return out;
  });
}

export function addRule({ effect, value = null, words, date }) {
  const d = decl();
  if (!d.effects().includes(effect)) throw new Error(`rule effect not in the vocabulary: ${effect}`);
  if (!words || !String(words).trim()) throw new Error('a rule keeps the words the person said');
  if (typeof d.check === 'function') d.check(effect, value);
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
    o.lessons = o.lessons.filter((l) => l.id !== id);
    return n - o.rules.length;
  });
}

export function addLesson({ effect, subject, evidence = [], now = Date.now() }) {
  const d = decl();
  if (!d.lessonEffects().includes(effect)) throw new Error(`lesson effect refused (not tighten-only): ${effect}`);
  return mutate((o) => {
    const prior = o.lessons.filter((l) => l.effect === effect && l.subject === subject);
    const live = prior.find((l) => Date.parse(l.expires) > now);
    if (live) return live;
    const days = d.lessonDays();
    const level = Math.min(prior.length, days.length - 1);
    const lesson = { id: `l${now.toString(36)}${o.lessons.length}`, effect, subject, evidence: evidence.slice(0, 5), created: new Date(now).toISOString(), expires: new Date(now + days[level] * DAY).toISOString(), days: days[level] };
    lesson.text = d.lessonTemplates[effect](lesson);
    o.lessons.push(lesson);
    return lesson;
  });
}
export function activeLessons(o, now = Date.now()) {
  return o.lessons.filter((l) => Date.parse(l.expires) > now);
}

export function ruleValue(overlay, effect) {
  const r = (overlay.rules || []).filter((x) => x.effect === effect).pop();
  return r ? r.value : undefined;
}

// The hash a consent is bound to: the person's confirmed settings (the app's `hashParts`) and their rules. Effects that only tighten
// what the app may do (`exempt`) do not change it.
export function rulesHash(profile, overlay) {
  const d = decl();
  const exempt = d.exempt || [];
  const rules = (overlay.rules || []).filter((r) => !exempt.includes(r.effect)).map((r) => [r.effect, r.value]).sort();
  return crypto.createHash('sha256').update(canonical({ ...(typeof d.hashParts === 'function' ? d.hashParts(profile) : {}), rules })).digest('hex');
}
