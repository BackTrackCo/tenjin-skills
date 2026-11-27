import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_LIB, demoApp, tmpRoot } from './helpers/demo.mjs';

tmpRoot();
const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
const qs = await import(path.join(BASE_LIB, 'questions.mjs'));
const opt = (label) => ({ label, description: 'one line' });
const ask = (over = {}) => ({ questions: [qs.q('Pick', 'Which one?', [opt('First (Recommended)'), opt('Second')], false), ...(over.more || [])] });

test('the tool\'s shape rules: 1 to 4 questions, 2 to 4 options, a short header, the default first with its marker', async () => {
  setApp(await demoApp('alpha'));
  assert.deepEqual(qs.validateAsk(ask()), []);
  assert.deepEqual(qs.validateAsk({ questions: [] }), ['1 to 4 questions per call']);
  assert.deepEqual(qs.validateAsk({ questions: Array(5).fill(ask().questions[0]) }), ['1 to 4 questions per call']);
  assert.match(qs.validateAsk({ questions: [qs.q('A very long header', 'x?', [opt('A (Recommended)'), opt('B')])] })[0], /short header/);
  assert.match(qs.validateAsk({ questions: [qs.q('Pick', 'x?', [opt('A (Recommended)')])] })[0], /2 to 4 options/);
  assert.match(qs.validateAsk({ questions: [qs.q('Pick', 'x?', [opt('A'), opt('B')])] })[0], /carries its marker/);
  assert.match(qs.validateAsk({ questions: [qs.q('Pick', 'x?', [{ label: 'A (Recommended)', description: 'two\nlines' }, opt('B')])] })[0], /one-line description/);
  assert.deepEqual(qs.validateAsk({ questions: [qs.q('Pick', 'x?', [opt('A'), opt('B')], true)] }), [], 'a multi-select has no default');
});

test('no question or option text names the tool\'s own free-text option, and a form\'s own "Other ..." option is fine', async () => {
  setApp(await demoApp('alpha'));
  assert.match(qs.validateAsk({ questions: [qs.q('Pick', 'Type your answer under Other', [opt('A (Recommended)'), opt('B')])] })[0], /names the free-text option/);
  assert.match(qs.validateAsk({ questions: [qs.q('Pick', 'x?', [opt('A (Recommended)'), { label: 'B', description: 'or Other.' }])] })[0], /an option names the free-text option/);
  assert.deepEqual(qs.validateAsk({ questions: [qs.q('Pick', 'x?', [opt('Other job boards (Recommended)'), opt('B')])] }), []);
});

test('the app\'s exceptions apply to its own questions only: headers with no marker, extra markers, and plain first options', async () => {
  const plainAsk = { questions: [qs.q('Missing fact', 'x?', [opt('A'), opt('B')])] };
  const resumeAsk = { questions: [qs.q('Role', 'x?', [opt('Engineer (from your resume)'), opt('B')])] };
  const yesAsk = { questions: [qs.q('Terms', 'x?', [opt('Yes, agree'), opt('No')])] };
  setApp(await demoApp('alpha'));
  assert.equal(qs.validateAsk(plainAsk).length, 1);
  assert.equal(qs.validateAsk(resumeAsk).length, 1);
  setApp(await demoApp('outreach', { questions: { noMarker: ['Missing fact'], markers: ['from your resume'], firstOptionOk: [/^Yes/] } }));
  assert.deepEqual(qs.validateAsk(plainAsk), []);
  assert.deepEqual(qs.validateAsk(resumeAsk), []);
  assert.deepEqual(qs.validateAsk(yesAsk), []);
  assert.equal(qs.validateAsk({ questions: [qs.q('Terms', 'x?', [opt('Maybe'), opt('No')])] }).length, 1);
  assert.deepEqual(qs.plain('say it'), { plain: 'say it' });
});
