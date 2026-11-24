import { boardTarget } from './boards.mjs';

// What code can read from a hiring post's own text, word for word: links, board links, email addresses and the author's
// handle. The model never has to find these, and a lead's contact comes only from here.
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

export const linksIn = (text) => [...new Set((String(text || '').match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, '')))];
export const emailsIn = (text) => [...new Set(String(text || '').match(EMAIL_RE) || [])].filter((e) => !/\.(png|jpe?g|gif|svg)$/i.test(e));
export const isBoardLink = (u) => Boolean(boardTarget([{ url: u }]));
// Every link of the post: the ones its record carries (an X post's expanded entities) and the ones in the text.
export const postLinks = (post) => [...new Set([...(post.links || []), ...linksIn(post.text)])];
export const boardLinksOf = (post) => postLinks(post).filter(isBoardLink);
export const handleOf = (post) => (post.source === 'x' || /^https?:\/\/(x|twitter)\.com\//i.test(post.url || '') ? String(post.author || '').replace(/^@/, '') || null : null);
// What an item gives the review step for one post.
export const postFacts = (post) => ({ url: post.url, author: post.author, text: post.text, boardLinks: boardLinksOf(post), handle: handleOf(post), emails: emailsIn(post.text) });
