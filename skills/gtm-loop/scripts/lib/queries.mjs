// A phrase is how a buyer would write a post: first person and short. Code turns it into the query shape each source takes: a few
// key words, plus the operators that source supports. Nothing sends the phrase as it is.
const STOP = new Set(['i', 'im', "i'm", 'me', 'my', 'mine', 'we', 'our', 'us', 'you', 'your', 'he', 'she', 'it', "it's", 'its', 'they', 'them', 'their', 'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'for', 'in', 'on', 'at', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'how', 'what', 'why', 'when', 'where', 'which', 'who', 'anyone', 'anybody', 'someone', 'any', 'with', 'that', 'this', 'so', 'no', 'not', 'can', 'could', 'would', 'should', 'get', 'got', 'just', 'have', 'has', 'had', 'there', 'than', 'then', 'about', 'from', 'as', 'if', 'out']);

export const MAX_PHRASE_WORDS = 10;
export const wordsIn = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);

export function keywords(phrase, max = 4) {
  const seen = new Set();
  const out = [];
  for (const raw of String(phrase || '').toLowerCase().replace(/[^a-z0-9'\s-]/g, ' ').split(/\s+/)) {
    const w = raw.replace(/^['-]+|['-]+$/g, '');
    if (!w || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out.length ? out : wordsIn(phrase).slice(0, max).map((w) => w.toLowerCase());
}
export const kw = (phrase, max) => keywords(phrase, max).join(' ');

// X: key words, English only, no retweets, no replies, no link-only posts (the operators the X search supports).
export const xQuery = (phrase) => `${kw(phrase, 3)} lang:en -filter:retweets -filter:replies -filter:links`;
export const hnQuery = (phrase) => kw(phrase, 3);
export const redditQuery = (phrase) => kw(phrase, 4);
export const linkedinQuery = (phrase) => kw(phrase, 4);
export const webQuery = (phrase) => kw(phrase, 5);

// A post that is only links, or a title and a link, is not someone asking. Few words left once the links are removed.
export const MIN_WORDS_NO_LINKS = 4;
export const wordsWithoutLinks = (text) => wordsIn(String(text || '').replace(/https?:\/\/\S+/gi, ' ').replace(/[@#]\w+/g, ' ')).filter((w) => /[a-z0-9]/i.test(w)).length;
export const linkOnly = (text) => wordsWithoutLinks(text) < MIN_WORDS_NO_LINKS;

// Discussion pages: forums, community Q&A, Hacker News, Reddit, Indie Hackers and the like. A guide or a vendor page is not one.
export const DISCUSSION_HOSTS = ['news.ycombinator.com', 'reddit.com', 'indiehackers.com', 'stackoverflow.com', 'stackexchange.com', 'quora.com', 'dev.to', 'lobste.rs', 'producthunt.com', 'community.openai.com', 'discuss.huggingface.co', 'github.com', 'lemmy.world'];
const FORUM_HOST = /^(forum|forums|community|discuss|discourse|answers|ask|talk|groups|board)\./i;
const FORUM_PATH = /\/(t|topic|topics|thread|threads|forum|forums|discuss|discussion|discussions|questions?|question|comments|c|d|post|posts|status)\//i;
export function isDiscussion(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const h = u.hostname.toLowerCase().replace(/^www\./, '');
  if (DISCUSSION_HOSTS.some((d) => h === d || h.endsWith(`.${d}`))) {
    if (h === 'github.com') return /\/(issues|discussions)\/\d+/.test(u.pathname);
    return true;
  }
  return FORUM_HOST.test(h) || FORUM_PATH.test(u.pathname);
}
export const subredditOf = (url) => (/reddit\.com\/r\/([^/?#]+)/i.exec(String(url)) || [])[1]?.toLowerCase() || null;
