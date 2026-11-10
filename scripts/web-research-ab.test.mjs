import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSectionReplies, extractSectionUrls, moneyFiguresNear, pageHasFigure, compensationParameters, cohortKey,
  roleFamilyResearchId, quotesNear, pageHasQuote, normalizeSourceText, hasYearBands, locationMatches, decideMergedLocation,
  cliOptions, DEFAULT_ULTRACODE, parseProfileOverride, effectiveProfile } from './web-research-ab.mjs';

test('--profile parses model:effort, keeps the production profile when absent, and refuses max and Fable', () => {
  const base = ['--task', 'compensation', '--canvas', 'c.json', '--out', 'out'];
  assert.equal(cliOptions(base).profile, null);
  assert.deepEqual(cliOptions([...base, '--profile', 'sonnet:high']).profile, { model: 'sonnet', effort: 'high' });
  assert.deepEqual(parseProfileOverride('haiku:low'), { model: 'haiku', effort: 'low' });
  for (const bad of ['opus:max', 'fable:low', 'opus', 'opus:high:x', 'gpt:low']) {
    assert.throws(() => parseProfileOverride(bad), /--profile must be/, bad);
  }
});

test('effectiveProfile replaces only model and effort and keeps the task tools', () => {
  const production = { model: 'opus', effort: 'medium', tools: 'WebSearch,WebFetch' };
  assert.equal(effectiveProfile(production, null), production);
  assert.deepEqual(effectiveProfile(production, { model: 'sonnet', effort: 'low' }), { model: 'sonnet', effort: 'low', tools: 'WebSearch,WebFetch' });
});

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

test('roleFamilyResearchId is deterministic and shaped as 24 lowercase hex', () => {
  const first = roleFamilyResearchId('Data Engineering');
  assert.equal(first, roleFamilyResearchId('Data Engineering'));
  assert.match(first, /^[a-f0-9]{24}$/u);
  assert.notEqual(first, roleFamilyResearchId('Data Science'));
  assert.notEqual(first, roleFamilyResearchId('Data Engineering '));
});

test('quotesNear keeps only quotes of 20+ characters written in the same block as the URL', () => {
  const url = 'https://example.com/ladder';
  const other = 'https://other.test/bands';
  const long = 'Engineers move from band 1 to band 2 after two years on the ladder.';
  const body = [
    `- Ladder source: ${url}`,
    `  Quote: “${long}”`,
    '  Short one: “too short to count”',
    '',
    `- Unrelated source: ${other}`,
    '  Quote: ‘A different ladder statement that belongs to the other source only.’',
  ].join('\n');
  assert.deepEqual(quotesNear(body, url), [long]);
  assert.deepEqual(quotesNear(body, other), ['A different ladder statement that belongs to the other source only.']);
  assert.deepEqual(quotesNear(body, 'https://missing.test/none'), []);
  assert.deepEqual(quotesNear('', url), []);
});

test('pageHasQuote matches after normalizing curly quotes, whitespace, dash variants and link targets', () => {
  const quote = 'Engineers move from band 1 to band 2 after two years - not before.';
  assert.equal(pageHasQuote('ENGINEERS   move from band 1 to band 2 after two years — not before.', quote), true);
  assert.equal(pageHasQuote('See [the ladder](https://x.test/a) Engineers move from band 1 to band 2 after two years – not before.', quote), true);
  assert.equal(pageHasQuote('Engineers move from band 1 to band 3 after two years — not before.', quote), false);
  assert.equal(pageHasQuote('', quote), false);
  // Curly quotes on the page and straight quotes in the quote (and the reverse) are the same text.
  const spoke = 'The team says "2-4 years" for band 2 here.';
  assert.equal(pageHasQuote('the team says “2-4 years” for band 2 here.', spoke), true);
  assert.equal(normalizeSourceText('“A” – B\n\tC'), '"a" - b c');
});

test('hasYearBands accepts numeric bands and rejects a bare number of years', () => {
  for (const text of ['0-2 years', '3 to 5 years', '1–3 years', '2—4 years', '5+ years', '12+ years', 'Band 1: 0 - 2 years']) {
    assert.equal(hasYearBands(text), true, text);
  }
  for (const text of ['5 years of experience', 'years on the ladder', '120+ years of history', '3-5 yrs', 'four years', '']) {
    assert.equal(hasYearBands(text), false, text);
  }
});

test('locationMatches compares the first place segment and the country word for a remote truth', () => {
  assert.equal(locationMatches('San Francisco, CA', 'New York, NY | San Francisco, CA'), true);
  assert.equal(locationMatches('toronto, on', 'Toronto, Canada'), true);
  assert.equal(locationMatches('Vancouver, BC', 'Toronto, ON'), false);
  assert.equal(locationMatches('Remote, Canada', 'Remote, Canada', { remote: true }), true);
  assert.equal(locationMatches('Canada', 'Remote, Canada', { remote: true }), true);
  assert.equal(locationMatches('Remote, United States', 'Remote, Canada', { remote: true }), false);
  assert.equal(locationMatches('Toronto, ON', 'Remote, Canada', { remote: true }), false);
  assert.equal(locationMatches('', 'Toronto, ON'), false);
});

test('decideMergedLocation follows the decision table with the app acceptance gate injected', () => {
  const job = { title: 'Engineer', company: 'Acme' };
  const evaluate = row => (row.accepted
    ? { ok: true, found: { display: row.location, remote: false, remoteCountry: '', sourceUrl: row.sourceUrl } }
    : { ok: false, reason: 'REJECTED' });
  const row = (accepted, location) => ({ found: true, accepted, location, sourceUrl: 'https://acme.test/careers/1' });

  const tavilyOnly = decideMergedLocation({ job, evaluate, rows: { native: row(false, 'Toronto, ON'), tavily: row(true, 'Austin, TX') } });
  assert.equal(tavilyOnly.kind, 'tavily');
  assert.equal(tavilyOnly.found.display, 'Austin, TX');

  const nativeOnly = decideMergedLocation({ job, evaluate, rows: { native: row(true, 'Toronto, ON'), tavily: { found: false, reason: 'no posting' } } });
  assert.equal(nativeOnly.kind, 'native');
  assert.equal(nativeOnly.found.display, 'Toronto, ON');

  const agree = decideMergedLocation({ job, evaluate, rows: { native: row(true, 'Toronto, ON'), tavily: row(true, 'toronto, on') } });
  assert.equal(agree.kind, 'native');
  assert.equal(agree.agree, true);
  assert.equal(agree.found.display, 'Toronto, ON');

  const disagree = decideMergedLocation({ job, evaluate, rows: { native: row(true, 'Toronto, ON'), tavily: row(true, 'Vancouver, BC') } });
  assert.equal(disagree.kind, 'conflict');
  assert.equal(disagree.agree, false);
  assert.equal(disagree.found.display, 'Toronto, ON');

  const none = decideMergedLocation({ job, evaluate, rows: { native: null, tavily: row(false, 'Vancouver, BC') } });
  assert.equal(none.kind, 'none');
  assert.equal(none.found, null);
});

test('--ultracode defaults to off for every task while the flag still works', () => {
  assert.equal(DEFAULT_ULTRACODE, 'off');
  const base = ['--canvas', 'canvas.json', '--out', 'out'];
  for (const task of ['preference', 'compensation', 'role-family', 'location']) {
    assert.equal(cliOptions(['--task', task, ...base]).ultracode, false, task);
    assert.equal(cliOptions(['--task', task, ...base, '--ultracode', 'on']).ultracode, true, task);
  }
  assert.throws(() => cliOptions(['--task', 'compensation', ...base, '--ultracode', 'yes']), /--ultracode must be on or off/u);
  assert.throws(() => cliOptions(['--task', 'role-families', ...base]), /--task must be one of/u);
});
