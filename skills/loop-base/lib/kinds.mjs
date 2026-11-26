import { getApp } from './app.mjs';

// Item kinds: an app declares each kind of item it keeps, e.g. kinds: { job: { collection, statuses, transitions, terminal, onTransition } }.
// The base owns the one rule that moves an item between statuses: only a declared transition lands, and a final status never moves on.
export function kinds() {
  const k = getApp().kinds;
  if (!k || typeof k !== 'object') throw new Error(`the app ${getApp().name} has not declared its item kinds`);
  return k;
}

export function kindOf(name) {
  const spec = kinds()[name];
  if (!spec) throw new Error(`unknown item kind: ${name}`);
  return spec;
}

export const collectionOf = (name) => kindOf(name).collection;
export const isTerminal = (name, status) => (kindOf(name).terminal || []).includes(status);

// Moves one item of a kind to a new status. The refusal names the kind when the app declares more than one, and the error always carries
// it as `kind`. `onTransition` runs once per landed transition, after the status is set, with everything it needs.
export function transition(state, name, item, to, op = {}) {
  const spec = kindOf(name);
  const from = item.status;
  const allowed = (spec.transitions || {})[from] || [];
  const final = (spec.terminal || []).includes(from);
  if (final || !(spec.statuses || []).includes(to) || !allowed.includes(to)) {
    const named = Object.keys(kinds()).length > 1 ? ` (${name})` : '';
    const err = new Error(`illegal transition ${from} -> ${to}${named}`);
    err.kind = name;
    throw err;
  }
  item.status = to;
  if (typeof spec.onTransition === 'function') spec.onTransition({ state, item, from, to, op, kind: name });
  return item;
}
