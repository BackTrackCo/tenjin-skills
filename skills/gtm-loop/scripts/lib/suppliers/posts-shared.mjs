// Shared by the post adapters (LinkedIn posts, the X search that leads with several reads). A post is data: its text is kept short, its
// links are the only part that leads anywhere.
export const str = (v) => (typeof v === 'string' ? v.trim() : '');
const URL_RE = /https:\/\/[^\s<>"')\]]+/g;
export const linksOf = (text, ...more) => [...new Set([...(str(text).match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, '')), ...more.map(str).filter((u) => /^https:\/\//.test(u))])];
export const isoOfUnix = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null);
const handleOf = (u) => (/linkedin\.com\/in\/([^/?#\s]+)/i.exec(str(u)) || [])[1] || '';
export { handleOf };
