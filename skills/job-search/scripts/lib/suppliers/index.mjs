import * as jobs from './jobs.mjs';
import * as x from './x.mjs';
import * as careers from './careers.mjs';
import * as people from './people.mjs';
import * as linkedin from './linkedin.mjs';
import * as linkedinHistory from './linkedin-history.mjs';
import * as web from './websearch.mjs';
import * as eventsWeb from './events-web.mjs';
import * as eventsX from './events-x.mjs';
import * as eventsLinkedin from './events-linkedin.mjs';
import * as eventsPeople from './events-people.mjs';
import * as xHiringSearch from './x-hiring-search.mjs';
import * as eventsXSearch from './events-x-search.mjs';
import * as company from './company.mjs';

// One mapper and one adapter per supplier, picked by the host the spec text names. Until the router gives each task fixed
// inputs and output shapes, this table is the only place a supplier host appears; it never appears in text people see.
// A need with no mapper here is held for the round. A mapper marked unrecorded was built from the router's spec, not a recorded answer.
export const SUPPLIERS = [jobs, x, careers, people, linkedin, linkedinHistory, web.exa, eventsWeb, eventsX, eventsLinkedin, eventsPeople, xHiringSearch, eventsXSearch, company].map((m) => ({ any: m.ANY_HOST === true, host: m.HOST, tool: m.TOOL || null, kind: m.KIND, mapper: m.mapper, adapter: m.adapter || web.adapter, recorded: m.RECORDED !== false, noCache: m.NO_CACHE === true }));

// A need that names a catalog tool by id (the board search) takes that tool's supplier; the spec text decides nothing.
export function pickTool(tool, kind) {
  const s = SUPPLIERS.find((x) => x.tool === tool && x.kind === kind);
  return s ? { ...s } : null;
}

export function pickSupplier(specText, kind) {
  const lower = String(specText).toLowerCase();
  for (const s of SUPPLIERS) {
    if (s.kind === kind && !s.any && s.host && lower.includes(s.host)) return { ...s };
  }
  // A need with no known seller host (the company lookup): the router picks it, and the answer is checked in code.
  const any = SUPPLIERS.find((s) => s.kind === kind && s.any);
  if (any) return { ...any };
  return null;
}
