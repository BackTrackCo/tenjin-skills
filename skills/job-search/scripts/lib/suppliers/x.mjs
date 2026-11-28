// The X search supplier (recorded 2026-11-24). Input: `query` is keywords plus operators, not a sentence, and `sort` is its
// own field. Result: {count, has_more, next_cursor, tweets[]}, each tweet with url, text, created_at, author.username and
// entities.urls[].expanded_url.
export const HOST = 'glim.sh';
export const KIND = 'x_hiring_posts';

const shortPlace = (place) => {
  const w = String(place).split(/[\s,]+/).filter(Boolean);
  return w.length >= 2 && w.length <= 4 ? w.map((x) => x[0].toUpperCase()).join('') : null;
};

export function mapper({ role, place, since }) {
  const where = place ? ` ("${place}"${shortPlace(place) ? ` OR ${shortPlace(place)}` : ''})` : '';
  return { query: `hiring "${role}"${where}${since ? ` since:${since}` : ''}`, sort: 'latest' };
}

const str = (v) => (typeof v === 'string' ? v : '');
export function adapter(result) {
  if (!result || !Array.isArray(result.tweets)) throw new Error('the result has no tweets list');
  const posts = result.tweets.map((t) => {
    if (!str(t.url) || !str(t.text)) throw new Error('a tweet has no url or text');
    return {
      url: t.url, author: str(t.author && t.author.username), postedAt: str(t.created_at) || null, text: t.text.slice(0, 1000),
      links: ((t.entities && t.entities.urls) || []).map((u) => str(u.expanded_url)).filter(Boolean), source: 'x',
    };
  });
  return { posts };
}
