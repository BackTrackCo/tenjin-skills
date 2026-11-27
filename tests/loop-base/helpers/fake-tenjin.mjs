// A fake `tenjin mcp` that speaks MCP over stdio, for the router tests. It answers `tools/call request` from a script:
// a JSON file with {answers: [...], hangOn: <call index to never answer>, exitOnInit: bool}. Every call is logged.
import fs from 'node:fs';
import readline from 'node:readline';

const script = JSON.parse(fs.readFileSync(process.env.FAKE_SCRIPT, 'utf8'));
const log = (o) => fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(o)}\n`);
log({ started: process.argv.slice(2), pid: process.pid });
if (script.exitOnInit) process.exit(1);
let n = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') log({ init: msg.params.clientInfo });
  if (msg.method === 'initialize') return process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } })}\n`);
  if (msg.method === 'tools/call') {
    const i = n++;
    log({ call: msg.params.arguments });
    if (script.hangOn === i) return;
    const answer = script.answers[i];
    const { __text, ...env } = answer;
    const content = [{ type: 'text', text: JSON.stringify(env) }, ...(__text ? [{ type: 'text', text: __text }] : [])];
    return process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content } })}\n`);
  }
});
rl.on('close', () => { log({ stdinClosed: true }); process.exit(script.ignoreClose ? 99 : 0); });
if (script.ignoreClose) setInterval(() => {}, 1000); // never exits by itself: the client must kill it
