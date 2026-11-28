import * as x from './x.mjs';
import { adapter } from './x-search.mjs';

// Hiring posts on X through the alternate X search supplier. Same query as the other X supplier.
export const HOST = 'api.getanyapi.com';
export const KIND = 'x_hiring_posts';
export const RECORDED = false;
export const mapper = (f) => { const { query } = x.mapper(f); return { query, queryType: 'Latest' }; };
export { adapter };
