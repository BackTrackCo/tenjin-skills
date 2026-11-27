import * as x from './x.mjs';
import * as xSearch from './x-search.mjs';
import * as reddit from './reddit.mjs';
import * as linkedinPosts from './linkedin-posts.mjs';
import * as web from './websearch.mjs';
import * as xProfile from './x-profile.mjs';
import * as linkedin from './linkedin.mjs';

// One mapper and one adapter per supplier, picked by the host the router's spec text names. Until the router gives each task
// fixed inputs and output shapes, this table is the only place a supplier host appears; it never appears in text people see.
// A need with no mapper here is held for the round. A supplier marked unrecorded was built from the router's spec, not from a
// recorded answer: its fixture is replaced after the first live round.
export const SUPPLIERS = [x, xSearch, reddit.glim, reddit.anyapi, linkedinPosts, web.exa, xProfile, linkedin.profile, linkedin.history].map((m) => ({ any: m.ANY_HOST === true, host: m.HOST, tool: m.TOOL || null, kind: m.KIND, mapper: m.mapper, adapter: m.adapter || web.adapter, recorded: m.RECORDED !== false, noCache: m.NO_CACHE === true }));

// A need that names a catalog tool by id takes that tool's supplier; the spec text decides nothing.
export function pickTool(tool, kind) {
  const s = SUPPLIERS.find((y) => y.tool === tool && y.kind === kind);
  return s ? { ...s } : null;
}

export function pickSupplier(specText, kind) {
  const lower = String(specText).toLowerCase();
  for (const s of SUPPLIERS) if (s.kind === kind && !s.any && s.host && lower.includes(s.host)) return { ...s };
  // A need with no known seller host: the router picks it, and the answer is checked in code.
  const any = SUPPLIERS.find((s) => s.kind === kind && s.any);
  return any ? { ...any } : null;
}
