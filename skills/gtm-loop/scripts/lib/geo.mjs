// A country from free text such as a profile location, only when the text names it. Unknown is null, and a null country is
// treated as unknown by the email gates (the notice line is added and nothing is assumed).
const NAMES = {
  DE: ['germany', 'deutschland', 'berlin', 'munich', 'münchen', 'hamburg', 'frankfurt', 'cologne', 'köln'],
  AT: ['austria', 'österreich', 'vienna', 'wien'],
  CA: ['canada', 'toronto', 'vancouver', 'montreal', 'ottawa', 'calgary'],
  AU: ['australia', 'sydney', 'melbourne', 'brisbane', 'perth'],
  GB: ['united kingdom', 'england', 'scotland', 'wales', 'london', 'manchester', 'edinburgh'],
  FR: ['france', 'paris'], NL: ['netherlands', 'amsterdam'], ES: ['spain', 'madrid', 'barcelona'], IT: ['italy', 'rome', 'milan'], SE: ['sweden', 'stockholm'], IE: ['ireland', 'dublin'], PL: ['poland', 'warsaw'], PT: ['portugal', 'lisbon'], CH: ['switzerland', 'zurich'],
  US: ['united states', 'usa', 'u.s.', 'new york', 'san francisco', 'california', 'texas', 'seattle', 'austin', 'boston', 'chicago'],
  IN: ['india', 'bangalore', 'bengaluru', 'mumbai', 'delhi'], SG: ['singapore'], BR: ['brazil'], JP: ['japan', 'tokyo'],
};
const CODES = ['DE', 'AT', 'CA', 'AU', 'GB', 'UK', 'FR', 'NL', 'ES', 'IT', 'SE', 'IE', 'PL', 'PT', 'CH', 'US', 'IN', 'SG', 'BR', 'JP'];

export function countryFrom(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return null;
  const hits = new Set();
  for (const [code, words] of Object.entries(NAMES)) for (const w of words) if (new RegExp(`(^|[^a-zà-ÿ])${w.replace(/\./g, '\\.')}([^a-zà-ÿ]|$)`).test(t)) hits.add(code);
  const m = /,\s*([A-Za-z]{2})\s*$/.exec(String(text).trim());
  if (m && CODES.includes(m[1].toUpperCase())) hits.add(m[1].toUpperCase() === 'UK' ? 'GB' : m[1].toUpperCase());
  return hits.size === 1 ? [...hits][0] : null; // two countries named is not a country
}
