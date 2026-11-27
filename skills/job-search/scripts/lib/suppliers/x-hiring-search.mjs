import * as x from './x.mjs';
import { adapter } from './x-search.mjs';

// The hiring posts on X through the X search that leads several reads (tenjin#1097, not merged yet). Same query as the other X supplier.
export const HOST = 'api.getanyapi.com';
export const KIND = 'x_hiring_posts';
export const RECORDED = false;
export const mapper = (f) => { const { query } = x.mapper(f); return { query, queryType: 'Latest' }; };
export { adapter };
