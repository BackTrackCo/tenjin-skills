import { graph } from './graph.mjs';
import { applyRulesToJob } from './overlay.mjs';

const DAY = 86400000;

// The words a title must contain one of. search.roleWords widens the list the person's role gives.
export function roleWords(profile) {
  const s = profile.search || {};
  const words = Array.isArray(s.roleWords) && s.roleWords.length ? s.roleWords : String(s.role || '').split(/\W+/);
  return [...new Set(words.map((w) => String(w).toLowerCase()).filter((w) => w.length >= 3))];
}
export function titleMatchesRole(title, profile) {
  const words = roleWords(profile);
  if (!words.length) return true; // no role set, no filter
  const t = String(title).toLowerCase();
  return words.some((w) => t.includes(w));
}

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
  const places = (profile.places || []).map((p) => p.toLowerCase());
  if (places.length) {
    const hay = `${job.city} ${job.region} ${job.country}`.toLowerCase();
    const inPlace = places.some((p) => hay.includes(p));
    if (!inPlace && !(job.remote && profile.remote === true)) drops.push('outside_place');
  }
  if (/contract|temporary|temp\b|freelance/i.test(job.type || '') || /\bcontract\b/i.test(job.title)) warnings.push('contract');
  const byRules = applyRulesToJob(job, rules, now);
  drops.push(...byRules.drops);
  warnings.push(...byRules.warnings);
  return { drop: [...new Set(drops)], warnings: [...new Set(warnings)] };
}
