import * as jobs from './jobs.mjs';
import * as x from './x.mjs';
import * as careers from './careers.mjs';
import * as people from './people.mjs';
import * as linkedin from './linkedin.mjs';
import * as web from './websearch.mjs';

// One mapper and one adapter per supplier, picked by the host the spec text names. Until the router gives each task fixed
// inputs and output shapes, this table is the only place a supplier host appears; it never appears in text people see.
// A `native` answer to the web search holds that need for the round (with Tenjin it never becomes a model step); a need
// with no mapper here is held for the round. A mapper marked unrecorded was built from the router's spec, not a recorded answer.
export const SUPPLIERS = [jobs, x, careers, people, linkedin, web.agentsearch, web.brave].map((m) => ({ host: m.HOST, kind: m.KIND, mapper: m.mapper, adapter: m.adapter || web.adapter, recorded: m.RECORDED !== false, noCache: m.NO_CACHE === true }));

export function pickSupplier(specText, kind) {
  const lower = String(specText).toLowerCase();
  for (const s of SUPPLIERS) {
    if (s.kind === kind && lower.includes(s.host)) return { ...s };
  }
  return null;
}
