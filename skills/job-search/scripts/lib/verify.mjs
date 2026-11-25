import { graph } from './graph.mjs';
import { applyRulesToJob } from './overlay.mjs';

const DAY = 86400000;

// The words a title must contain one of, as the HN search and its prefilter use them. search.roleWords widens the list the
// person's role gives; a short word such as "QA" or "ML" counts.
const LEVELS = new Set(['senior', 'sr', 'junior', 'jr', 'staff', 'lead', 'principal', 'associate', 'intern']);
export function roleWords(profile) {
  const s = profile.search || {};
  const words = Array.isArray(s.roleWords) && s.roleWords.length ? s.roleWords : String(s.role || '').split(/\W+/);
  return [...new Set(words.flatMap((w) => String(w).toLowerCase().split(/\W+/)).filter((w) => w.length >= 2 && !LEVELS.has(w)))];
}
const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A whole word in a text: "engineer" is not in "engineering", and "ml" is not in "html".
export const hasWord = (text, w) => new RegExp(`(^|[^a-z0-9])${escapeRe(w)}([^a-z0-9]|$)`).test(String(text).toLowerCase());
// A title matches when it holds one of the role words as a whole word (a level word such as "senior" never counts, so "Senior
// Accountant" does not match "Senior Software Engineer", and "engineer" is not found in "Engineering").
export function titleMatchesRole(title, profile) {
  const words = roleWords(profile);
  if (!words.length) return true; // no role set, no filter
  return words.some((w) => hasWord(title, w));
}

// The city of a place the person gave ("San Francisco, CA", "New York City"): what a posting's own text is compared with.
export const placeKey = (place) => String(place || '').split(',')[0].toLowerCase().replace(/\b(city|metro|area|greater)\b/g, ' ').replace(/\s+/g, ' ').trim();
export const placesOf = (profile) => {
  const list = Array.isArray(profile.places) && profile.places.length ? profile.places : (profile.search || {}).place ? [(profile.search || {}).place] : [];
  return list.map(placeKey).filter(Boolean);
};

// Code drops a job only when it is outside the date window, the place or the role,
// or a rule of the person's drops it. Everything else becomes a warning.
// source "routed" (a search result, an HN post): the catch-up window applies, checked first.
// source "watched" (an employer's own board): it lists only open jobs, so age never drops a job, it only warns.
export function screenJob(job, profile, rules, now, { source = 'routed' } = {}) {
  const drops = [];
  const warnings = [];
  const windowDays = profile.windowDays || 14;
  const age = job.posted ? now - Date.parse(job.posted) : null;
  if (age !== null) {
    if (source === 'routed' && age > windowDays * DAY && !profile.includeOld) drops.push('outside_date_window');
    else if (age > graph().staleListingDays * DAY) warnings.push('listed over 60 days');
  }
  if (source === 'watched' && !titleMatchesRole(job.title, profile)) drops.push('outside_role');
  const places = placesOf(profile);
  const remoteOk = (profile.remote !== undefined ? profile.remote : (profile.search || {}).remote) === true;
  if (places.length) {
    const hay = `${job.city || ''} ${job.region || ''} ${job.country || ''}`.toLowerCase().trim();
    const inPlace = places.some((p) => hay.includes(p));
    // A posting that names no place at all is kept with a warning: nothing says it is somewhere else.
    if (!hay && !job.remote) warnings.push('no place named');
    else if (!inPlace && !(job.remote && remoteOk)) drops.push('outside_place');
  }
  if (/contract|temporary|temp\b|freelance/i.test(job.type || '') || /\bcontract\b/i.test(job.title)) warnings.push('contract');
  const byRules = applyRulesToJob(job, rules, now);
  drops.push(...byRules.drops);
  warnings.push(...byRules.warnings);
  return { drop: [...new Set(drops)], warnings: [...new Set(warnings)] };
}
