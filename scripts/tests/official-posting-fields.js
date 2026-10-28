import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  OFFICIAL_POSTING_LEVELS, OFFICIAL_POSTING_OUTCOMES, OFFICIAL_POSTING_ROW_FIELDS,
  normalizeOfficialPosting, OFFICIAL_POSTING_TRAIL, SALARY_PROVENANCES, boundedOfficialPostingTrail, officialPostingComparativeTrail, officialResearchSettled,
  officialPostingFetchFailure, officialPostingLookupStatus, OFFICIAL_FETCH_FAILURE_LIMIT,
} from '../../electron/ipc/officialPostingFields.js';
import {
  __pastePromptForTests, __projectLocalApplicationJobForAcceptanceHarness as safeJob,
} from '../../electron/ipc/localAiApplication.js';
import {
  WRITE_VERIFY_STAGES, writeVerifyPrompt, writeVerifySourcePrompt,
} from '../../electron/ipc/applicationWriteVerify.js';
import { buildJobTreeNodes } from '../../src/nodes/jobsearch/buildJobTree.js';
import { buildPostingVariant, postingVariantKey } from '../../src/utils/jobLocationConsolidation.js';
import { migrateLegacyJobHubResults } from '../../src/utils/serializationUtils.js';

function posting(extra = {}) {
  return {
    level: 'L2', outcome: 'found', employer: 'Northwind Labs', title: 'Platform Engineer',
    location: { display: 'Remote, Canada', workMode: 'remote', remote: true, remoteCountry: 'Canada', remoteRegion: '' },
    salary: { text: '$120,000–$150,000 annually', provenance: 'posted' },
    sourceUrl: 'https://careers.example.test/jobs/platform?keep=yes&utm_source=board#details',
    officialApplyUrl: 'https://apply.example.test/platform?keep=yes&utm_medium=listing#form',
    ats: 'ashby', tenant: 'northwind-synthetic', fetchedAt: '2026-10-01T12:00:00Z',
    contentHash: 'a'.repeat(64), scrapedListingSha256: 'b'.repeat(64),
    trail: ['careers-page', 'tenant-unproven', 'bridge-unavailable'],
    alternatives: [{ url: 'https://careers.example.test/jobs/alternative?utm_source=board#details', title: 'Platform Engineer II' }],
    ...extra,
  };
}

function row(extra = {}) {
  return {
    title: 'Platform Engineer', company: 'Acme Talent Partners', location: 'Remote, Canada',
    salary: '$120,000–$150,000 annually', snippet: 'Maintain dependable platform services.', matchScore: 80,
    url: 'https://listing.example.test/job/platform', googleCardUrl: 'https://www.google.com/search?htidocid=synthetic-platform',
    sourceJobKey: 'synthetic-platform-key', source: 'google', posted: 'Today', language: 'English',
    postedBy: 'Acme Talent Partners', applyOptions: [{ label: 'Northwind careers', href: 'https://careers.example.test/jobs/platform' }],
    salaryProvenance: 'posted', officialPosting: posting(),
    boardClosed: { board: 'linkedin', reason: 'linkedin-no-longer-accepting', at: '2026-10-24T12:00:00.000Z' },
    listingLiveness: { verdict: 'closed', basis: 'structural', board: 'linkedin', at: '2026-10-24T12:00:00.000Z' },
    alternateListings: [{ board: 'indeed', url: 'https://www.indeed.com/viewjob?jk=synthetic-alternate' }], ...extra,
  };
}

function cardFor(job, protectedCards = []) {
  const built = buildJobTreeNodes({
    displayedJobs: [job],
    bucketTree: {
      roles: [{ name: 'Platform Engineering', jobIndices: [0] }],
      likelihoodBands: [{ label: 'Strong (70-100%)', minScore: 70, maxScore: 100 }],
      salaryRanges: [{ label: '$120k+', minSalary: 120000, maxSalary: null }],
    },
    originalPos: { x: 0, y: 0 }, hubId: 'board-fields', baseNodeId: 'fields', protectedCards,
  });
  return built.newNodes.find(node => node.type === 'jobcard');
}

function generateScope() {
  const source = fs.readFileSync(new URL('../../src/nodes/JobCardNode.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('const generateApplication = useCallback(');
  const end = source.indexOf('\n\n  return (', start);
  assert.ok(start >= 0 && end > start, 'the existing Generate sandbox boundaries remain available');
  return source.slice(start, end);
}

export default [
  {
    name: 'official fetch diagnostics remain bounded across source whitelists without changing lookup decisions',
    run() {
      const failure = officialPostingFetchFailure({ code: 'fetch-failed', statusCode: 403, message: 'PRIVATE RESPONSE BODY',
        reason: 'server-error' }, 'https://careers.example.test/blocked?utm_source=board#detail');
      assert.deepEqual(failure, { url: 'https://careers.example.test/blocked', code: 'fetch-failed', reason: 'access-denied', statusCode: 403 });
      const value = posting({ fetchFailures: [failure] });
      assert.deepEqual(normalizeOfficialPosting(value).fetchFailures, [failure]);
      assert.deepEqual(safeJob(row({ officialPosting: value })).officialPosting.fetchFailures, [failure]);
      assert.deepEqual(cardFor(row({ officialPosting: value })).data.officialPosting.fetchFailures, [failure]);
      const miss = { level: 'L5', outcome: 'not-found', employer: 'Northwind Labs', trail: ['bridge-research'], fetchFailures: [failure] };
      assert.equal(officialResearchSettled(miss), true, 'diagnostic receipts alone cannot change a completed decision');
      assert.equal(officialPostingLookupStatus(miss).state, 'not-found');
      const incomplete = { ...miss, trail: [...miss.trail, 'fetch-failed'] };
      assert.equal(officialResearchSettled(incomplete), false);
      assert.equal(officialPostingLookupStatus(incomplete).state, 'incomplete');
      assert.equal(normalizeOfficialPosting(posting({ fetchFailures: Array(OFFICIAL_FETCH_FAILURE_LIMIT).fill(failure) })).fetchFailures.length, OFFICIAL_FETCH_FAILURE_LIMIT);
      for (const fetchFailures of [null, {}, Array(OFFICIAL_FETCH_FAILURE_LIMIT + 1).fill(failure),
        [{ ...failure, url: 'http://careers.example.test/blocked' }], [{ ...failure, url: 'https://secret@careers.example.test/blocked' }],
        [{ ...failure, reason: 'PRIVATE RESPONSE BODY' }], [{ ...failure, message: 'PRIVATE RESPONSE BODY' }],
        [{ ...failure, statusCode: 600 }], [{ ...failure, statusCode: '403' }], [{ ...failure, code: 'closed' }]]) {
        assert.equal(normalizeOfficialPosting(posting({ fetchFailures })), null);
      }
    },
  },
  {
    name: 'semantic proof hashes survive shared whitelists and unresolved decisions stay retryable',
    run() {
      const semanticMatch = { version: 1, inputHash: 'c'.repeat(64), sourceHash: 'd'.repeat(64) };
      const value = posting({ semanticMatch, trail: ['semantic-match-v1'] });
      assert.deepEqual(normalizeOfficialPosting(value).semanticMatch, semanticMatch);
      assert.deepEqual(safeJob(row({ officialPosting: value })).officialPosting.semanticMatch, semanticMatch);
      assert.equal(normalizeOfficialPosting(posting({ semanticMatch: { ...semanticMatch, sourceHash: 'private source text' } })), null);
      for (const failure of ['semantic-uncertain', 'semantic-overflow', 'official-liveness-unconfirmed']) {
        const trail = boundedOfficialPostingTrail([...OFFICIAL_POSTING_TRAIL.filter(code => code.startsWith('comparative-')), 'semantic-match-v1', failure]);
        assert.ok(trail.includes(failure)); assert.ok(trail.includes('semantic-match-v1'));
        assert.equal(officialResearchSettled({ level: 'L5', outcome: 'closed', employer: 'Northwind Labs', trail }), false);
      }
      assert.ok(officialPostingComparativeTrail({ validA: true, validB: true, choiceA: 'uncertain', choiceB: 'uncertain' }).includes('comparative-choice-uncertain'));
    },
  },
  {
    name: 'comparative retryability survives saturation by other comparison trail codes',
    run() {
      const decoration = OFFICIAL_POSTING_TRAIL.filter(code => code.startsWith('comparative-')
        && !['comparative-invalid', 'comparative-unavailable'].includes(code));
      for (const failure of ['comparative-invalid', 'comparative-unavailable', 'comparative-truncated', 'insufficient-text']) {
        const trail = boundedOfficialPostingTrail([...decoration, failure]);
        assert.ok(trail.length <= 32);
        assert.equal(new Set(trail).size, trail.length);
        assert.ok(trail.includes(failure));
        assert.equal(officialResearchSettled({ level: 'L5', outcome: 'not-found', employer: 'Northwind Labs', trail }), false);
      }
    },
  },
  {
    name: 'comparative decision records preserve bounded choices and validity while invalid comparisons remain retryable',
    run() {
      const flags = officialPostingComparativeTrail({ validA: true, validB: true, choiceA: 'P2', choiceB: 'P2' });
      const trail = ['comparative-match', ...flags];
      assert.deepEqual(safeJob(row({ officialPosting: posting({ trail }) })).officialPosting.trail, trail);
      assert.ok(trail.includes('comparative-choice-p2'));
      assert.ok(trail.includes('comparative-a-valid')); assert.ok(trail.includes('comparative-b-valid'));
      assert.ok(officialPostingComparativeTrail({ choiceA: 'P1 PRIVATE TEXT', validA: 1 }).every(code => OFFICIAL_POSTING_TRAIL.includes(code)));
      const miss = { level: 'L5', outcome: 'not-found', employer: 'Northwind Labs', trail: ['comparative-none'] };
      assert.equal(officialResearchSettled(miss), true);
      for (const code of ['comparative-invalid', 'comparative-unavailable', 'comparative-truncated', 'insufficient-text']) {
        assert.equal(officialResearchSettled({ ...miss, trail: [...miss.trail, code] }), false);
        assert.deepEqual(safeJob(row({ officialPosting: posting({ trail: [code] }) })).officialPosting.trail, [code]);
      }
      assert.equal(officialResearchSettled({ ...miss, outcome: 'ambiguous', trail: ['comparative-disagree'] }), true);
      assert.equal(safeJob(row({ officialPosting: posting({ comparison: { evidence: 'PRIVATE TEXT' } }) })).officialPosting, undefined);
    },
  },
  {
    name: 'official-posting shared fields survive every whitelist and legacy card migration without drift',
    run() {
      assert.deepEqual(OFFICIAL_POSTING_ROW_FIELDS, ['postedBy', 'applyOptions', 'salaryProvenance', 'officialPosting', 'boardClosed', 'listingLiveness', 'alternateListings']);
      assert.ok(Object.isFrozen(OFFICIAL_POSTING_ROW_FIELDS));
      const input = row(); const card = cardFor(input); const frozen = safeJob(input); const scope = generateScope();
      const queuePayload = scope.slice(scope.indexOf('queueLocalApplication({'));
      const projection = fs.readFileSync(new URL('../../src/utils/officialPostingPreparation.js', import.meta.url), 'utf8');
      assert.match(queuePayload, /job: queueJob/u);
      assert.match(scope, /const queueJob = projectOfficialPostingGenerationJob\(cardBeforeQueue\.data\)/u);
      const migrated = migrateLegacyJobHubResults([
        { id: 'board-fields', type: 'jobhub', data: {} }, card,
      ]).find(node => node.id === 'board-fields').data.scoredJobs[0];
      for (const field of OFFICIAL_POSTING_ROW_FIELDS) {
        assert.equal(Object.hasOwn(card.data, field), true, `pushCard must explicitly assign ${field}`);
        assert.deepEqual(card.data[field], input[field], `pushCard must carry ${field}`);
        assert.equal(Object.hasOwn(frozen, field), true, `safeJob must whitelist ${field}`);
        assert.deepEqual(migrated[field], input[field], `legacy card migration must retain ${field}`);
        assert.match(projection, new RegExp(`\\b${field}:\\s*data\\.${field}\\b`, 'u'), `Generate's shared live projection must carry ${field}`);
      }
      assert.equal(frozen.postedBy, input.postedBy);
      assert.deepEqual(frozen.applyOptions, input.applyOptions);
      assert.equal(frozen.salaryProvenance, 'posted');
      assert.equal(frozen.officialPosting.employer, input.officialPosting.employer);
      assert.equal(frozen.googleCardUrl, input.googleCardUrl);
      assert.equal(frozen.sourceJobKey, input.sourceJobKey);
    },
  },
  {
    name: 'official-posting reused cards clear every absent resolution key while preserving their application state',
    run() {
      const prior = cardFor(row());
      prior.data.localApplication = { id: 'synthetic-application' };
      prior.data.careerSnapshotId = 'approved-original-snapshot';
      prior.data.additionalNotes = 'Keep the application notes.';
      const current = row({ reuseCardId: prior.id, careerSnapshotId: 'new-search-snapshot' });
      for (const field of OFFICIAL_POSTING_ROW_FIELDS) delete current[field];
      const before = JSON.stringify(prior);
      const reused = cardFor(current, [prior]);
      assert.equal(reused.id, prior.id);
      assert.equal(reused.data.localApplication, prior.data.localApplication);
      assert.equal(reused.data.careerSnapshotId, 'approved-original-snapshot');
      assert.equal(reused.data.additionalNotes, prior.data.additionalNotes);
      for (const field of OFFICIAL_POSTING_ROW_FIELDS) {
        assert.equal(Object.hasOwn(reused.data, field), true, `${field} must be overwritten even when absent`);
        assert.equal(reused.data[field], undefined, `the old ${field} must not survive the reusedData spread`);
      }
      assert.equal(JSON.stringify(prior), before, 'building the replacement cannot mutate the protected card');
    },
  },
  {
    name: 'official-posting metadata preserves scraped identity and tracks the closed variant token without a row applyUrl',
    run() {
      const input = row(); const baseline = { ...input };
      for (const field of OFFICIAL_POSTING_ROW_FIELDS) delete baseline[field];
      const protectedCard = cardFor(baseline);
      protectedCard.data.localApplication = { id: 'synthetic-application' };
      const reused = cardFor({ ...input, reuseCardId: protectedCard.id }, [protectedCard]);
      for (const field of ['title', 'company', 'location', 'salary', 'snippet', 'url', 'googleCardUrl', 'sourceJobKey']) {
        assert.equal(reused.data[field], baseline[field], `official metadata must leave ${field} unchanged`);
      }
      assert.equal(Object.hasOwn(input, 'applyUrl'), false);
      assert.equal(Object.hasOwn(reused.data, 'applyUrl'), false);
      assert.equal(buildPostingVariant(reused.data).liveness, 'closed');
      assert.equal(Object.hasOwn(buildPostingVariant(baseline), 'liveness'), false);
      assert.equal(postingVariantKey(buildPostingVariant(reused.data)), postingVariantKey({ ...buildPostingVariant(baseline), liveness: 'closed' }),
        'confirmed closure must be the only variant-key change from official metadata');
      assert.equal(reused.data.officialPosting.officialApplyUrl, input.officialPosting.officialApplyUrl);
      assert.equal(postingVariantKey(buildPostingVariant({ ...baseline, applyUrl: input.officialPosting.officialApplyUrl }))
        === postingVariantKey(buildPostingVariant(baseline)), false, 'the control proves a row applyUrl would change identity');
    },
  },
  {
    name: 'official-posting safeJob admits only its fixed job keys and validates every official enum',
    run() {
      const input = row({ arbitrary: 'discard', applyUrl: 'https://untrusted.example.test/form' });
      const frozen = safeJob(input);
      assert.deepEqual(Object.keys(frozen).sort(), [
        'title', 'company', 'snippet', 'location', 'salary', 'url', 'googleCardUrl', 'sourceJobKey',
        'source', 'posted', 'language', 'postedBy', 'applyUrl', 'applyOptions', 'salaryProvenance', 'officialPosting', 'boardClosed', 'listingLiveness', 'alternateListings', 'listingAudit', 'postingVariants',
      ].sort());
      assert.equal(frozen.applyUrl, input.applyUrl, 'the second safeJob retains the host-frozen apply URL; queue admission discards renderer authority separately');
      for (const level of OFFICIAL_POSTING_LEVELS) assert.equal(safeJob(row({ officialPosting: posting({ level }) })).officialPosting.level, level);
      for (const outcome of OFFICIAL_POSTING_OUTCOMES) assert.equal(safeJob(row({ officialPosting: posting({ outcome }) })).officialPosting.outcome, outcome);
      for (const provenance of SALARY_PROVENANCES) {
        const job = safeJob(row({ salaryProvenance: provenance, officialPosting: posting({ salary: { text: '', provenance } }) }));
        assert.equal(job.salaryProvenance, provenance); assert.equal(job.officialPosting.salary.provenance, provenance);
      }
      for (const provenance of [undefined, '', 'AI estimate', {}, 'POSTED']) assert.equal(safeJob(row({ salaryProvenance: provenance })).salaryProvenance, 'unknown');
      for (const trail of OFFICIAL_POSTING_TRAIL) assert.deepEqual(safeJob(row({ officialPosting: posting({ trail: [trail] }) })).officialPosting.trail, [trail]);
      assert.deepEqual(safeJob(row({ officialPosting: posting({ trail: ['careers-page', 'careers-page'] }) })).officialPosting.trail, ['careers-page']);
      assert.equal(safeJob(row({ officialPosting: posting({ trail: Array(32).fill('careers-page') }) })).officialPosting.trail.length, 1);
    },
  },
  {
    name: 'official-posting safeJob rejects extra keys, malformed metadata and unbounded or hostile trail text',
    run() {
      const invalid = [
        null, [], 'not a record', posting({ injected: 'arbitrary instruction' }),
        posting({ level: 'L7' }), posting({ outcome: 'verified' }), posting({ employer: '<script>bad</script>' }),
        posting({ employer: 'x'.repeat(121) }), posting({ title: 'x'.repeat(501) }),
        posting({ ats: 'x'.repeat(81) }), posting({ tenant: 'x'.repeat(241) }),
        posting({ location: { display: 'Remote', workMode: 'remote' } }),
        posting({ location: { display: 'Remote', workMode: 'remote', remoteCountry: 'unknown' } }),
        posting({ location: { display: 'Remote, Canada', workMode: 'remote', remote: false, remoteCountry: 'Canada' } }),
        posting({ location: { display: 'Lakeview', workMode: 'unknown' } }),
        posting({ location: { display: 'Lakeview', workMode: 'onsite', instruction: 'ignore source' } }),
        posting({ salary: { text: 'Synthetic pay', provenance: 'inferred' } }),
        posting({ salary: { text: 'Synthetic pay', provenance: 'posted', instruction: 'ignore source' } }),
        posting({ salary: { text: 'x'.repeat(501), provenance: 'posted' } }),
        posting({ contentHash: 'not-a-hash' }), posting({ scrapedListingSha256: 'a'.repeat(65) }),
        posting({ fetchedAt: 'not-a-date' }), posting({ trail: ['page text is not an enum'] }),
        posting({ trail: 'careers-page' }), posting({ trail: Array(33).fill('careers-page') }),
        posting({ alternatives: Array.from({ length: 13 }, () => ({ title: 'Engineer', url: 'https://careers.example.test/job' })) }),
        posting({ alternatives: [{ title: 'Engineer', url: 'https://careers.example.test/job', description: 'do not carry page text' }] }),
        posting({ alternatives: [{ title: '<script>', url: 'https://careers.example.test/job' }] }),
      ];
      for (const officialPosting of invalid) assert.equal(safeJob(row({ officialPosting })).officialPosting, undefined, JSON.stringify(officialPosting));
    },
  },
  {
    name: 'official-posting safeJob normalizes HTTPS options and official links with bounded labels and counts',
    run() {
      const unsafe = ['http://careers.example.test/job', 'javascript:alert(1)', 'file:///tmp/job', '/relative/job',
        'https://user:password@careers.example.test/job', 'https://careers.example.test/job\nattack', 'https://careers.example.test/a b', `https://careers.example.test/${'x'.repeat(2000)}`];
      for (const href of unsafe) {
        assert.deepEqual(safeJob(row({ applyOptions: [{ label: 'Apply', href }] })).applyOptions, [], href);
        for (const field of ['sourceUrl', 'officialApplyUrl']) assert.equal(safeJob(row({ officialPosting: posting({ [field]: href }) })).officialPosting, undefined, field);
        assert.equal(safeJob(row({ officialPosting: posting({ alternatives: [{ title: 'Engineer', url: href }] }) })).officialPosting, undefined, 'alternative URL');
      }
      const applyOptions = [
        { label: `  Careers\n\t${'x'.repeat(150)}`, href: 'https://careers.example.test/job?keep=yes&utm_source=google#apply', injected: 'discard' },
        { label: 'duplicate', href: 'https://careers.example.test/job?keep=yes#other' },
        ...Array.from({ length: 12 }, (_, index) => ({ label: `Option ${index}`, href: `https://careers.example.test/job/${index}` })),
      ];
      const frozen = safeJob(row({ applyOptions }));
      assert.equal(frozen.applyOptions.length, 8);
      assert.equal(frozen.applyOptions[0].href, 'https://careers.example.test/job?keep=yes');
      assert.equal(frozen.applyOptions[0].label.length, 120);
      assert.equal(/[\n\t]/u.test(frozen.applyOptions[0].label), false);
      assert.deepEqual(Object.keys(frozen.applyOptions[0]).sort(), ['href', 'label']);
      assert.equal(new Set(frozen.applyOptions.map(option => option.href)).size, 8);
      assert.equal(frozen.officialPosting.sourceUrl, 'https://careers.example.test/jobs/platform?keep=yes');
      assert.equal(frozen.officialPosting.officialApplyUrl, 'https://apply.example.test/platform?keep=yes');
      assert.equal(frozen.officialPosting.alternatives[0].url, 'https://careers.example.test/jobs/alternative');
    },
  },
  {
    name: 'official-posting metadata never enters any supported discovery, audit, adjudication or writer stage prompt',
    run() {
      const auditAt = '2026-10-26T12:34:56.000Z';
      const job = safeJob(row({ postedBy: 'Unique Synthetic Poster Sentinel', snippet: 'Unique scraped snippet sentinel.',
        applyOptions: [{ label: 'Unique apply option', href: 'https://apply-option-sentinel.example.test/job' }],
        listingAudit: { outcome: 'open', basis: 'ai', at: auditAt },
        postingVariants: [{ location: 'Remote, Canada', url: 'https://listing.example.test/job/platform', liveness: 'closed' }] }));
      assert.equal(job.listingAudit.at, auditAt);
      assert.equal(job.postingVariants[0]?.liveness, 'closed');
      job.applyUrl = 'https://frozen-apply-sentinel.example.test/job';
      const sentinels = [job.postedBy, job.snippet, job.applyOptions[0].href, job.applyUrl,
        job.googleCardUrl, job.sourceJobKey, 'tenant-unproven', 'bridge-unavailable',
        job.officialPosting.officialApplyUrl, job.officialPosting.sourceUrl, job.officialPosting.alternatives[0].url,
        job.boardClosed.reason, job.boardClosed.at];
      const input = { jobId: 'synthetic-metadata-job', job, authorityProtocol: 'requirements-ledger.v3', careerAuthority: { version: 1 },
        __careerAuthorityIndex: { identity: { name: 'Jordan Sample', contact: ['jordan@example.test'] } },
        hostCareerEvidenceCatalog: [], sourceRoles: [], careerSkillEvidence: { skills: [] } };
      const sharedState = { handoffCode: 'synthetic-handoff', baseHashes: {},
        authorityStore: { receipt: () => ({ digest: 'c'.repeat(64), streams: {} }) },
        authorityListingPage: { text: 'Maintain dependable platform services.', index: 0, pageCount: 1, digest: 'd'.repeat(64) },
        authorityListingAuditPage: { index: 0, pageCount: 1, digest: 'd'.repeat(64), auditDigest: 'e'.repeat(64), units: [{ unitId: 'unit-1', text: 'Maintain dependable platform services.' }] },
        authorityAdjudicationCase: { storeDigest: 'c'.repeat(64), caseDigest: 'f'.repeat(64), disputedUnitIds: ['unit-1'], units: [{ unitId: 'unit-1', text: 'Maintain dependable platform services.', before: '', after: '' }] } };
      const prompts = ['requirements', 'requirements-audit', 'requirements-adjudication'].map(stage => [stage, __pastePromptForTests({ input, state: { ...sharedState, stage } })]);
      const discovery = JSON.parse(prompts[0][1].split('Authoritative context:\n')[1]);
      assert.equal(discovery.job.company, job.company, 'ordinary identifying facts stay in the discovery context');
      assert.equal(discovery.job.url, job.url, 'the original listing URL remains an identifying fact');
      for (const field of [...OFFICIAL_POSTING_ROW_FIELDS, 'listingAudit', 'snippet', 'applyUrl', 'googleCardUrl', 'sourceJobKey']) assert.equal(Object.hasOwn(discovery.job, field), false, field);
      assert.equal(discovery.job.postingVariants[0].liveness, undefined);
      const sourcePrompt = writeVerifySourcePrompt({ job, posting: 'Maintain dependable platform services.', requirements: [], listingEvidence: [],
        identity: { name: 'Jordan Sample' }, sourceRoles: [], profile: { skills: [] }, catalog: [] });
      const structured = { resume: { roles: [], projects: [], skills: [], education: [], credentials: [] }, coverLetter: { paragraphs: [] } };
      const state = { ordinal: 0, candidates: [{ id: 'candidate-1', status: 'accepted', plainText: 'Synthetic application text.', structured, unitState: { mode: 'full' } }],
        ranking: ['candidate-1'], factIndex: 0, factFindings: [{ id: 'synthetic-unit', claim: 'Synthetic claim.', reason: 'Synthetic absence.' }] };
      for (const stage of WRITE_VERIFY_STAGES.filter(stage => stage !== 'write-verify-human-stop')) {
        prompts.push([stage, writeVerifyPrompt({ stage, state, sourcePrompt, posting: 'Maintain dependable platform services.', hand: 'Synthetic approved evidence.', envelope: { stage } })]);
      }
      for (const [stage, prompt] of prompts) for (const sentinel of [...sentinels, auditAt, 'listingAudit', '"liveness":"closed"']) assert.equal(prompt.includes(sentinel), false, `${stage} printed metadata ${sentinel}`);
      assert.equal(prompts.length, 11, 'all three supported discovery stages and eight writer stages are checked');
    },
  },
];
