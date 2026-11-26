// Names match only when their normalized word lists are equal: lower case, letters and digits only, words kept apart, legal suffix
// words dropped. "Vercel Inc" equals "Vercel" and "Scope Labs" equals "Scope Labs, Inc."; "Meow" does not equal "Meow Wolf", and
// "Scope" does not equal "Scope Labs". No containment match anywhere: the lookup returns its best guess with no score, so a looser
// rule would save another company's website and record its people.
const LEGAL = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'gmbh', 'plc', 'sa', 'ag', 'bv', 'pte', 'pty']);
export function normName(name) {
  return String(name || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((w) => w && !LEGAL.has(w));
}
export function nameMatches(a, b) {
  const x = normName(a);
  const y = normName(b);
  return x.length > 0 && x.length === y.length && x.every((w, i) => w === y[i]);
}
