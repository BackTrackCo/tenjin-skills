import * as ex from './events-x.mjs';
import { adapter } from './x-search.mjs';

// The event posts on X through the X search that leads several reads (tenjin#1097, not merged yet). Same query as the other X supplier.
export const HOST = 'api.getanyapi.com';
export const KIND = 'event_posts_x';
export const RECORDED = false;
export const mapper = (f) => { const { query } = ex.mapper(f); return { query, queryType: 'Latest' }; };
export { adapter };
