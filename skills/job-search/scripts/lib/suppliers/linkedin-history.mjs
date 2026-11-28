// The LinkedIn profile reader with the work history (a second reader beside the thin one, picked by its host). Input: `url` (required),
// https://www.linkedin.com/in/<handle>. Result: {output: {found, data: {firstName, lastName, headline, location, about, currentPosition[],
// experience[], education[], skills[], followerCount, connectionsCount, openToWork}}}. `experience[]` carries titles and dates;
// `education[]` is schools only here; `skills` may be empty and is not used. This follows the shape of the catalog entry that has not
// merged yet (built from its fixtures, not from a recorded paid answer), so it can change: an answer without a name, a headline or an
// about text is refused, and nothing here invents a field. A connection or follower count is a number the skill does not keep, and
// no person list is ever stored.
export const HOST = 'api.getanyapi.com';
export const KIND = 'linkedin_profile';
export const RECORDED = false;
export { mapper } from './linkedin.mjs';

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
// "2014-02" stays, "2014" stays, "Feb 2014" and "February 2014" become "2014-02", anything else is no date.
export function normDate(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  const s = str(v);
  if (/^\d{4}(-\d{2})?(-\d{2})?$/.test(s)) return s.slice(0, 7);
  const m = /^([A-Za-z]{3})[A-Za-z]*\.?,?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[2]}-${MONTHS[m[1].toLowerCase()]}`;
  return null;
}
const span = (e) => (e.start || e.end ? ` (${e.start || '?'} to ${e.end || 'now'})` : '');
const list = (a) => (Array.isArray(a) ? a.filter((x) => x && typeof x === 'object') : []);

export function adapter(res) {
  const out = (res && res.output) || res || {};
  if (out.found === false) throw new Error('the profile was not found');
  const r = out.data || out.result || {};
  const name = [str(r.firstName), str(r.lastName)].filter(Boolean).join(' ');
  if (!name && !str(r.headline) && !str(r.about)) throw new Error('the profile has no name, headline or about text');
  const experience = list(r.experience).map((e) => ({ company: str(e.companyName), title: str(e.position), start: normDate(e.startDate), end: normDate(e.endDate) })).filter((e) => e.company || e.title);
  const current = list(r.currentPosition).map((e) => ({ company: str(e.companyName), title: str(e.position) })).filter((e) => e.title);
  const schools = list(r.education).map((e) => ({ name: str(e.school), start: normDate(e.startDate), end: normDate(e.endDate) })).filter((e) => e.name);
  const titles = [...new Set([...current.map((c) => c.title), ...experience.map((e) => e.title)].filter(Boolean))];
  const parts = [
    name, str(r.headline), str(r.location), str(r.about),
    experience.length ? `Experience:\n${experience.map((e) => `- ${[e.title, e.company].filter(Boolean).join(', ')}${span(e)}`).join('\n')}` : '',
    schools.length ? `Education:\n${schools.map((e) => `- ${e.name}${span(e)}`).join('\n')}` : '',
  ].filter(Boolean);
  // With titles the profile is not thin: the role and role words can come from them (still confirmed with the person).
  return { need: 'linkedin_profile', text: parts.join('\n\n'), headline: str(r.headline) || null, history: experience, current, schools, titles, thin: titles.length === 0 };
}
