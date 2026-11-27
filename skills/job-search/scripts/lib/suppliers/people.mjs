// The people search (recorded 2026-11-24). The search itself, its filters and its place check are the loop base's; this file names the kind and
// the words Job Search shows for a contact. The skill never opens profileUrl: it only shows it to the person.
import * as base from '../../../../loop-base/lib/suppliers/people.mjs';

export const HOST = base.HOST;
export const KIND = 'people_search';
export const { mapper, inPlace } = base;

export function adapter(res, { jobKey, ...rest }) {
  return { jobKey, ...base.adapter(res, rest, { how: 'LinkedIn profile (write from your own account; the skill never opens LinkedIn)', caresFallback: (company) => `engineering at ${company || 'the company'}` }) };
}
