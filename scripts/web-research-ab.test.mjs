import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSectionReplies, extractSectionUrls, moneyFiguresNear, pageHasFigure, compensationParameters, cohortKey } from './web-research-ab.mjs';

const begin = id => `BEGIN COMPENSATION RESEARCH ${id}`;
const end = id => `END COMPENSATION RESEARCH ${id}`;
const section = (id, body) => `${begin(id)}\n${body}\n${end(id)}`;

test('mergeSectionReplies labels both source sets when native and Tavily both answered', () => {
  const merged = mergeSectionReplies({
    ids: ['c1'],
    replies: { native: section('c1', 'native body'), tavily: section('c1', 'tavily body') },
    begin, end,
  });
  assert.equal(merged, `${begin('c1')}\nSOURCE SET A (built-in web search):\nnative body\n\nSOURCE SET B (Tavily search):\ntavily body\n${end('c1')}`);
});

test('mergeSectionReplies keeps a single available body unchanged and returns null when nothing was answered', () => {
  const nativeOnly = mergeSectionReplies({ ids: ['c1'], replies: { native: section('c1', 'native body'), tavily: null }, begin, end });
  assert.equal(nativeOnly, section('c1', 'native body'));
  const tavilyOnly = mergeSectionReplies({ ids: ['c1'], replies: { native: section('c1', '   '), tavily: section('c1', 'tavily body') }, begin, end });
  assert.equal(tavilyOnly, section('c1', 'tavily body'));
  assert.equal(mergeSectionReplies({ ids: ['c1'], replies: {}, begin, end }), null);
  assert.equal(mergeSectionReplies({ ids: [], replies: { native: section('c1', 'x') }, begin, end }), null);
});

test('mergeSectionReplies matches ids by exact marker line, so c1 never consumes c10', () => {
  const replies = {
    native: `${section('c1', 'first native')}\n${section('c10', 'tenth native')}`,
    tavily: `${section('c1', 'first tavily')}\n${section('c10', 'tenth tavily')}`,
  };
  const merged = mergeSectionReplies({ ids: ['c1', 'c10'], replies, begin, end });
  assert.equal(merged, [
    `${begin('c1')}\nSOURCE SET A (built-in web search):\nfirst native\n\nSOURCE SET B (Tavily search):\nfirst tavily\n${end('c1')}`,
    `${begin('c10')}\nSOURCE SET A (built-in web search):\ntenth native\n\nSOURCE SET B (Tavily search):\ntenth tavily\n${end('c10')}`,
  ].join('\n'));
  assert.ok(!merged.includes('tenth native\n\nSOURCE SET B (Tavily search):\nfirst tavily'));
});

test('mergeSectionReplies drops ids that neither reply answered and keeps the requested order', () => {
  const merged = mergeSectionReplies({
    ids: ['c2', 'c1'],
    replies: { native: `${section('c1', 'one')}\n${section('c2', 'two')}`, tavily: null },
    begin, end,
  });
  assert.equal(merged, `${section('c2', 'two')}\n${section('c1', 'one')}`);
});

test('extractSectionUrls unwraps markdown links and strips trailing punctuation, deduplicated in order', () => {
  const body = [
    'See [the Ashby posting](https://jobs.ashbyhq.com/acme/), then <https://example.com/roles/1?team=pay> for details.',
    'A bare URL ends a sentence: https://example.com/roles/1?team=pay.',
    'Quoted "https://example.com/a(b)" and bracketed [https://example.com/c]',
  ].join('\n');
  assert.deepEqual(extractSectionUrls(body), [
    'https://jobs.ashbyhq.com/acme/',
    'https://example.com/roles/1?team=pay',
    'https://example.com/a(b)',
    'https://example.com/c',
  ]);
  assert.deepEqual(extractSectionUrls(''), []);
});

test('moneyFiguresNear normalizes currency and k forms inside the matching block only', () => {
  const body = [
    'Acme pays $85,000 - 120.5k per year. https://a.test/1',
    '',
    'Founded 2015, band 85K. https://b.test/2',
    '- Between CA$95,000 and 110k. https://c.test/3',
    '- Unrelated bullet with $200,000 for another city. https://d.test/4',
  ].join('\n');
  assert.deepEqual(moneyFiguresNear(body, 'https://a.test/1'), [85000, 120500]);
  assert.deepEqual(moneyFiguresNear(body, 'https://b.test/2'), [85000]);
  assert.deepEqual(moneyFiguresNear(body, 'https://c.test/3'), [95000, 110000]);
  assert.deepEqual(moneyFiguresNear(body, 'https://a.test/1').includes(95000), false);
  assert.deepEqual(moneyFiguresNear(body, 'https://missing.test/'), []);
});

test('pageHasFigure accepts common spellings and rejects a figure embedded in a larger number', () => {
  for (const text of ['pay 85000 cad', 'pay 85,000 cad', 'pay 85 000 cad', 'band 85K', 'band 85k', 'band $85,000', 'band 85.0K', 'band 85.0k']) {
    assert.equal(pageHasFigure(text, 85000), true, text);
  }
  assert.equal(pageHasFigure('typical band 120.5k', 120500), true);
  assert.equal(pageHasFigure('typical band 120.5K', 120500), true);
  assert.equal(pageHasFigure('salary 185000', 85000), false);
  assert.equal(pageHasFigure('salary $185,000', 85000), false);
  assert.equal(pageHasFigure('band 185K', 85000), false);
  assert.equal(pageHasFigure('band 85.5k', 85000), false);
});

test('compensationParameters picks the currency from the listing location and fills the app defaults', () => {
  const toronto = compensationParameters({ title: 'Data Engineer', location: 'Toronto, ON',
    compensationContext: { roleFamily: 'Data Engineering', seniority: 'senior', employmentType: 'full-time' } });
  assert.equal(toronto.targetCurrency, 'CAD');
  assert.equal(toronto.workLocationOrRemoteResidence, 'Toronto, ON');
  assert.equal(toronto.roleFamily, 'Data Engineering');
  assert.equal(toronto.seniority, 'senior');
  assert.equal(toronto.employmentType, 'full-time');
  assert.equal(toronto.experienceBand, 'listing role level');
  assert.equal(toronto.experienceBandBasis, 'Use comparable salaries for the listing role and seniority. No published years-to-level ladder was established; do not infer candidate tenure or invent numerical experience bands.');

  assert.equal(compensationParameters({ title: 'Analyst', location: 'Austin, TX' }).targetCurrency, 'USD');
  assert.equal(compensationParameters({ title: 'Analyst', location: 'Remote, United States' }).targetCurrency, 'USD');
  assert.equal(compensationParameters({ title: 'Analyst', location: 'Remote' }).targetCurrency, 'CAD');
  assert.equal(compensationParameters({ title: 'Analyst', location: 'Vancouver, British Columbia' }).targetCurrency, 'CAD');
  const fallback = compensationParameters({ title: 'Analyst', location: 'Remote' });
  assert.equal(fallback.roleFamily, 'Analyst');
  assert.equal(fallback.seniority, 'unspecified');
  assert.equal(fallback.employmentType, 'unspecified');
});

test('cohortKey groups identical parameters and separates currencies', () => {
  const first = { title: 'Engineer', location: 'Toronto, ON', compensationContext: { roleFamily: 'Engineering', seniority: 'Senior', employmentType: 'full-time' } };
  const same = { title: 'Engineer', location: 'Toronto, ON', compensationContext: { roleFamily: 'engineering', seniority: 'senior', employmentType: 'FULL-TIME' } };
  const usd = { title: 'Engineer', location: 'Austin, TX', compensationContext: { roleFamily: 'Engineering', seniority: 'Senior', employmentType: 'full-time' } };
  assert.equal(cohortKey(first), cohortKey(same));
  assert.notEqual(cohortKey(first), cohortKey(usd));
  assert.equal(cohortKey(first), JSON.stringify(['Engineering', 'Senior', 'full-time', 'Toronto, ON', 'CAD']).toLowerCase());
});

test('digits inside links are never salary figures, in the research or on the page', () => {
  const url = 'https://www.payscale.com/research/CA/Job=Director/Salary/19749aa3/Toronto-ON';
  assert.deepEqual(moneyFiguresNear(`- Payscale ${url}: typical CA$120,000`, url), [120000]);
  assert.deepEqual(moneyFiguresNear(`- [Payscale](${url}) no figure here`, url), []);
  assert.equal(pageHasFigure('[Director salary](https://x.example/Salary/19749aa3/) Toronto', 19749), false);
  assert.equal(pageHasFigure('see https://x.example/pay/120000 for more', 120000), false);
  assert.equal(pageHasFigure('Average base pay $120,000 in Toronto', 120000), true);
});

test('a numbered source keeps its indented URL, figures and quote together', () => {
  const url = 'https://ca.indeed.com/career/senior-software-engineer/salaries/Vancouver--BC';
  const body = [
    '1. **Indeed Canada.**',
    `   - URL: ${url}`,
    '   - **Typical range: C$100,651 – C$207,859 per year.**',
    '',
    '   - Date: updated November 2, 2026',
    '2. **Payscale.**',
    '   - URL: https://www.payscale.com/x',
    '   - Base salary: C$92K – C$155K',
  ].join('\n');
  assert.deepEqual(moneyFiguresNear(body, url), [100651, 207859]);
  assert.deepEqual(moneyFiguresNear(body, 'https://www.payscale.com/x'), [92000, 155000]);
});
