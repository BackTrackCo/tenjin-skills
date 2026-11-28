// The input a shipped default mapping builds for a need and a seller host, and the ingest it reads from a result. For tests that check
// one mapping without a router round.
const reader = await import('../../../skills/gtm-loop/scripts/lib/reader.mjs');
const sup = await import('../../../skills/gtm-loop/scripts/lib/suppliers/index.mjs');
export const inputFor = (kind, host, fields) => {
  const d = sup.defaultFor(kind, host);
  return reader.buildInput(d.input, reader.loopInputs(kind, fields));
};
export const readFor = (kind, host, result, fields = {}) => {
  const d = sup.defaultFor(kind, host);
  const r = reader.readResult(kind, { output: d.output }, result, fields);
  if (!r.ok) throw new Error(r.reason);
  return r.ingest;
};
