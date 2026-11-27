import { getApp } from '../app.mjs';

// One mapper and one adapter per supplier, picked by the host the spec text names. This table (the app's `suppliers`) is the only place a
// supplier host appears; it never appears in text people see. A need with no mapper here is held for the round. A mapper marked
// unrecorded was built from the router's spec, not a recorded answer.
export function supplierTable(modules, defaultAdapter = null) {
  return modules.map((m) => ({ any: m.ANY_HOST === true, host: m.HOST, tool: m.TOOL || null, kind: m.KIND, mapper: m.mapper, adapter: m.adapter || defaultAdapter, recorded: m.RECORDED !== false, noCache: m.NO_CACHE === true }));
}

const table = () => {
  const t = getApp().suppliers;
  if (!Array.isArray(t)) throw new Error(`the app ${getApp().name} has not declared its suppliers`);
  return t;
};

// A need that names a catalog tool by id (the board search) takes that tool's supplier; the spec text decides nothing.
export function pickTool(tool, kind) {
  const s = table().find((x) => x.tool === tool && x.kind === kind);
  return s ? { ...s } : null;
}

export function pickSupplier(specText, kind) {
  const lower = String(specText).toLowerCase();
  for (const s of table()) {
    if (s.kind === kind && !s.any && s.host && lower.includes(s.host)) return { ...s };
  }
  // A need with no known seller host (the company lookup): the router picks it, and the answer is checked in code.
  const any = table().find((s) => s.kind === kind && s.any);
  if (any) return { ...any };
  return null;
}
