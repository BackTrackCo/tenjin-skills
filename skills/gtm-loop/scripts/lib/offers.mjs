// A profile holds a list of offers. Each has its own line, who it helps, link, phrases, subreddits and an optional buyer. A profile
// from before the list (one `offer`, `phrases` and `buyer` at the top, no subreddits) still loads as one offer called "main".
const clean = (a) => (Array.isArray(a) ? a.map((s) => String(s).trim()).filter(Boolean) : []);

export function offersOf(profile = {}) {
  if (Array.isArray(profile.offers)) {
    return profile.offers.filter((o) => o && typeof o === 'object').map((o, i) => ({ id: String(o.id || `offer-${i + 1}`), name: o.name || '', what: o.what || '', who: o.who || '', link: o.link || '', phrases: clean(o.phrases), subreddits: clean(o.subreddits).map((s) => s.replace(/^\/?r\//i, '').toLowerCase()), buyer: o.buyer || null, buyerAsked: Boolean(o.buyerAsked) }));
  }
  if (profile.offer || clean(profile.phrases).length) {
    const o = profile.offer || {};
    return [{ id: 'main', name: o.name || '', what: o.what || '', who: o.who || '', link: o.link || '', phrases: clean(profile.phrases), subreddits: clean(profile.subreddits).map((s) => s.replace(/^\/?r\//i, '').toLowerCase()), buyer: profile.buyer || null, buyerAsked: false }];
  }
  return [];
}
export const isLegacy = (profile = {}) => !Array.isArray(profile.offers) && Boolean(profile.offer || clean(profile.phrases).length);
export const offerById = (profile, id) => offersOf(profile).find((o) => o.id === id) || null;
// The offer a lead belongs to: by its recorded id, else the first offer.
export const offerOfLead = (profile, lead) => (lead && lead.offerId && offerById(profile, lead.offerId)) || offersOf(profile)[0] || { id: 'main', name: '', what: '', who: '', link: '', phrases: [], subreddits: [], buyer: null };
export const offerOfPhrase = (profile, phrase) => offersOf(profile).find((o) => o.phrases.includes(phrase)) || null;
// [{offer, phrase}] for every phrase of every offer, cut by the person's own phrases-per-round rule when there is one.
export function phrasePairs(profile, cap = null) {
  const out = [];
  for (const offer of offersOf(profile)) for (const phrase of offer.phrases.slice(0, cap || undefined)) out.push({ offer, phrase });
  return out;
}
export const allPhrases = (profile) => offersOf(profile).flatMap((o) => o.phrases);
export const buyerOk = (b) => Boolean(b && ((b.roles || []).length || b.industry));
