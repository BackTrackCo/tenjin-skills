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

// The ask keeps its shape in the query: the markers of a request, quoted and OR'd together, then the topic words. Key words alone match
// the people who sell or teach the topic.
export const ASK_MARKERS = ['any recommendations', 'looking for', 'how do you', 'has anyone', 'struggling to'];
// X: the ask markers, key words, English only, no retweets, no replies, no link-only posts, and negation of the sellers' own words
// (the operators the X search supports: bare words all match, alternatives join with OR in parentheses).
// The fallback is loose on purpose: a seller that finds nothing teaches nothing. At most the markers OR the key words, English only,
// no link-only posts; the ask-shape filter and the review do the rest. It is marked untested live in the report.
export const xQuery = (phrase) => `(${ASK_MARKERS.map((m) => `"${m}"`).join(' OR ')} OR (${kw(phrase, 3)})) lang:en -filter:links`;
export const hnQuery = (phrase) => kw(phrase, 3);
// Reddit: the topic words; the subreddit list is added as `subreddit:` operators by the mapper.
export const redditQuery = (phrase) => kw(phrase, 3);
export const linkedinQuery = (phrase) => kw(phrase, 4);
export const webQuery = (phrase) => kw(phrase, 5);
// The web source reads meaning, not key words: a plain description of the post to find, from the phrase and who the offer is for.
// No quotes, no operators.
export function webDescription(offer, phrase) {
  const plain = (t) => String(t || '').replace(/["'`()\[\]{}]/g, ' ').replace(/\b(?:OR|AND)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const ask = plain(phrase).replace(/[?.!]+$/, '');
  const who = plain(offer && offer.who);
  return `A forum, Q&A or community post where someone asks: ${ask}?${who ? ` The person asking is one of: ${who}, looking for help.` : ' The person asking is looking for help.'}`.slice(0, 400);
}

// The shape of an ask, checked on the post's own text before review: a question mark, or a first-person request marker. A post with
// neither is an announcement, a pitch or news, not a person asking.
export const REQUEST_MARKERS = [
  /\bi(?:'m| am)?\s+(?:looking|searching|trying|struggling|stuck|wondering|curious|hoping)\b/i,
  /\bwe(?:'re| are)?\s+(?:looking|searching|trying|struggling|stuck)\b/i,
  /\bi\s+(?:need|want|wish|can't|cannot|don't know|have no idea|would like|'d like)\b/i,
  /\bwe\s+(?:need|want|wish)\b/i,
  /\b(?:any|some)\s+(?:recommendations?|advice|tips|suggestions|ideas|pointers|help)\b/i,
  /\b(?:has|does|did|can|could|would)\s+(?:anyone|anybody|someone)\b/i,
  /\banyone\s+(?:know|have|using|used|tried|else|got|found|here|success)\b/i,
  /\bhow\s+(?:do|did|can|should|would|could)\s+(?:i|you|we|people|folks)\b/i,
  /\b(?:help me|please help|need help|recommend me|what do you use|what should i|which should i|is there (?:a|any)|are there any)\b/i,
  /\bstruggling\b/i,
  /\b(?:looking for|searching for|in need of|need (?:a|an|to|some|help|advice)|wish (?:my|i|we|there))\b/i,
];
// A question counts when one short sentence ending in a question mark speaks in the first person or asks for a recommendation: a
// rhetorical or marketing question ("Ready to grow your business?") does not. An ask is short; an essay is not an ask.
export const MAX_ASK_CHARS = 700;
const ASKER = /\b(i|i'm|i've|i'd|my|me|we|we're|our|anyone|anybody|someone|recommend\w*|suggest\w*|advice|tips|best way|how (?:do|can|should|to)|what (?:do|should|are your)|which)\b/i;
const questionAsked = (t) => t.split(/(?<=[.!?\n])\s+/).some((sent) => sent.trim().endsWith('?') && wordsIn(sent).length <= 30 && ASKER.test(sent));
export const isAsk = (text) => {
  const t = String(text || '');
  if (t.length > MAX_ASK_CHARS) return false;
  return questionAsked(t) || REQUEST_MARKERS.some((re) => re.test(t));
};

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
