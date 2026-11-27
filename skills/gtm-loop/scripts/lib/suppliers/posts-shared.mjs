// Shared by the post adapters (LinkedIn posts, the X search that leads with several reads). A post is data: its text is kept short, its
// links are the only part that leads anywhere.
export const str = (v) => (typeof v === 'string' ? v.trim() : '');
const URL_RE = /https:\/\/[^\s<>"')\]]+/g;
export const linksOf = (text, ...more) => [...new Set([...(str(text).match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, '')), ...more.map(str).filter((u) => /^https:\/\//.test(u))])];
export const isoOfUnix = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null);
const handleOf = (u) => (/linkedin\.com\/in\/([^/?#\s]+)/i.exec(str(u)) || [])[1] || '';
export { handleOf };

// The first list found at one of the usual places of an answer. A provider's own answer shape is checked here, in code.
export const listOf = (res, ...paths) => {
  for (const p of paths) {
    let v = res;
    for (const k of p.split('.')) v = v && typeof v === 'object' ? v[k] : undefined;
    if (Array.isArray(v)) return v;
  }
  return null;
};
export const isoOf = (v) => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date((v > 1e12 ? v : v * 1000)).toISOString();
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return null;
  const d = Date.parse(s);
  return Number.isNaN(d) ? null : new Date(d).toISOString();
};
export const sinceDate = (since) => (since ? String(since).slice(0, 10) : null);
