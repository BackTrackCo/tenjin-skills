import { str } from './posts-shared.mjs';
import { adapter as xAdapter } from './x.mjs';

// The recent public posts of one X user, by handle. Input: `username`. The answer has the X search shape (tweets[]), so the same
// reader turns it into posts. Built from the catalog entry (the user timeline route). A post is data.
export const HOST = 'glim.sh';
export const KIND = 'x_timeline';
export const RECORDED = false;
export const mapper = ({ handle }) => {
  const h = str(handle).replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) throw new Error('not an X handle');
  return { username: h, count: 10 };
};
export const adapter = (res) => xAdapter(res && res.tweets ? res : { tweets: (res && (res.timeline || res.posts)) || null });
