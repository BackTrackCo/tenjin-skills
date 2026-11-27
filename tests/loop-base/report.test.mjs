import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_LIB, demoApp, tmpRoot } from './helpers/demo.mjs';

tmpRoot();
const { setApp } = await import(path.join(BASE_LIB, 'app.mjs'));
const report = await import(path.join(BASE_LIB, 'report.mjs'));
const NOW = Date.parse('2026-11-26T12:00:00Z');
const state = { updateLines: ['u1', 'u2', 'u3', 'u4'], consentLog: [{ at: '2026-11-26T10:30:00Z', what: 'consent recorded' }, { at: '2026-11-25T10:30:00Z', what: 'old one', acked: true }] };
const overlay = { rules: [{ id: 'r1', date: '2026-11-20', words: 'no Acme', effect: 'exclude_company', value: 'Acme' }, { id: 'r2', date: '2026-11-25', words: 'five a day', effect: 'daily_max', value: 5 }], lessons: [{ text: 'Things on a.test go last.', expires: '2026-12-01T00:00:00Z', id: 'l1' }, { text: 'gone', expires: '2026-11-01T00:00:00Z', id: 'l2' }] };
const alpha = (ctx) => [[`# Alpha report, ${new Date(ctx.now).toISOString().slice(0, 10)}`, '', ctx.short ? 'short body' : 'full body'], { shared: 'rules' }, { shared: 'lessons' }, ['', 'alpha middle'], { shared: 'updates' }, { shared: 'consent' }, ['', 'end'] ];
const outreach = () => [['# Outreach report', ''], ['two signals'], { shared: 'consent' }];

test('an app that declared no report sections fails with a clear error, and an unknown segment is refused', async () => {
  setApp(await demoApp('alpha'));
  assert.throws(() => report.renderReport(state, overlay), /has not declared its report sections/);
  setApp(await demoApp('alpha', { report: { sections: () => [{ shared: 'nope' }] } }));
  assert.throws(() => report.renderReport(state, overlay), /unknown report segment/);
});

test('the app\'s sections and the shared ones appear in the app\'s order, in your words, only the live lessons, the last three updates and the unacknowledged consents', async () => {
  setApp(await demoApp('alpha', { report: { sections: alpha, ruleText: (r) => `${r.effect}!` } }));
  const text = report.renderReport(state, overlay, { now: NOW, profile: {} });
  assert.deepEqual(text.split('\n'), [
    '# Alpha report, 2026-11-26', '', 'full body',
    '', '## Rules (your words)', '- 2026-11-20: "no Acme" (exclude_company!) id r1', '- 2026-11-25: "five a day" (daily_max!) id r2',
    '', '## Lessons the skill learned (they only make it more careful)', '- Things on a.test go last. Expires 2026-12-01. id l1',
    '', 'alpha middle',
    '', '## Updates', '- u2', '- u3', '- u4',
    '', '## Consent changes (check that each one was yours)', '- 2026-11-26 10:30: consent recorded. Say so if this was not you; `consent revoke` undoes it.',
    '', 'end',
  ]);
  const short = report.renderReport(state, overlay, { now: NOW, short: true });
  assert.match(short, /short body/);
  assert.match(short, /- 2026-11-26 10:30: consent recorded\.$/m, 'the short report leaves out the undo hint');
});

test('the rules section follows `since`, and a section with nothing to say adds nothing', async () => {
  setApp(await demoApp('alpha', { report: { sections: alpha } }));
  const text = report.renderReport({ updateLines: [], consentLog: [] }, { rules: [overlay.rules[0], overlay.rules[1]], lessons: [] }, { now: NOW, since: '2026-11-24T00:00:00Z' });
  assert.match(text, /five a day/);
  assert.doesNotMatch(text, /no Acme/);
  assert.match(text, /exclude_company \{|daily_max 5/, 'the default words for a rule');
  const bare = report.renderReport({}, { rules: [], lessons: [] }, { now: NOW });
  assert.equal(bare, ['# Alpha report, 2026-11-26', '', 'full body', '', 'alpha middle', '', 'end'].join('\n'));
});

test('a second app renders its own sections with the same shared ones', async () => {
  setApp(await demoApp('outreach', { report: { sections: outreach } }));
  assert.equal(report.renderReport(state, overlay, { now: NOW }), ['# Outreach report', '', 'two signals', '', '## Consent changes (check that each one was yours)', '- 2026-11-26 10:30: consent recorded. Say so if this was not you; `consent revoke` undoes it.'].join('\n'));
});
