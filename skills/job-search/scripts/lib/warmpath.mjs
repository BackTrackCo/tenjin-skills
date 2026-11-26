import { employerName } from './employer.mjs';

// "Also worked at" hints. A match by employer or school alone is no hint. A hint counts only for the same past employer when that
// employer is small (an employee range that tops out at 50 or fewer), or, for a big one, when one profile read of the candidate shows
// the dates at that employer overlapping the person's and a team word shared by both titles. Code does the matching; the model never
// guesses a team. Fail closed: no titles or dates on either side means no hint.

// The generic job words removed before two titles are compared (a fixed list): what is left names a team or a craft.
export const GENERIC = new Set(['engineer', 'engineers', 'engineering', 'senior', 'staff', 'principal', 'lead', 'manager', 'software', 'developer', 'intern', 'ii', 'iii', 'iv', 'junior', 'sr', 'jr', 'associate', 'head', 'director', 'of', 'and', 'the', 'at', 'in', 'for', 'a', 'an', 'full', 'stack', 'fullstack', 'member', 'technical']);
const tokens = (title) => String(title || '').toLowerCase().normalize('NFKD').split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !GENERIC.has(w));
export function sharedTeamWord(a, b) {
  const tb = new Set(tokens(b));
  return tokens(a).find((w) => tb.has(w)) || null;
}

// "2021-03" -> months since year 0; "2021" -> January for a start and December for an end; nothing -> null.
function months(date, end) {
  const m = /^(\d{4})(?:-(\d{2}))?/.exec(String(date || ''));
  if (!m) return null;
  return Number(m[1]) * 12 + (m[2] ? Number(m[2]) - 1 : end ? 11 : 0);
}
// Two stints overlap when both have a start date; a missing end means still there.
export function overlaps(a, b, now = Date.now()) {
  const as = months(a.start, false);
  const bs = months(b.start, false);
  if (as === null || bs === null) return false;
  const nowM = new Date(now).getUTCFullYear() * 12 + new Date(now).getUTCMonth();
  const ae = a.end ? months(a.end, true) : nowM;
  const be = b.end ? months(b.end, true) : nowM;
  if (ae === null || be === null) return false;
  return as <= be && bs <= ae;
}

// The upper bound of an employee range ("11-50" -> 50, "501-1K" -> 1000, "10K+" -> Infinity); null when it says nothing.
export function employeeUpper(range) {
  const s = String(range || '').trim().toUpperCase().replace(/,/g, '');
  if (!s) return null;
  if (s.endsWith('+')) return Infinity;
  const n = (t) => { const m = /^(\d+(?:\.\d+)?)(K?)$/.exec(t); return m ? Number(m[1]) * (m[2] ? 1000 : 1) : null; };
  const parts = s.split('-').map((x) => x.trim());
  const last = n(parts[parts.length - 1]);
  return last;
}
export const isSmall = (range) => { const u = employeeUpper(range); return u !== null && u <= 50; };

// The stints at one employer in a history [{company, title, start, end}].
export const stintsAt = (history, company) => (history || []).filter((h) => h && employerName(h.company) === employerName(company));

// The big-employer check: a date overlap and a shared team word, both from the two histories.
export function bigEmployerMatch(personHistory, candidateHistory, employer, now = Date.now()) {
  for (const p of stintsAt(personHistory, employer)) {
    for (const c of stintsAt(candidateHistory, employer)) {
      if (!p.title || !c.title) continue;
      if (!overlaps(p, c, now)) continue;
      const team = sharedTeamWord(p.title, c.title);
      if (team) return { team, overlapWith: { start: c.start, end: c.end } };
    }
  }
  return null;
}
