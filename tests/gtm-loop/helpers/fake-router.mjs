import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-tenjin.mjs');

// A `tenjin` on a temp path that is the fake MCP server over stdio. Nothing here calls the real Tenjin or the real router.
export function fake(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faketenjin-'));
  const sf = path.join(dir, 'script.json');
  const lf = path.join(dir, 'log.jsonl');
  fs.writeFileSync(sf, JSON.stringify(script));
  const bin = path.join(dir, 'tenjin');
  fs.writeFileSync(bin, `#!/bin/sh\nFAKE_SCRIPT="${sf}" FAKE_LOG="${lf}" exec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const log = () => (fs.existsSync(lf) ? fs.readFileSync(lf, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { bin, log, calls: () => log().filter((l) => l.call).map((l) => l.call) };
}

// The two answers a routed need gets: the spec (it names a supplier host and carries an offer id) and the fulfilled run.
export const specAnswer = (host, id = '00000000-0000-4000-8000-000000000001') => ({ status: 'spec', id, nextStep: `A search, $0.005, through ${host}: call request({id: "${id}", input: {...}}).`, __text: `Supplier ${host}. Inputs: query.` });
export const runAnswer = (host, result, extra = {}) => ({ status: 'fulfilled', supplier: host, cost: ['provider price 0.005 USD'], result: JSON.stringify(result), ...extra });

// One router client for a test that runs several phases, each phase being one `tenjin mcp` process: phase n answers from scripts[n].
export function seqClient(RouterClient, TIMEOUTS, scripts) {
  const fakes = scripts.map((s) => fake(s));
  let i = 0;
  const c = new RouterClient({ bin: fakes[0] ? fakes[0].bin : null, timeouts: { ...TIMEOUTS, shutdown: 500, collect: 40, poll: 10 } });
  const start = c.start.bind(c);
  c.start = async () => { c.bin = (fakes[i++] || fakes[fakes.length - 1]).bin; return start(); };
  c.fakes = fakes;
  return c;
}
