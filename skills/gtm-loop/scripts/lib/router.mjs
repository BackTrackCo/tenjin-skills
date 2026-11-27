import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findTenjin } from './tenjin.mjs';
import { ensureDir, stateDir } from './paths.mjs';
import { pickSupplier, pickTool } from './suppliers/index.mjs';

// The one file that spawns `tenjin mcp`: a small JSON-RPC client over stdio, no dependency. Each need goes to the
// router's own `request` tool in two steps: the need as text (the answer is a spec that names a supplier), then the
// run with `{id, input}`. The router picks the seller and applies the person's limits and needs_approval; the skill
// adds no money rule. Only a `fulfilled` envelope delivers; every other status holds that search with its reason.
// shutdown: `tenjin mcp` starts a routing top-up each time and, once stdin closes, waits up to 30 s for a deposit in flight to settle;
// killing it earlier would cut that deposit off. collect and poll: a paid answer that is still running is asked for, free, until it settles.
export const TIMEOUTS = { initialize: 30_000, query: 30_000, run: 120_000, shutdown: 35_000, collect: 60_000, poll: 3_000 };

export class RouterClient {
  constructor({ bin = findTenjin(), spawn = nodeSpawn, timeouts = TIMEOUTS } = {}) {
    this.bin = bin;
    this.spawn = spawn;
    this.timeouts = timeouts;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.proc = null;
  }

  // One `tenjin mcp` process per round: spawned when the round's routed needs start.
  async start() {
    if (!this.bin) throw new RouterError('tenjin_missing', 'Tenjin is not installed');
    this.proc = this.spawn(this.bin, ['mcp'], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.dead = null;
    const die = (err) => { this.dead = this.dead || err; this.failAll(err); };
    this.proc.on('error', (e) => die(new RouterError('wallet_unavailable', `tenjin mcp could not start: ${e.message}`)));
    this.proc.on('exit', () => die(new RouterError('wallet_unavailable', 'tenjin mcp exited')));
    if (typeof this.proc.stdout.setEncoding === 'function') this.proc.stdout.setEncoding('utf8'); // a character split across two chunks stays whole
    this.proc.stdout.on('data', (d) => this.onData(typeof d === 'string' ? d : d.toString('utf8')));
    await this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gtm-loop', version: '0.1.0' } }, this.timeouts.initialize);
    this.notify('notifications/initialized', {});
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RouterError('rpc_error', msg.error.message || 'rpc error'));
      else p.resolve(msg.result);
    }
  }

  failAll(err) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  send(obj) {
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }
  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }
  rpc(method, params, timeoutMs) {
    // Once the process is gone every later call answers at once: nothing waits out a timeout for a server that left.
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RouterError('timeout', `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  // `request` with the given arguments. The tool answers the envelope as JSON in one text block, and for a spec the
  // supplier's text (its host, inputs and return shape) in another; the text is kept as `__text`.
  async request(args, timeoutMs) {
    const r = await this.rpc('tools/call', { name: 'request', arguments: args }, timeoutMs);
    const blocks = (r.content || []).map((c) => c.text || '');
    let env = r.structuredContent || null;
    const rest = [];
    for (const b of blocks) {
      if (!env) {
        try {
          env = JSON.parse(b);
          continue;
        } catch {}
      }
      rest.push(b);
    }
    if (!env || typeof env !== 'object') throw new RouterError('parse_failure', 'the router answered something that is not JSON');
    if (rest.length) env.__text = rest.join('\n');
    return env;
  }

  // stdin closes, and the process is killed only if it has not exited after the shutdown time (35 s, past the 30 s `tenjin mcp` may
  // need to finish a routing deposit): no server stays running, and no deposit is cut off.
  async close() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.failAll(new RouterError('closed', 'closed'));
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
      const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} finish(); }, this.timeouts.shutdown);
      proc.once('exit', finish);
      try { proc.stdin.end(); } catch { finish(); }
    });
  }
}

export class RouterError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Runs one need. Returns {ok, status, ingest, cost, reason}. Never sends the same request twice; never retries.
export async function runNeed(client, need, { save = saveResult } = {}) {
  // A need that names a catalog tool by id (the board search) asks `{tool}` for a fresh spec and offer id: no routing decision,
  // so no `native` answer and no other seller. Every other need goes as text and the router picks the seller.
  let spec;
  try {
    spec = await client.request(need.tool ? { tool: need.tool } : { query: need.text }, client.timeouts.query);
  } catch (e) {
    return held(need, e.code || 'failed', e.message);
  }
  if (spec.status !== 'spec') return held(need, spec.status || 'no_spec', spec.reason || `the router answered ${spec.status || 'nothing'} to the need`, spec);
  const offer = spec.id; // the spec answer carries the offer id at the top level; it pays once
  const text = JSON.stringify(spec);
  const sup = need.tool ? pickTool(need.tool, need.kind) : pickSupplier(text, need.kind);
  if (!offer || !sup) return held(need, 'no_adapter', 'no known supplier in the spec; the next attended turn runs this search as the Haiku step');
  let input;
  try {
    input = sup.mapper(need.fields);
  } catch (e) {
    return held(need, 'no_input', e.message);
  }
  let env;
  try {
    env = await client.request({ id: offer, input }, client.timeouts.run);
  } catch (e) {
    // A timed-out run is never sent again in this round: the payment may have settled.
    return held(need, e.code || 'failed', e.message);
  }
  // A paid answer that is still running is asked for with the free `{job}` check until it settles; it is never paid for twice.
  if (env.status === 'running' && env.job) env = await collect(client, env);
  // A `failed` answer that says the provider rejected the input before any payment is the mapper's bug: hold it, never resend.
  if (env.status !== 'fulfilled') return held(need, env.status || 'failed', env.reason ? `the router answered ${env.status}: ${env.reason}` : `the router answered ${env.status}`, env);
  if (!sup.any && String(env.supplier || '').toLowerCase() !== sup.host) return held(need, 'supplier_mismatch', 'the envelope names a different supplier than the spec');
  let result;
  try {
    result = typeof env.result === 'string' ? JSON.parse(env.result) : env.result;
  } catch {
    return held(need, 'parse_failure', 'the result does not parse');
  }
  // A supplier whose terms allow immediate use only is never saved: the result stays in memory and goes to the adapter.
  const fullResultPath = sup.noCache ? null : save(need.kind, typeof env.result === 'string' ? env.result : JSON.stringify(env.result));
  let adapted;
  try {
    adapted = sup.adapter(result, need.fields);
  } catch (e) {
    return held(need, 'schema_failure', e.message);
  }
  const cost = Array.isArray(env.cost) ? env.cost.join('; ') : env.cost === undefined ? null : env.cost; // e.g. ["provider price 0.003 USD"]
  return { ok: true, status: 'fulfilled', cost, ingest: { need: need.kind, query: need.query, status: 'fulfilled', fullResultPath, cost, ...adapted } };
}

const held = (need, status, reason, env) => ({ ok: false, status, reason: status === 'running' && env && env.job ? `${reason} (job ${env.job}: check it with tenjin, it is already paid)` : reason, need: need.kind, jobId: env && env.job, cost: null });

async function collect(client, first) {
  const { collect: total = 60_000, poll = 3_000 } = client.timeouts;
  const until = Date.now() + total;
  let env = first;
  while (env.status === 'running' && env.job && Date.now() < until) {
    await new Promise((r) => setTimeout(r, poll));
    try {
      env = await client.request({ job: first.job }, client.timeouts.query);
    } catch {
      break;
    }
  }
  return env;
}

// `result` is the provider's JSON, kept as data in the state folder for the ingest file to point at.
export function saveResult(kind, text) {
  const dir = ensureDir(path.join(stateDir(), 'results'));
  const file = path.join(dir, `${kind}-${Date.now()}.json`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

// A whole round: one process, the needs one at a time, then shutdown. The caller ingests each ok result.
export async function runRound(needs, { client = new RouterClient(), save, onResult = null } = {}) {
  const out = [];
  try {
    await client.start();
  } catch (e) {
    await client.close();
    return needs.map((n) => held(n, e.code === 'tenjin_missing' ? 'tenjin_missing' : 'wallet_unavailable', e.message));
  }
  try {
    for (const need of needs) {
      const r = await runNeed(client, need, { save });
      out.push(r);
      if (onResult) await onResult(need, r); // the caller keeps a paid result at once, before the next need is started
    }
  } finally {
    await client.close();
  }
  return out;
}
