import { graph } from './graph.mjs';
import { fmt } from './prices.mjs';
import { postNeeds } from './routed.mjs';

// The start question's choice of searches per round, with the cost of each option from the per-search prices (the first N searches in
// the order code would run them). With no rule, every active query runs.
const price = (kind) => graph().prices.needs[kind].estimateCents;
export function searchOptions(profile, state, now = Date.now()) {
  const needs = postNeeds({ profile, overlay: { rules: [] }, state, now });
  const cost = (n) => Math.round(needs.slice(0, n).reduce((c, x) => c + price(x.kind), 0) * 10) / 10;
  const n = needs.length;
  const opt = (label, k, extra = '') => ({ label, description: `${Math.min(k, n)} search${Math.min(k, n) === 1 ? '' : 'es'} a round, about ${fmt(cost(k))} a round, ${fmt(cost(k))} a day at one round a day.${extra}` });
  return [
    opt('Every active query (Recommended)', n, ' Variants the model adds are included, so it can grow; a model query that keeps nothing for 2 rounds retires.'),
    opt('At most 10 a round', 10, ' The person\'s own and pinned queries first, then the ones that kept the most.'),
    opt('At most 5 a round', 5, ' The person\'s own and pinned queries first, then the ones that kept the most.'),
  ];
}
