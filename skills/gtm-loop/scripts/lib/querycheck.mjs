// The queries the model writes for each offer and source are checked here, before they are saved and before every run. A query that
// fails is refused with the reason and the model rewrites it. A query comes only from the model, in an attended turn, from the person's
// own words: text from a tool or a post never becomes a query. The operators each source supports were read from the router's
// catalog entries: X (from:, min_faves:, since:, -filter:replies, OR in parentheses, quotes), Reddit (subreddit:, author:, title:),
// the web search (plain text, no operators), LinkedIn and Hacker News (key words).
export const SOURCES = ['x', 'reddit', 'linkedin', 'web', 'hn'];
export const LIMITS = { x: 400, reddit: 300, web: 400, linkedin: 200, hn: 100 };
const MAX_WORDS = { linkedin: 8, hn: 6 };
const words = (t) => String(t).trim().split(/\s+/).filter(Boolean);

// Operators found in the text outside quotes: [{neg, name, value}].
function operatorsOf(text) {
  const bare = String(text).replace(/"[^"]*"/g, ' ');
  return [...bare.matchAll(/(^|[\s(])(-?)([a-z_]+):(\S*)/gi)].map((m) => ({ neg: m[2] === '-', name: m[3].toLowerCase(), value: m[4].replace(/[)]+$/, '') }));
}

export function checkQuery(source, text, offer = {}) {
  const bad = [];
  if (!SOURCES.includes(source)) return [`unknown source: ${source}`];
  if (typeof text !== 'string' || !text.trim()) return ['the query is empty'];
  if (text.length > LIMITS[source]) bad.push(`a ${source} query is ${LIMITS[source]} characters at most (this is ${text.length})`);
  if (/[\n\r]/.test(text)) bad.push('a query is one line');
  if (/https?:\/\//i.test(text)) bad.push('a query holds no link');
  const ops = operatorsOf(text);
  const quotes = (text.match(/"/g) || []).length;
  if (quotes % 2) bad.push('a quote is not closed');
  if (source === 'x') {
    for (const o of ops) {
      if (o.name === 'lang') { if (o.value.toLowerCase() !== 'en') bad.push('X is searched in English only (lang:en)'); }
      else if (o.name === 'filter') { if (!['retweets', 'replies', 'links', 'quote', 'nativeretweets'].includes(o.value.toLowerCase())) bad.push(`X has no filter:${o.value}`); }
      else if (['min_faves', 'min_retweets', 'min_replies'].includes(o.name)) { if (!/^\d+$/.test(o.value)) bad.push(`${o.name} takes a number`); }
      else if (['since', 'until'].includes(o.name)) bad.push(`${o.name}: is added by code from the round's window, leave it out`);
      else if (o.name === 'from' || o.name === 'to') bad.push(`${o.name}: aims at one account, leave it out`);
      else bad.push(`the operator ${o.name}: is not supported by the X search`);
    }
    if (!ops.some((o) => o.name === 'lang' && o.value.toLowerCase() === 'en')) bad.push('X needs lang:en (English only)');
    if (!ops.some((o) => o.name === 'filter' && o.neg && o.value.toLowerCase() === 'retweets')) bad.push('X needs -filter:retweets (no retweets)');
  } else if (source === 'reddit') {
    const allowed = new Set((offer.subreddits || []).map((s) => String(s).replace(/^\/?r\//i, '').toLowerCase()));
    const subs = ops.filter((o) => o.name === 'subreddit');
    for (const o of ops) {
      if (o.name === 'subreddit') { if (!allowed.has(o.value.toLowerCase())) bad.push(`subreddit:${o.value} is not in this offer's list of subreddits`); }
      else if (o.name !== 'title') bad.push(`the operator ${o.name}: is not used for Reddit here (subreddit: and title: only)`);
    }
    if (!subs.length) bad.push('a Reddit query searches inside the offer\'s subreddits: use subreddit:name');
  } else if (source === 'web') {
    if (quotes) bad.push('the web query is a plain description: no quotes');
    if (/[()]/.test(text)) bad.push('the web query is a plain description: no parentheses');
    if (/\b(OR|AND|NOT)\b/.test(text)) bad.push('the web query is a plain description: no OR, AND or NOT');
    if (/(^|\s)-\w/.test(text)) bad.push('the web query is a plain description: no minus operators');
    if (/\b[a-z_]+:\S/i.test(text)) bad.push('the web query is a plain description: no operators');
    if (words(text).length < 6) bad.push('describe the post to find in at least six words');
  } else {
    if (quotes) bad.push(`a ${source} query is key words: no quotes`);
    if (/[()]/.test(text) || /\b(OR|AND|NOT)\b/.test(text)) bad.push(`a ${source} query is key words: no parentheses, OR or AND`);
    if (ops.length || /(^|\s)-\w/.test(text)) bad.push(`a ${source} query is key words: no operators`);
    if (words(text).length > MAX_WORDS[source]) bad.push(`a ${source} query is ${MAX_WORDS[source]} words at most`);
  }
  return [...new Set(bad)];
}

// Every stored query of an offer, checked against that offer. `queries` is {source: text}.
export function checkQueries(queries, offer) {
  const bad = [];
  if (queries === undefined || queries === null) return bad;
  if (typeof queries !== 'object' || Array.isArray(queries)) return ['queries is an object of source to text'];
  for (const [src, text] of Object.entries(queries)) for (const b of checkQuery(src, text, offer)) bad.push(`${src}: ${b}`);
  return bad;
}
