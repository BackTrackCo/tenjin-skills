import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './helpers/env.mjs';

tmpHome();
const net = await import('../../skills/gtm-loop/scripts/lib/net.mjs');
const open = await import('../../skills/gtm-loop/scripts/lib/open.mjs');
const plat = await import('../../skills/gtm-loop/scripts/lib/platforms.mjs');

test('the guarded fetch refuses x.com, twitter.com, linkedin.com, reddit.com and every subdomain, before any request', async () => {
  let called = 0;
  const fetchImpl = async () => { called++; return { ok: true }; };
  for (const u of ['https://x.com/a/status/1', 'https://twitter.com/a', 'https://mobile.twitter.com/a', 'https://www.linkedin.com/in/a', 'https://reddit.com/r/a', 'https://old.reddit.com/r/a', 'https://redd.it/abc', 'https://x.com./a']) {
    await assert.rejects(() => net.guardedFetch(u, {}, fetchImpl), /never-automated host refused/, u);
  }
  assert.equal(called, 0);
});

test('only the fixed hosts are fetched, over https, with no redirect followed', async () => {
  const seen = [];
  const fetchImpl = async (u, o) => { seen.push([u, o.redirect]); return { ok: true }; };
  await net.guardedFetch('https://hn.algolia.com/api/v1/search?query=a', {}, fetchImpl);
  assert.deepEqual(seen, [['https://hn.algolia.com/api/v1/search?query=a', 'manual']]);
  await assert.rejects(() => net.guardedFetch('https://example.org/x', {}, fetchImpl), /host not allowed/);
  await assert.rejects(() => net.guardedFetch('http://hn.algolia.com/api', {}, fetchImpl), /host not allowed/);
  await assert.rejects(() => net.guardedFetch('https://news.ycombinator.com/item?id=1', {}, fetchImpl), /host not allowed/, 'the HN site is never fetched');
});

test('local and private addresses are refused, by name, by literal and by what a name resolves to', async () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.9', '169.254.169.254', '172.20.1.1', 'foo.internal', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.equal(net.isLocalHost(h) || net.isPrivateAddress(h), true, h);
  assert.equal(net.isLocalHost('example.org'), false);
  await assert.rejects(() => net.assertPublicName('evil.example', async () => [{ address: '10.0.0.5' }]), /private/);
  await assert.rejects(() => net.assertPublicName('gone.example', async () => { throw new Error('nx'); }), /did not resolve/);
  await net.assertPublicName('ok.example', async () => [{ address: '93.184.216.34' }]);
});

test('open takes only X, LinkedIn, Reddit and Hacker News pages over https', () => {
  for (const u of ['https://x.com/a/status/123456', 'https://twitter.com/a', 'https://www.linkedin.com/in/a', 'https://www.reddit.com/r/a/comments/1', 'https://old.reddit.com/r/a', 'https://news.ycombinator.com/item?id=1']) assert.equal(open.checkOpenUrl(u), null, u);
  for (const u of ['https://example.org', 'http://x.com/a', 'https://127.0.0.1/', 'https://user:pw@x.com/', 'https://x.com/a"b', 'javascript:alert(1)', 'nope', 'https://evilx.com/', 'https://x.com.evil.example/']) assert.notEqual(open.checkOpenUrl(u), null, u);
});

test('the open command gets the parsed link as one argument, with Chrome named on macOS, and never a shell', () => {
  const calls = [];
  const spawn = (bin, args, o) => { calls.push({ bin, args, o }); return { status: 0 }; };
  const r = open.openPage('https://x.com/a/status/123456', { spawn, platform: 'darwin', env: {} });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].args, ['-a', 'Google Chrome', 'https://x.com/a/status/123456']);
  assert.equal(calls[0].o.shell, undefined);
  const bad = open.openPage('https://example.org/', { spawn, env: {} });
  assert.equal(bad.ok, false);
  assert.equal(calls.length, 1, 'a refused link starts nothing');
});

test('the default browser is the fallback, and the clipboard text goes through stdin', () => {
  const run = [];
  const spawn = (bin, args, o) => { run.push([bin, o && o.input]); return { status: run.length === 1 ? 1 : 0 }; };
  const r = open.openPage('https://news.ycombinator.com/item?id=5', { spawn, platform: 'darwin', env: {} });
  assert.equal(r.ok, true);
  assert.equal(r.browser, 'default');
  assert.match(r.line, /default browser/);
  const clip = [];
  assert.equal(open.copyToClipboard('hello "quoted" $(rm -rf)', { spawn: (b, a, o) => { clip.push([b, a, o.input]); return { status: 0 }; }, platform: 'darwin', env: {} }), true);
  assert.deepEqual(clip[0], ['pbcopy', [], 'hello "quoted" $(rm -rf)']);
});

test('the X reply link carries the post id and the encoded text; a link with no post id is refused', () => {
  const link = open.xReplyLink('https://x.com/dev_one/status/1900000000000000001', 'Hi & welcome, try it: https://example.org?a=1&b=2');
  const u = new URL(link);
  assert.equal(u.hostname, 'x.com');
  assert.equal(u.searchParams.get('in_reply_to'), '1900000000000000001');
  assert.equal(u.searchParams.get('text'), 'Hi & welcome, try it: https://example.org?a=1&b=2');
  assert.equal(open.checkOpenUrl(link), null);
  assert.throws(() => open.xReplyLink('https://x.com/dev_one', 'x'), /no post id/);
});

test('platform helpers read the site, the post id and the handle', () => {
  assert.equal(plat.platformOf('https://mobile.twitter.com/a/status/1'), 'x');
  assert.equal(plat.platformOf('https://old.reddit.com/r/a'), 'reddit');
  assert.equal(plat.platformOf('https://news.ycombinator.com/item?id=1'), 'hn');
  assert.equal(plat.platformOf('https://example.org'), null);
  assert.equal(plat.handleOfXUrl('https://x.com/Dev_One/status/1'), 'Dev_One');
  assert.equal(plat.handleOfXUrl('https://x.com/i/status/1'), null);
  assert.equal(plat.linkedinSlugOf('https://www.linkedin.com/in/some-one/?x=1'), 'some-one');
});
