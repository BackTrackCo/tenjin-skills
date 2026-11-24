import * as jobs from './jobs.mjs';

// One small module per supplier, picked by the host the spec text names. Until the router gives each task fixed inputs
// and output shapes, this table is the only place a supplier host appears; it never appears in text people see.
// A need with no adapter here is held for the round and the next attended turn runs it as a Haiku step.
export const SUPPLIERS = [
  { host: jobs.HOST, kind: 'job_postings', mapper: jobs.mapper, adapter: jobs.adapter },
];

export function pickSupplier(specText, kind) {
  const lower = String(specText).toLowerCase();
  for (const s of SUPPLIERS) {
    if (s.kind !== kind) continue;
    // the host the spec names; the envelope's supplier must be this same host after the run
    const m = new RegExp(`[a-z0-9.-]*${s.host}[a-z0-9.-]*`).exec(lower);
    if (m) return { ...s, host: m[0].replace(/\.+$/, '') };
  }
  return null;
}
