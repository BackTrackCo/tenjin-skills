import { fetchBoard, parseCareersUrl } from './boards.mjs';
import { candidates, employerName, employerWords } from './employer.mjs';

const SYSTEMS = ['greenhouse', 'lever', 'ashby'];
const idOf = (w) => {
  const p = w.url ? parseCareersUrl(w.url) : w.ats && w.token ? { ats: w.ats, token: w.token, region: w.region || 'us' } : null;
  return p && p.token ? `${p.ats}:${p.region || 'us'}:${p.token}` : null;
};

// The watch list is profile.watch, and a board joins it only from the person's own message: a pasted careers link, or a
// company name whose board the employer resolution finds. Returns {watch} with the new list, or {line} with one plain line.
export async function addWatch(arg, watch, { fetch } = {}) {
  const list = Array.isArray(watch) ? [...watch] : [];
  const text = String(arg || '').trim();
  if (!text) return { line: 'Say which company, or paste its careers link.' };
  if (/^https?:\/\//i.test(text)) {
    const p = parseCareersUrl(text);
    if (!p) return { line: 'That link is not a Greenhouse, Lever or Ashby careers page, so there is no board to read. Paste the board link if the company has one.' };
    if (p.needsBoard) return { line: 'That page only embeds a board and carries no board link. Paste the board link (a Greenhouse, Lever or Ashby careers page).' };
    const entry = { url: text, name: p.token };
    if (list.some((w) => idOf(w) === idOf(entry))) return { watch: list, already: p.token };
    return { watch: [...list, entry], added: p.token };
  }
  // A name: the existing employer resolution. A board counts as the company's own when its name matches (Greenhouse
  // names its boards); one board that answers alone is taken too. Otherwise one plain line says so.
  const words = employerWords(text);
  const answered = [];
  for (const token of candidates(text, null)) {
    for (const ats of SYSTEMS) {
      const r = await fetchBoard({ ats, token, region: 'us', name: '' }, fetch);
      if (r.ok) answered.push({ ats, token, owned: ats === 'greenhouse' && employerName(r.jobs[0].company) === words.join(' '), name: ats === 'greenhouse' ? r.jobs[0].company : text });
    }
  }
  const owned = answered.filter((a) => a.owned);
  const pick = owned.length ? owned[0] : answered.length === 1 ? answered[0] : null;
  if (!pick) {
    return { line: answered.length ? `I found more than one board that could be ${text} and cannot tell which is theirs. Paste the company's careers link.` : `I found no Greenhouse, Lever or Ashby board for ${text}. Paste the company's careers link if it has one.` };
  }
  const entry = { ats: pick.ats, token: pick.token, region: 'us', name: pick.name };
  if (list.some((w) => idOf(w) === idOf(entry))) return { watch: list, already: pick.name };
  return { watch: [...list, entry], added: pick.name, board: `${pick.ats}:${pick.token}` };
}

// A board stays until the person removes it, by company name, board or link.
export function removeWatch(arg, watch) {
  const want = String(arg || '').trim().toLowerCase();
  const p = /^https?:\/\//i.test(want) ? parseCareersUrl(want) : null;
  const hit = (w) => {
    const q = idOf(w) || '';
    const [ats, , token] = q.split(':');
    return [w.name, w.url, token, `${ats}:${token}`].some((x) => x && String(x).toLowerCase() === want) || (p && p.token && idOf(w) === `${p.ats}:${p.region || 'us'}:${p.token}`);
  };
  const list = (watch || []).filter((w) => !hit(w));
  return { watch: list, removed: (watch || []).length - list.length };
}
