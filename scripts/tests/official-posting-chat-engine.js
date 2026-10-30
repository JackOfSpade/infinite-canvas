import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveOfficialPostings } from '../../electron/ipc/officialPostingService.js';
import { createOfficialPostingStore } from '../../electron/ipc/officialPostingStore.js';
import { normalizeOfficialPosting, officialPostingComparativeTrail, officialPostingLookupStatus, officialResearchSettled } from '../../electron/ipc/officialPostingFields.js';
import { shouldPersistOfficialPostingResult, unresolvedOfficialPosting } from '../../electron/ipc/officialPostingResolver.js';
import { officialPostingSemanticInputHash, officialPostingSemanticProofMatches } from '../../electron/ipc/officialPostingSemantic.js';
import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL } from '../../electron/ipc/officialPostingNegativePolicy.js';
import { extractAtsTenant, strictEmployerEqual } from '../../electron/ipc/officialSourceHosts.js';
import { snapshotOfficialPostingLeads } from '../../electron/ipc/officialPostingSnapshot.js';
import { buildOfficialPostingJudgeRequest, canonicalJudgeDescription, decideOfficialPostingJudgments, judgeDescriptionsAgree,
  rankJudgeCitations, validateOfficialPostingJudgeResponse } from '../../electron/ipc/officialPostingJudge.js';

const DESCRIPTION = 'Northwind Labs is hiring a Dispatch Engineer to build reliable routing services for regional delivery teams.\n'
  + '• Design the dispatch scheduling service and its reporting pipeline.\n'
  + '• Review route reports with operations leads every week.\n'
  + 'Requirements: five years building backend services in TypeScript or Go.';
const job = (extra = {}) => ({ title: 'Dispatch Engineer', company: 'Northwind Labs', location: 'Lakeview, Ontario, Canada',
  snippet: DESCRIPTION, url: 'https://www.linkedin.com/jobs/view/synthetic-dispatch', sourceJobKey: 'dispatch-1', ...extra });
const POSTING = 'https://job-boards.greenhouse.io/northwind/jobs/4455667';
const CAREERS = 'https://northwind.test/careers';
const leads = [{ id: 'P1', url: POSTING, kind: 'posting', employer: 'Northwind Labs' }, { id: 'P2', url: CAREERS, kind: 'careers', employer: 'Northwind Labs' }];
const chosen = (extra = {}) => ({ choice: 'P1', postingUrl: POSTING, status: 'open', statusQuote: 'Apply for this job',
  employerLinked: true, employerPageUrl: CAREERS, employerLinkQuote: 'View open roles', title: 'Dispatch Engineer',
  employer: 'Northwind Labs', location: 'Lakeview, Ontario, Canada', salary: '', description: DESCRIPTION,
  evidence: [{ scrapedQuote: 'Review route reports with operations leads every week.', officialQuote: 'Review route reports with operations leads every week.' }],
  conflicts: [], ...extra });
const unresolvedAnswer = choice => ({ choice, postingUrl: '', status: 'unknown', statusQuote: '', employerLinked: false, employerPageUrl: '',
  employerLinkQuote: '', title: '', employer: '', location: '', salary: '', description: '', evidence: [], conflicts: ['No lead is this posting.'] });
const decide = (row, answerA, answerB, extra = {}) => decideOfficialPostingJudgments(row, { leads, answerA, answerB, now: () => Date.UTC(2026, 9, 29),
  fallback: unresolvedOfficialPosting, comparativeTrail: officialPostingComparativeTrail, inputHash: officialPostingSemanticInputHash(row),
  extractRoute: url => extractAtsTenant(url), employerEqual: strictEmployerEqual, negativeProofTrail: OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL, ...extra });
const research = ids => ids.map(id => `BEGIN OFFICIAL POSTING RESEARCH ${id}\nCANDIDATE: ${JSON.stringify({ careersPageUrl: CAREERS,
  postingUrl: POSTING, employer: 'Northwind Labs', employerDomain: 'https://northwind.test', ats: 'Greenhouse' })}\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
const notFound = ids => ids.map(id => `BEGIN OFFICIAL POSTING RESEARCH ${id}\nNOT FOUND\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
const requestedIds = prompt => prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', ');
const offline = async () => { const error = new Error('offline test'); error.code = 'fetch-failed'; throw error; };
const hostLeads = prompt => JSON.parse(prompt.split('BEGIN HOST LEADS JSON\n')[1].split('\nEND HOST LEADS JSON')[0]);
async function withStore(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-chat-'));
  try { return await run(createOfficialPostingStore(path.join(root, 'official-postings'))); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

export default [
  {
    name: 'Judge citations rank votes and lead order, and describe only the uncertainty reported',
    run() {
      const unmatched1 = 'https://other.example.test/one';
      const unmatched2 = 'https://other.example.test/two';
      const answers = [
        chosen({ postingUrl: unmatched1 }), chosen({ postingUrl: CAREERS, status: 'closed', employerLinked: false }),
        chosen({ postingUrl: POSTING, status: 'open' }), chosen({ postingUrl: unmatched2 }),
        chosen({ postingUrl: `${POSTING}/`, status: 'closed', employerLinked: false }),
        unresolvedAnswer('none'), unresolvedAnswer('uncertain'), null, undefined,
      ];
      const before = structuredClone({ leads, answers });
      const ranked = rankJudgeCitations({ leads, answers });
      assert.deepEqual(ranked, [
        { url: POSTING, title: 'Unconfirmed · cited by 2 of 7 judges · status split: 1 open, 1 closed · employer link confirmed by 1 of 2' },
        { url: CAREERS, title: 'Unconfirmed · cited by 1 of 7 judges · reported closed · employer link confirmed by 0 of 1' },
        { url: unmatched1, title: 'Unconfirmed · cited by 1 of 7 judges' },
        { url: unmatched2, title: 'Unconfirmed · cited by 1 of 7 judges' },
      ]);
      assert.deepEqual({ leads, answers }, before);
      assert.deepEqual(rankJudgeCitations({ leads, answers: [chosen({ postingUrl: CAREERS }), chosen()] }).map(item => item.url), [POSTING, CAREERS]);
      assert.deepEqual(rankJudgeCitations({ leads, answers: [chosen({ status: 'unknown' })] }), [
        { url: POSTING, title: 'Unconfirmed · cited by 1 of 1 judges · status unknown' },
      ]);
      assert.deepEqual(rankJudgeCitations({ leads, answers: [
        { ...unresolvedAnswer('none'), postingUrl: POSTING }, { ...unresolvedAnswer('uncertain'), postingUrl: CAREERS }, null,
      ] }), []);
      assert.deepEqual(rankJudgeCitations({ leads, answers: [] }), []);
      const many = Array.from({ length: 13 }, (_, index) => chosen({ postingUrl: `https://other.example.test/${index}` }));
      many.unshift(chosen({ postingUrl: 'http://other.example.test/insecure' }));
      const capped = rankJudgeCitations({ leads: [], answers: many });
      assert.deepEqual(capped.map(item => item.url), many.slice(1, 13).map(answer => answer.postingUrl));
      assert.ok(capped.every(item => item.title.length <= 500));
    },
  },
  {
    name: 'Split employer-link judgments store all four citations on the ambiguous record',
    async run() {
      await withStore(async store => {
        let judgments = 0;
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          judgments += 1;
          const linked = options.manualHandoff.comparisonRun === 'A';
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id,
            employerLinked: linked, employerPageUrl: linked ? CAREERS : '', employerLinkQuote: linked ? 'View open roles' : '' }));
        };
        const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
        const posting = result.jobs[0].officialPosting;
        assert.equal(judgments, 4);
        assert.equal(posting.outcome, 'ambiguous');
        assert.deepEqual(posting.alternatives, [{ url: POSTING,
          title: 'Unconfirmed · cited by 4 of 4 judges · employer link confirmed by 2 of 4' }]);
        assert.deepEqual(normalizeOfficialPosting(posting).alternatives, posting.alternatives);
      });
    },
  },
  {
    name: 'A failed second pair preserves the first ambiguous decision and counts its valid partial citation',
    async run() {
      await withStore(async store => {
        let judgments = 0;
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          judgments += 1;
          if (judgments >= 4) return '{"choice":"P1"}';
          const linked = options.manualHandoff.comparisonRun === 'A';
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id,
            employerLinked: linked, employerPageUrl: linked ? CAREERS : '', employerLinkQuote: linked ? 'View open roles' : '' }));
        };
        const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
        const posting = result.jobs[0].officialPosting;
        assert.equal(posting.outcome, 'ambiguous');
        assert.deepEqual(posting.alternatives, [{ url: POSTING,
          title: 'Unconfirmed · cited by 3 of 3 judges · employer link confirmed by 2 of 3' }]);
      });
    },
  },
  {
    name: 'An ambiguous decision without citations keeps its generic leads',
    async run() {
      await withStore(async store => {
        let genericLeads;
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          if (options.manualHandoff.comparisonRun === 'A') {
            genericLeads = hostLeads(prompt).map(lead => ({ url: lead.url,
              title: `${lead.employer || 'Official'} ${lead.kind === 'posting' ? 'posting' : 'careers page'} lead` }));
          }
          return JSON.stringify(unresolvedAnswer('uncertain'));
        };
        const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
        const posting = result.jobs[0].officialPosting;
        assert.equal(posting.outcome, 'ambiguous');
        assert.ok(genericLeads.length > 0);
        assert.deepEqual(posting.alternatives, genericLeads);
      });
    },
  },
  {
    name: 'Chat judge requests are grounded isolated A/B judgments with host leads kept outside the untrusted listing',
    run() {
      const row = job({ snippet: `${DESCRIPTION}\nApply at https://evil.example/apply` });
      const a = buildOfficialPostingJudgeRequest({ job: row, leads, run: 'A' });
      const b = buildOfficialPostingJudgeRequest({ job: row, leads, run: 'B' });
      assert.equal(a.task, 'job-official-posting-match');
      assert.equal(a.grounding, true); assert.equal(a.grounded, true); assert.equal(a.format, 'json');
      assert.match(a.manualHandoff.comparisonGroup, /^[a-f0-9]{64}$/u);
      assert.equal(a.manualHandoff.comparisonGroup, b.manualHandoff.comparisonGroup);
      assert.deepEqual([a.manualHandoff.comparisonRun, b.manualHandoff.comparisonRun], ['A', 'B']);
      assert.deepEqual(hostLeads(a.prompt).map(lead => lead.id), ['P1', 'P2']);
      assert.deepEqual(hostLeads(b.prompt).map(lead => lead.id), ['P2', 'P1'], 'run B sees the leads in reverse order');
      assert.ok(!hostLeads(a.prompt).some(lead => lead.url.includes('evil.example')), 'a link in the scraped listing is never a lead');
      assert.ok(a.prompt.indexOf('BEGIN HOST LEADS JSON') < a.prompt.indexOf('BEGIN UNTRUSTED SCRAPED LISTING JSON'));
      assert.deepEqual(a.responseSchema.properties.choice.enum, ['P1', 'P2', 'other', 'none', 'uncertain']);
    },
  },
  {
    name: 'Chat judge validation checks only format and that quotes come from the scraped listing and the judge\'s own copy',
    run() {
      const row = job();
      assert.equal(validateOfficialPostingJudgeResponse(JSON.stringify(chosen()), { job: row, leads }).choice, 'P1');
      assert.equal(validateOfficialPostingJudgeResponse(unresolvedAnswer('none'), { job: row, leads }).choice, 'none');
      const rejects = (answer, rule) => assert.throws(() => validateOfficialPostingJudgeResponse(answer, { job: row, leads }),
        error => error.code === 'OFFICIAL_POSTING_RESPONSE_INVALID'
          && error.correctionRuleIds.some(id => id.toLowerCase().replace(/_/gu, '-').includes(rule)), rule);
      rejects(chosen({ choice: 'P7' }), 'official-judge-choice');
      rejects(chosen({ postingUrl: 'http://insecure.example/job' }), 'official-judge-url');
      rejects(chosen({ description: '' }), 'official-judge-posting');
      rejects(chosen({ employerPageUrl: '' }), 'official-judge-employer');
      rejects(chosen({ evidence: [{ scrapedQuote: 'Invented scraped words.', officialQuote: 'Review route reports with operations leads every week.' }] }), 'official-judge-verbatim');
      rejects(chosen({ evidence: [{ scrapedQuote: 'Review route reports with operations leads every week.', officialQuote: 'Words the judge never copied.' }] }), 'official-judge-verbatim');
      rejects({ ...unresolvedAnswer('uncertain'), conflicts: [] }, 'official-judge-unresolved');
      rejects({ ...chosen(), extra: true }, 'official-judge-json');
      // A closed posting may no longer show its description.
      assert.equal(validateOfficialPostingJudgeResponse(chosen({ status: 'closed', statusQuote: 'This job is no longer accepting applications',
        description: '', evidence: [{ scrapedQuote: 'Dispatch Engineer', officialQuote: 'Dispatch Engineer' }] }), { job: row, leads }).status, 'closed');
    },
  },
  {
    name: 'Two copies of a description agree on the same words regardless of spacing, bullets, quote and dash styles',
    run() {
      assert.equal(judgeDescriptionsAgree('• Ship “reliable” tools — fast.\n\nRequirements:  Go', '- Ship "reliable" tools - fast. Requirements: Go'), true);
      assert.equal(judgeDescriptionsAgree('Ship reliable tools fast.', 'Ship reliable tools.'), false);
      assert.equal(judgeDescriptionsAgree('', ''), false);
      assert.equal(canonicalJudgeDescription('\r\n line one\r\nline\u0007two \n'), 'line one\nline two');
    },
  },
  {
    name: 'Agreeing judges store a durable verified posting whose text the generation freeze accepts; differing copies keep only the link',
    run() {
      const row = job();
      const agreed = decide(row, chosen(), chosen({ description: DESCRIPTION.replace(/\n/gu, '\n\n') }));
      const posting = normalizeOfficialPosting(agreed.officialPosting);
      assert.equal(posting.level, 'L2'); assert.equal(posting.outcome, 'found');
      assert.equal(posting.ats, 'greenhouse'); assert.equal(posting.tenant, 'northwind'); assert.equal(posting.sourceUrl, POSTING);
      assert.equal(agreed.description, canonicalJudgeDescription(DESCRIPTION));
      assert.equal(officialPostingSemanticProofMatches(row, posting), true);
      assert.equal(shouldPersistOfficialPostingResult({ officialPosting: posting }, { researchRan: true }), true);
      assert.equal(officialPostingLookupStatus(posting).label, 'Exact official posting verified');
      assert.equal(agreed.postedBy, '');
      const linkOnly = decide(row, chosen(), chosen({ description: `${DESCRIPTION}\nBenefits: dental.` }));
      assert.equal(linkOnly.officialPosting.level, 'L4'); assert.equal(linkOnly.officialPosting.outcome, 'link-only');
      assert.equal(linkOnly.description, undefined, 'unconfirmed text never reaches generation');
      assert.equal(officialPostingLookupStatus(linkOnly.officialPosting).state, 'verified');
      const ownSite = decide(row, chosen({ postingUrl: 'https://northwind.test/careers/dispatch-engineer' }),
        chosen({ postingUrl: 'https://northwind.test/careers/dispatch-engineer/' }));
      assert.equal(ownSite.officialPosting.level, 'L1');
      const recruiter = decide(job({ company: 'Acme Talent Partners' }), chosen(), chosen());
      assert.equal(recruiter.postedBy, 'Acme Talent Partners');
    },
  },
  {
    name: 'Judges reaching one posting through different leads agree; different posting pages or statuses stay retryable',
    run() {
      const row = job();
      const viaCareers = decide(row, chosen(), chosen({ choice: 'P2' }));
      assert.equal(viaCareers.officialPosting.outcome, 'found');
      assert.ok(viaCareers.officialPosting.trail.includes('comparative-equivalent'));
      assert.equal(shouldPersistOfficialPostingResult({ officialPosting: viaCareers.officialPosting }, { researchRan: true }), true);
      for (const [answerB, code] of [
        [chosen({ postingUrl: 'https://job-boards.greenhouse.io/northwind/jobs/9999999' }), 'semantic-uncertain'],
        [unresolvedAnswer('uncertain'), 'semantic-uncertain'],
        [chosen({ status: 'unknown' }), 'official-liveness-unconfirmed'],
        [chosen({ status: 'closed', description: '' }), 'official-liveness-unconfirmed'],
        [chosen({ employerLinked: false, employerPageUrl: '', employerLinkQuote: '' }), 'source-unproven'],
      ]) {
        const result = decide(row, chosen(), answerB);
        assert.ok(result.officialPosting.trail.includes(code), code);
        assert.equal(officialPostingLookupStatus(result.officialPosting).retryable, true, code);
        assert.equal(shouldPersistOfficialPostingResult({ officialPosting: result.officialPosting }, { researchRan: true }), false, code);
      }
    },
  },
  {
    name: 'Both judges seeing it closed record a durable closed posting; both finding no lead record a settled miss',
    run() {
      const row = job();
      const closedAnswer = { status: 'closed', statusQuote: 'No longer accepting applications', description: '',
        evidence: [{ scrapedQuote: 'Dispatch Engineer', officialQuote: 'Dispatch Engineer' }] };
      const closed = decide(row, chosen(closedAnswer), chosen(closedAnswer));
      assert.equal(closed.officialPosting.outcome, 'closed');
      assert.equal(officialPostingLookupStatus(closed.officialPosting).state, 'closed');
      assert.equal(shouldPersistOfficialPostingResult({ officialPosting: closed.officialPosting }, { researchRan: true }), true);
      const miss = decide(row, unresolvedAnswer('none'), unresolvedAnswer('none'));
      assert.equal(miss.officialPosting.outcome, 'not-found');
      assert.equal(officialResearchSettled(miss.officialPosting), true);
      assert.equal(officialPostingLookupStatus(miss.officialPosting).state, 'not-found');
    },
  },
  {
    name: 'A posting counts only when both judges saw the employer link it, closed included; unseen leads block a settled miss',
    run() {
      const row = job();
      const unlinked = { status: 'closed', statusQuote: 'No longer accepting applications', description: '', employerLinked: false,
        employerPageUrl: '', employerLinkQuote: '', evidence: [{ scrapedQuote: 'Dispatch Engineer', officialQuote: 'Dispatch Engineer' }] };
      const closedRepost = decide(row, chosen(unlinked), chosen(unlinked));
      assert.ok(closedRepost.officialPosting.trail.includes('source-unproven'));
      assert.equal(officialPostingLookupStatus(closedRepost.officialPosting).retryable, true);
      const capped = decide(row, unresolvedAnswer('none'), unresolvedAnswer('none'), { totalLeads: 11 });
      assert.ok(capped.officialPosting.trail.includes('comparative-truncated'));
      assert.equal(officialResearchSettled(capped.officialPosting), false);
      assert.equal(capped.comparison.truncated, true); assert.equal(capped.comparison.preCapCount, 11);
      // A copy that is empty once unsafe characters are removed is not usable text.
      assert.throws(() => validateOfficialPostingJudgeResponse(chosen({ description: '\u0001', evidence: [{ scrapedQuote: 'Dispatch Engineer', officialQuote: 'Dispatch Engineer' }] }),
        { job: row, leads }), error => error.code === 'OFFICIAL_POSTING_RESPONSE_INVALID');
    },
  },
  {
    name: 'Cards sharing one scraped identity share one finder slot and both receive its leads',
    async run() {
      await withStore(async store => {
        const first = job(); const second = job();
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') {
            assert.equal(requestedIds(prompt).length, 1, 'one research slot for the shared identity');
            return research(requestedIds(prompt));
          }
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        };
        const result = await resolveOfficialPostings([first, second], { store, snapshotFetch: offline, callRaw });
        assert.deepEqual(result.jobs.map(row => row.officialPosting.outcome), ['found', 'found']);
      });
    },
  },
  {
    name: 'The production lookup asks ChatGPT only: finder, two judges, stored text, then a cache hit without new chats',
    async run() {
      await withStore(async store => {
        const row = job(); const calls = [];
        const callRaw = async (prompt, options) => {
          calls.push(options.task);
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          assert.equal(options.grounding, true, 'judges are asked to browse');
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        };
        const result = await resolveOfficialPostings([row], { store, snapshotFetch: offline, callRaw, bridgeStatus: () => ({}) });
        assert.deepEqual(calls, ['job-official-posting-research', 'job-official-posting-match', 'job-official-posting-match']);
        const posting = result.jobs[0].officialPosting;
        assert.equal(posting.outcome, 'found'); assert.equal(posting.sourceUrl, POSTING);
        assert.equal(await store.readText(posting.contentHash), canonicalJudgeDescription(DESCRIPTION));
        assert.equal(result.telemetry.comparativeMatches, 1); assert.equal(result.telemetry.fetches, 0);
        const again = await resolveOfficialPostings([row], { store, snapshotFetch: offline, callRaw: () => { throw new Error('a cached verified row asks no chat'); } });
        assert.ok(again.jobs[0].officialPosting.trail.includes('cache-hit'));
      });
    },
  },
  {
    name: 'An unsettled first pair gets one fresh isolated pair; only that pair\'s own agreement can settle the row',
    async run() {
      for (const secondAgrees of [true, false]) {
        await withStore(async store => {
          const groups = []; let judgments = 0;
          const callRaw = async (prompt, options) => {
            if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
            judgments += 1; groups.push(options.manualHandoff.comparisonGroup);
            const id = hostLeads(prompt).find(lead => lead.url === POSTING).id;
            // First pair: A finds it, B is unsure. Second pair: both find it, or B is unsure again.
            const unsure = options.manualHandoff.comparisonRun === 'B' && (judgments === 2 || !secondAgrees);
            return JSON.stringify(unsure ? unresolvedAnswer('uncertain') : chosen({ choice: id }));
          };
          const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
          assert.equal(judgments, 4);
          assert.equal(new Set(groups).size, 2, 'each pair has its own comparison group');
          const posting = result.jobs[0].officialPosting;
          if (secondAgrees) {
            assert.equal(posting.outcome, 'found');
            assert.equal(Object.hasOwn(posting, 'alternatives'), false);
          } else {
            assert.ok(posting.trail.includes('semantic-uncertain'));
            assert.equal(officialPostingLookupStatus(posting).retryable, true);
            assert.deepEqual(posting.alternatives, [{ url: POSTING, title: 'Unconfirmed · cited by 2 of 4 judges' }]);
          }
        });
      }
    },
  },
  {
    name: 'A judge may report a posting its own search found; a miss settles only when a second isolated pair also finds nothing',
    async run() {
      const row = job();
      const elsewhere = 'https://northwind.test/jobs/dispatch-engineer';
      const viaSearch = decide(row, chosen({ choice: 'other', postingUrl: elsewhere }), chosen({ choice: 'other', postingUrl: `${elsewhere}/` }));
      assert.equal(viaSearch.officialPosting.outcome, 'found'); assert.equal(viaSearch.officialPosting.sourceUrl, elsewhere);
      assert.equal(shouldPersistOfficialPostingResult({ officialPosting: viaSearch.officialPosting }, { researchRan: true }), true);
      assert.equal(validateOfficialPostingJudgeResponse(chosen({ choice: 'other', postingUrl: elsewhere }), { job: row, leads }).choice, 'other');
      for (const [secondPair, expected] of [['none', 'not-found'], ['found', 'found'], ['fails', 'retryable']]) {
        await withStore(async store => {
          let judgments = 0;
          const callRaw = async (prompt, options) => {
            if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
            judgments += 1;
            if (judgments <= 2 || secondPair === 'none') return JSON.stringify(unresolvedAnswer('none'));
            if (secondPair === 'fails') return '{"choice":"P1"}';
            return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
          };
          const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
          const posting = result.jobs[0].officialPosting;
          if (expected === 'retryable') assert.equal(officialPostingLookupStatus(posting).retryable, true, secondPair);
          else assert.equal(posting.outcome, expected, secondPair);
          if (expected === 'not-found') assert.equal(officialResearchSettled(posting), true);
        });
      }
    },
  },
  {
    name: 'A closure, like a miss, is final only when a second isolated pair also sees it closed',
    async run() {
      const closedAnswer = id => chosen({ choice: id, status: 'closed', statusQuote: 'The application page for this job is not found',
        description: '', evidence: [{ scrapedQuote: 'Dispatch Engineer', officialQuote: 'Dispatch Engineer' }] });
      for (const [secondPair, expected] of [['closed', 'closed'], ['open', 'found'], ['fails', 'retryable']]) {
        await withStore(async store => {
          let judgments = 0;
          const callRaw = async (prompt, options) => {
            if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
            judgments += 1;
            const id = hostLeads(prompt).find(lead => lead.url === POSTING).id;
            if (judgments <= 2 || secondPair === 'closed') return JSON.stringify(closedAnswer(id));
            if (secondPair === 'fails') return '{"choice":"P1"}';
            return JSON.stringify(chosen({ choice: id }));
          };
          const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
          const posting = result.jobs[0].officialPosting;
          if (expected === 'retryable') assert.equal(officialPostingLookupStatus(posting).retryable, true, secondPair);
          else assert.equal(posting.outcome, expected, secondPair);
        });
      }
    },
  },
  {
    name: 'A job-board posting lead carries that board\'s public data address for judges whose browser cannot run JavaScript',
    async run() {
      await withStore(async store => {
        let seen = null;
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          seen ||= hostLeads(prompt);
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        };
        await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
        const posting = seen.find(lead => lead.url === POSTING); const careers = seen.find(lead => lead.url === CAREERS);
        assert.equal(posting.dataUrl, 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/4455667?questions=false');
        assert.equal(careers.dataUrl, undefined, 'a careers page has no board data address');
        assert.match(buildOfficialPostingJudgeRequest({ job: job(), leads: [{ id: 'P1', url: POSTING, kind: 'posting', dataUrl: posting.dataUrl }], run: 'A' }).prompt,
          /When a lead has a dataUrl, open it/u);
      });
    },
  },
  {
    name: 'The app downloads each lead for the judges: board data says whether the posting is listed, by its identifier',
    async run() {
      const api = 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/4455667?questions=false';
      const pages = { [api]: { url: api, contentType: 'application/json', statusCode: 200, body: JSON.stringify({ id: 4455667, title: 'Dispatch Engineer',
        absolute_url: 'https://boards.greenhouse.io/northwind/jobs/4455667', location: { name: 'Lakeview, Ontario, Canada' }, content: DESCRIPTION, company_name: 'Northwind Labs' }) },
      [CAREERS]: { url: CAREERS, contentType: 'text/html', statusCode: 200, body: '<title>Careers</title><a href="https://job-boards.greenhouse.io/northwind">Open roles</a>' } };
      const fetch = async url => { if (pages[url]) return pages[url]; const error = new Error('gone'); error.code = 'fetch-failed'; error.statusCode = 404; throw error; };
      const snaps = await snapshotOfficialPostingLeads([{ id: 'P1', url: POSTING, kind: 'posting', dataUrl: api }, { id: 'P2', url: CAREERS, kind: 'careers' },
        { id: 'P3', url: 'https://northwind.test/jobs/old', kind: 'posting' }], { fetch });
      assert.equal(snaps[0].listedInBoardData, true, 'a host move (boards. vs job-boards.) keeps the same posting identifier');
      assert.equal(snaps[0].title, 'Dispatch Engineer'); assert.ok(snaps[0].description.includes('Review route reports'));
      assert.deepEqual(snaps[1].jobBoardLinks, ['https://job-boards.greenhouse.io/northwind']);
      assert.equal(snaps[2].read, false); assert.equal(snaps[2].notFound, true);
      const prompt = buildOfficialPostingJudgeRequest({ job: job(), leads, run: 'A', snapshots: snaps }).prompt;
      assert.ok(prompt.indexOf('BEGIN UNTRUSTED APP PAGE SNAPSHOTS JSON') > prompt.indexOf('END HOST LEADS JSON'));
      // A copy taken from a shortened snapshot keeps only the official link.
      const short = decide(job(), chosen(), chosen(), { textComplete: false });
      assert.equal(short.officialPosting.level, 'L4'); assert.equal(short.description, undefined);
    },
  },
  {
    name: 'A row neither finder can place stays retryable after one extra search; the judges are never asked',
    async run() {
      await withStore(async store => {
        const calls = [];
        const callRaw = async (prompt, options) => { calls.push(options.task); return notFound(requestedIds(prompt)); };
        const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
        assert.deepEqual(calls, ['job-official-posting-research', 'job-official-posting-research']);
        const posting = result.jobs[0].officialPosting;
        assert.ok(posting.trail.includes('research-miss'));
        assert.equal(officialPostingLookupStatus(posting).retryable, true);
      });
    },
  },
  {
    name: 'A malformed judgment gets one correction round; a second failure leaves the row retryable and unsaved',
    async run() {
      await withStore(async store => {
        let corrections = 0;
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          if (options.correctionAttempt === 1) corrections += 1;
          return '{"choice":"P1"}';
        };
        const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
        assert.equal(corrections, 1);
        const posting = result.jobs[0].officialPosting;
        assert.ok(posting.trail.includes('comparative-invalid'));
        assert.equal(officialPostingLookupStatus(posting).retryable, true);
        assert.equal(await store.find(job()), null);
      });
    },
  },
  {
    name: 'Without the ChatGPT bridge the lookup is incomplete, never a conclusion',
    async run() {
      await withStore(async store => {
        const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, bridgeAvailable: false,
          callRaw: () => { throw new Error('no chat without the bridge'); } });
        const status = officialPostingLookupStatus(result.jobs[0].officialPosting);
        assert.equal(status.state, 'incomplete'); assert.equal(status.retryable, true);
      });
    },
  },
  {
    name: 'Each second-round judge has a distinct prompt and a fresh shared comparison group',
    run() {
      const row = job();
      const first = {}; const second = {};
      for (const run of ['A', 'B']) {
        first[run] = buildOfficialPostingJudgeRequest({ job: row, leads, run, round: 1 });
        second[run] = buildOfficialPostingJudgeRequest({ job: row, leads, run, round: 2 });
        const originalHeading = `Independent official posting judgment run ${run}.`;
        const secondHeading = `Independent official posting judgment run ${run}, second independent review (round 2).`;
        assert.equal(first[run].prompt.slice(0, originalHeading.length), originalHeading);
        assert.equal(second[run].prompt, secondHeading + first[run].prompt.slice(originalHeading.length));
        assert.notEqual(second[run].prompt, first[run].prompt);
        assert.doesNotMatch(first[run].prompt, /\b(?:round 2|second independent review)\b/u);
        assert.deepEqual(hostLeads(second[run].prompt), hostLeads(first[run].prompt));
      }
      assert.equal(first.A.manualHandoff.comparisonGroup, first.B.manualHandoff.comparisonGroup);
      assert.equal(second.A.manualHandoff.comparisonGroup, second.B.manualHandoff.comparisonGroup);
      assert.notEqual(second.A.manualHandoff.comparisonGroup, first.A.manualHandoff.comparisonGroup);
    },
  },
  {
    name: 'A failed judgment is recorded with its failure code and round',
    async run() {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-chat-failure-'));
      try {
        const store = createOfficialPostingStore(root);
        assert.equal(store.rootDir, root);
        const row = job(); const time = Date.UTC(2026, 9, 29);
        let card; let judgeCalls = 0; let judgeLeadUrls;
        const callRaw = async (prompt, options) => {
          assert.equal(options.task, 'job-official-posting-research');
          const ids = requestedIds(prompt); [card] = ids;
          return research(ids);
        };
        const callMatch = async (prompt, options) => {
          assert.equal(options.task, 'job-official-posting-match');
          judgeCalls += 1;
          judgeLeadUrls = hostLeads(prompt).map(lead => lead.url);
          return '{"choice":"P1"}';
        };
        await resolveOfficialPostings([row], { store, now: () => time, snapshotFetch: offline, callRaw, callMatch });
        assert.equal(judgeCalls, 2, 'the invalid answer receives one correction attempt');
        assert.ok(judgeLeadUrls.includes(POSTING));
        const entries = (await fs.readFile(path.join(store.rootDir, 'judgments.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(entries, [{ at: new Date(time).toISOString(), card, title: row.title, company: row.company,
          round: 1, run: 'A', leads: judgeLeadUrls, failure: 'comparative-invalid' }]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'A second-round judge failure is logged without replacing the first unsettled decision',
    async run() {
      await withStore(async store => {
        const calls = [];
        const callRaw = async (prompt, options) => {
          assert.equal(options.task, 'job-official-posting-research');
          return research(requestedIds(prompt));
        };
        const callMatch = async (prompt, options) => {
          const run = options.manualHandoff.comparisonRun;
          const round = prompt.startsWith(`Independent official posting judgment run ${run}, second independent review (round 2).`) ? 2 : 1;
          calls.push(`${round}${run}`);
          if (round === 2 && run === 'B') return '{"choice":"P1"}';
          if (round === 1 && run === 'B') return JSON.stringify(unresolvedAnswer('uncertain'));
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        };
        const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw, callMatch });
        assert.deepEqual(calls, ['1A', '1B', '2A', '2B', '2B']);
        assert.ok(result.jobs[0].officialPosting.trail.includes('semantic-uncertain'));
        const entries = (await fs.readFile(path.join(store.rootDir, 'judgments.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(entries.map(({ round, run, failure }) => ({ round, run, failure })), [
          { round: 1, run: 'A', failure: undefined }, { round: 1, run: 'B', failure: undefined },
          { round: 2, run: 'A', failure: undefined }, { round: 2, run: 'B', failure: 'comparative-invalid' },
        ]);
      });
    },
  },
  {
    name: 'Judges report a chosen posting lead by its listed address, so two judges cite one posting the same way',
    run() {
      const { prompt } = buildOfficialPostingJudgeRequest({ job: job(), leads, run: 'A' });
      assert.match(prompt, /When that lead is a posting lead, report its url exactly as listed as postingUrl, even when the same posting also appears at another address such as the employer's own careers page;/u);
      // Code still compares the two reported addresses only for equality: one requisition cited at two addresses stays unsettled.
      const EMPLOYER_PAGE = 'https://careers.northwind.test/job/R000105663/Dispatch-Engineer';
      const split = decide(job(), chosen({ postingUrl: EMPLOYER_PAGE }), chosen());
      assert.equal(split.comparison.accepted, false);
      assert.ok(split.officialPosting.trail.includes('semantic-uncertain'));
    },
  },
  {
    name: 'A plain HTML page longer than the snapshot cap is flagged pageTextTruncated; a short page is not',
    async run() {
      const page = body => ({ [POSTING]: { url: POSTING, contentType: 'text/html', statusCode: 200, body } });
      const snap = async body => (await snapshotOfficialPostingLeads([{ id: 'P1', url: POSTING, kind: 'posting' }], { fetch: async url => page(body)[url] }))[0];
      const long = await snap(`<html><body>${'<p>Build reliable routing services for delivery teams.</p>'.repeat(800)}<p>FINAL REQUIREMENT</p></body></html>`);
      assert.equal(long.pageText.length, 30000);
      assert.ok(!long.pageText.includes('FINAL REQUIREMENT'));
      assert.equal(long.pageTextTruncated, true);
      const shortSnap = await snap('<html><body><p>Short posting text about dispatch routing.</p></body></html>');
      assert.ok(shortSnap.pageText.includes('Short posting text'));
      assert.ok(!('pageTextTruncated' in shortSnap));
    },
  },
  {
    name: 'Judges may accept a parent company careers site only for a posting that names the hiring company',
    run() {
      const { prompt } = buildOfficialPostingJudgeRequest({ job: job(), leads, run: 'A' });
      assert.match(prompt, /A parent company's careers site counts as the hiring company's own when the posting itself names the hiring company as the brand, team or employer that is hiring/u);
      assert.match(prompt, /a sister company's site \(another company under the same parent\), or a parent company's page whose posting does not name the hiring company\./u);
      assert.doesNotMatch(prompt, /a parent or sister company's site/u);
    },
  },
];
