import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_LIB } from './helpers/demo.mjs';

const S = (f) => import(path.join(BASE_LIB, 'suppliers', f));
const people = await S('people.mjs');
const posts = await S('person-posts.mjs');
const xs = await S('x-search.mjs');
const shared = await S('posts-shared.mjs');
const company = await S('company.mjs');

test('the people search takes the words for contacts from the app, not from the base', () => {
  assert.deepEqual(people.mapper({ company: 'Acme Placeholder', count: 3 }).pagination, { size: 3 });
  assert.throws(() => people.mapper({}), /no employer website or company name/);
  const res = { success: true, total: 2, leads: [
    { firstname: 'Pat', lastname: 'Placeholder', headline: 'CTO', profileUrl: 'https://www.linkedin.com/in/pat-placeholder', lastJobTitle: 'CTO', lastCompanyName: 'Acme Placeholder', address: 'Berlin, Germany' },
    { firstname: 'Sam', lastname: 'Placeholder', profileUrl: 'https://www.linkedin.com/in/sam-placeholder', lastJobTitle: 'Engineer', lastCompanyName: 'Other Co', address: 'Paris, France' },
  ] };
  const out = people.adapter(res, { city: 'Berlin', names: ['Acme Placeholder'] }, { how: 'a profile', caresFallback: (c) => `work at ${c || 'the company'}` });
  assert.deepEqual(Object.keys(out), ['contacts', 'total', 'found', 'outside', 'city']);
  assert.equal(out.contacts.length, 1);
  assert.equal(out.contacts[0].how, 'a profile');
  assert.equal(out.contacts[0].cares, 'CTO');
  assert.equal(out.outside, 1);
  assert.throws(() => people.adapter({}, {}, { how: 'x', caresFallback: () => '' }), /no leads list/);
});

test('the person-posts reader takes a profile link only, keeps links and a short text, and follows no cursor', () => {
  assert.deepEqual(posts.mapper({ url: 'https://www.linkedin.com/in/pat-placeholder/' }), { url: 'https://www.linkedin.com/in/pat-placeholder/' });
  assert.throws(() => posts.mapper({ url: 'https://example.test/in/x' }), /not a LinkedIn profile link/);
  const r = posts.adapter({ output: { found: true, data: { items: [{ url: 'https://www.linkedin.com/posts/a', text: 'Join us https://example.test/event.', repostText: 'again', createdUtc: 1795567571, articleUrl: 'https://example.test/a' }], nextCursor: 'c2' } } });
  assert.deepEqual(r.posts[0].links, ['https://example.test/event', 'https://example.test/a']);
  assert.equal(r.more, true);
  assert.equal(posts.KIND, undefined, 'the kind is the app\'s to name');
});

test('the X search shape and the shared post helpers', () => {
  const r = xs.adapter({ output: { found: true, data: { items: [{ url: 'https://x.test/p/1', text: 'See https://example.test/e now', authorUsername: 'someone', createdUtc: 1795567571 }], nextCursor: null } } });
  assert.deepEqual(r.posts[0].links, ['https://example.test/e']);
  assert.equal(r.more, false);
  assert.throws(() => xs.adapter({ output: { found: true, data: {} } }), /no items list/);
  assert.equal(shared.isoOfUnix(0), null);
  assert.equal(shared.isoOfUnix(1795567571), new Date(1795567571000).toISOString());
  assert.deepEqual(shared.linksOf('a https://x.test/a, b https://x.test/a'), ['https://x.test/a']);
});

test('the company lookup is called by tool id, kept only in memory, and its answer is read in code', () => {
  assert.equal(company.TOOL, 'companyenrich-properties');
  assert.equal(company.NO_CACHE, true);
  assert.deepEqual(company.mapper({ company: 'Acme Placeholder' }), { name: 'Acme Placeholder' });
  assert.throws(() => company.mapper({}), /no company name/);
  const r = company.adapter({ name: 'Acme Placeholder', domain: 'https://www.acme.example.test/x', socials: { linkedin_url: 'https://www.linkedin.com/company/acme' }, employees: '11-50' }, { jobKey: 'k' });
  assert.deepEqual([r.domain, r.linkedinUrl, r.employees], ['acme.example.test', 'https://www.linkedin.com/company/acme', '11-50']);
});
