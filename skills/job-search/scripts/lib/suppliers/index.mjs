import * as jobs from './jobs.mjs';
import * as x from './x.mjs';
import * as careers from './careers.mjs';
import * as people from './people.mjs';

// One mapper and one adapter per supplier, picked by the host the spec text names. Until the router gives each task fixed
// inputs and output shapes, this table is the only place a supplier host appears; it never appears in text people see.
// A `native` answer (the web search) keeps that need a model step; a need with no adapter here is held for the round.
export const SUPPLIERS = [jobs, x, careers, people].map((m) => ({ host: m.HOST, kind: m.KIND, mapper: m.mapper, adapter: m.adapter }));

export function pickSupplier(specText, kind) {
  const lower = String(specText).toLowerCase();
  for (const s of SUPPLIERS) {
    if (s.kind === kind && lower.includes(s.host)) return { ...s };
  }
  return null;
}
