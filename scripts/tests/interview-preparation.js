import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { assert } from './testHelpers.js';
import {
  buildInterviewBrief,
  captureInterviewPreparationBundle,
  interviewPreparedBriefRecordId,
  isPublishedInterviewBrief,
  loadInterviewPreparationBundle,
  loadInterviewPreparedBrief,
  normalizeInterviewPreparationJobUrl,
  registerInterviewPreparationHandlers,
  publishInterviewPreparedBrief,
  validateInterviewBriefAssessment,
  validateInterviewBriefRequestArgs,
  validateInterviewPreparationLoadArgs,
} from '../../electron/ipc/interviewPreparation.js';
import { formatOriginalJobListingMarkdown } from '../../electron/ipc/applicationBundle.js';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const SNAPSHOT_ID = 'a'.repeat(64);

async function fixture(root, { verified = true, auditMode = 'valid', auditJob } = {}) {
  const bundle = path.join(root, 'bundle');
  await fs.promises.mkdir(bundle, { recursive: true });
  const html = '<html><body><section data-ic-document-panel="resume"><main>Candidate email@example.test led delivery.</main></section><section data-ic-document-panel="cover"><main>Build reliable systems.</main></section><script>throw new Error("must not run")</script></body></html>';
  const listing = '# Product Manager\n\nAcme seeks a product leader.\n';
  const audit = { version: 1, schema: 'infinite-canvas-generation-audit', job: auditJob || { title: 'Product Manager', company: 'Acme', location: 'Toronto' }, savedArtifacts: { applicationHtmlSha256: verified ? sha(html) : '0'.repeat(64), originalJobListingSha256: sha(listing), resumePdfSha256: null, coverLetterPdfSha256: null } };
  const writes = [
    fs.promises.writeFile(path.join(bundle, 'Application.html'), html),
    fs.promises.writeFile(path.join(bundle, 'Original Job Listing.md'), listing),
  ];
  if (auditMode === 'valid') writes.push(fs.promises.writeFile(path.join(bundle, 'Generation Audit.json'), JSON.stringify(audit)));
  if (auditMode === 'invalid') writes.push(fs.promises.writeFile(path.join(bundle, 'Generation Audit.json'), JSON.stringify({ version: 9, schema: 'wrong', job: audit.job })));
  await Promise.all(writes);
  return bundle;
}

function briefValue() {
  return {
    role: { title: 'Product Manager', company: 'Acme', location: 'Toronto', summary: 'Owns product outcomes.' },
    roleThemes: ['Customer discovery'],
    companyFacts: [{ fact: 'Acme serves teams.', sourceUrl: 'https://acme.test/news', sourceDate: '2026-01-01', evidenceQuote: 'Acme serves teams.' }],
    recentContext: [], likelyQuestions: ['How would you prioritize?'], questionsToAsk: ['What changes this year?'],
    applicationPositioning: [{ documentKind: 'coverLetter', point: 'Build reliable systems.', evidenceQuote: 'Build reliable systems.' }], warnings: ['Unknown: interview format.'],
  };
}

async function promptsFor(artifact, root) {
  let rawPrompt = ''; let assessmentPrompt = '';
  await buildInterviewBrief({ nodeId: 'node-1', snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: artifact.artifactId, manualAiRunId: 'run-1', userDataPath: root,
    callRaw: async prompt => { rawPrompt = prompt; return 'Acme serves teams. Source: https://acme.test/news Published 2026-01-01'; },
    callText: async prompt => { assessmentPrompt = prompt; throw new Error('stop after recording the assessment prompt'); } }).catch(() => undefined);
  return { rawPrompt, assessmentPrompt };
}

export default [
  {
    name: 'interview preparation: captures only fixed safe files and persists an opaque verified artifact',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-'));
      try {
        const bundle = await fixture(root);
        const artifact = await captureInterviewPreparationBundle({ directory: bundle, userDataPath: root });
        assert(/^[a-f0-9]{64}$/.test(artifact.artifactId), 'artifact must be content addressed');
        assert(artifact.verification.status === 'verified', 'matching saved-artifact hashes must verify');
        assert(!JSON.stringify(artifact).includes(bundle) && !JSON.stringify(artifact).includes('email@example.test') && !Object.hasOwn(artifact, 'listingText') && !Object.hasOwn(artifact, 'applicationPositioning') && !Object.hasOwn(artifact, 'digests'), 'public projection must not disclose source path, excerpts, contact identity, or per-file digests');
        assert(/^[a-f0-9]{64}$/.test(artifact.applicationArtifactDigest), 'public metadata must provide deterministic application digest');
        const loaded = await loadInterviewPreparationBundle({ artifactId: artifact.artifactId, userDataPath: root });
        assert(loaded?.artifactId === artifact.artifactId && !Object.hasOwn(loaded, 'listingText') && !Object.hasOwn(loaded, 'applicationPositioning'), 'opaque artifact should survive reload without private prose');
        await fs.promises.symlink(path.join(bundle, 'Application.html'), path.join(bundle, 'Resume.pdf'));
        const rejected = await captureInterviewPreparationBundle({ directory: bundle, userDataPath: root }).then(() => false, () => true);
        assert(rejected, 'a symlinked allowed sibling must be rejected');
        return { artifactId: artifact.artifactId.slice(0, 12) };
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview preparation: records legacy/hash-mismatch status and rejects unsafe URL/request shapes',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-'));
      try {
        const bundle = await fixture(root, { verified: false });
        const artifact = await captureInterviewPreparationBundle({ directory: bundle, userDataPath: root });
        assert(artifact.verification.status === 'hash-mismatch', 'mismatched durable receipt must not verify');
        await fs.promises.unlink(path.join(bundle, 'Generation Audit.json'));
        const legacy = await captureInterviewPreparationBundle({ directory: bundle, userDataPath: root });
        assert(legacy.verification.status === 'legacy-unverified' && legacy.job.title === 'Product Manager', 'a missing legacy receipt must be explicitly unverified while retaining the listing heading read before normalization');
        const invalidBundle = await fixture(path.join(root, 'invalid-parent'), { auditMode: 'invalid' });
        const invalidAudit = await captureInterviewPreparationBundle({ directory: invalidBundle, userDataPath: root });
        assert(invalidAudit.verification.status === 'unverified-invalid-audit' && invalidAudit.job.company === '', 'malformed/currently incompatible audits must not claim verification or inject job identity');
        await fs.promises.writeFile(path.join(bundle, 'Original Job Listing.md'), 'x'.repeat(2 * 1024 * 1024 + 1));
        assert(await captureInterviewPreparationBundle({ directory: bundle, userDataPath: root }).then(() => false, () => true), 'bounded bundle reads must reject oversized source files');
        assert(!normalizeInterviewPreparationJobUrl('example.test') && !normalizeInterviewPreparationJobUrl('https://user:pass@example.test') && !normalizeInterviewPreparationJobUrl('javascript:alert(1)') && !normalizeInterviewPreparationJobUrl('https://example.test/a\u202Eb') && !normalizeInterviewPreparationJobUrl('https://example.test/a\u0085b'), 'URL boundary must require absolute credential-free http(s) without C1 or bidi controls');
        let invalid = false;
        try { validateInterviewBriefRequestArgs({ nodeId: 'node-1', snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://example.test/', bundleArtifactId: artifact.artifactId, manualAiRunId: 'run-1', path: bundle }); } catch { invalid = true; }
        assert(invalid, 'extra renderer keys must be rejected before registration');
        invalid = false;
        try { validateInterviewPreparationLoadArgs({ artifactId: artifact.artifactId }); } catch { invalid = true; }
        assert(invalid, 'bundle reload requires its Interview Helper node scope');
        return { rejected: true };
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview preparation: rejects blank required files and revalidates bounded artifact reads and publication',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-'));
      const originalOpen = fs.promises.open;
      const originalLink = fs.promises.link;
      try {
        const blankHtml = await fixture(path.join(root, 'blank-html'));
        await fs.promises.writeFile(path.join(blankHtml, 'Application.html'), ' \n\t ');
        assert(await captureInterviewPreparationBundle({ directory: blankHtml, userDataPath: root }).then(() => false, () => true), 'a whitespace-only required Application.html must not mint an artifact');
        const blankListing = await fixture(path.join(root, 'blank-listing'));
        await fs.promises.writeFile(path.join(blankListing, 'Original Job Listing.md'), '\n\t');
        assert(await captureInterviewPreparationBundle({ directory: blankListing, userDataPath: root }).then(() => false, () => true), 'a whitespace-only required Original Job Listing.md must not mint an artifact');

        const bundle = await fixture(path.join(root, 'bounded-read'));
        const artifact = await captureInterviewPreparationBundle({ directory: bundle, userDataPath: root });
        const target = path.join(await fs.promises.realpath(root), 'interview-helper-artifacts', `${artifact.artifactId}.json`);
        let grewSameInode = false;
        fs.promises.open = async (filePath, flags, ...rest) => {
          const handle = await originalOpen(filePath, flags, ...rest);
          if (filePath === target && typeof flags === 'number' && !grewSameInode) {
            const read = handle.read.bind(handle);
            handle.read = async (...args) => {
              if (!grewSameInode) {
                grewSameInode = true;
                await fs.promises.appendFile(target, Buffer.alloc(2 * 1024 * 1024 + 1));
              }
              return read(...args);
            };
          }
          return handle;
        };
        const grown = await loadInterviewPreparationBundle({ artifactId: artifact.artifactId, userDataPath: root });
        assert(grewSameInode && grown === null, 'an artifact that grows in place after descriptor validation must be rejected through a bounded read');
        fs.promises.open = originalOpen;

        const postPublishBundle = await fixture(path.join(root, 'post-publish'));
        await fs.promises.appendFile(path.join(postPublishBundle, 'Original Job Listing.md'), 'Different immutable artifact.\n');
        let swappedPublishedTarget = false;
        fs.promises.link = async (...args) => {
          const result = await originalLink(...args);
          if (!swappedPublishedTarget && String(args[1]).endsWith('.json')) {
            swappedPublishedTarget = true;
            await fs.promises.unlink(args[1]);
            await fs.promises.writeFile(args[1], '{"artifactId":"swapped"}');
          }
          return result;
        };
        const swappedRejected = await captureInterviewPreparationBundle({ directory: postPublishBundle, userDataPath: root }).then(() => false, () => true);
        assert(swappedPublishedTarget && swappedRejected, 'a target swapped after atomic publication must fail the independent reload before success is returned');
        return { bounded: true };
      } finally {
        fs.promises.open = originalOpen;
        fs.promises.link = originalLink;
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview preparation: honors cancellation before picker/capture persistence',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-'));
      try {
        const bundle = await fixture(root);
        const alreadyCancelled = new AbortController(); alreadyCancelled.abort(new Error('cancelled'));
        const captureRejected = await captureInterviewPreparationBundle({ directory: bundle, userDataPath: root, signal: alreadyCancelled.signal }).then(() => false, () => true);
        assert(captureRejected && !fs.existsSync(path.join(root, 'interview-helper-artifacts')), 'a pre-cancelled capture must not create an artifact store');
        const handlers = new Map(); const controller = new AbortController(); let captured = false;
        registerInterviewPreparationHandlers({
          appInstance: { getPath: () => root },
          registerHandler: (channel, handler) => handlers.set(channel, handler),
          picker: async () => { controller.abort(new Error('cancelled in picker')); return bundle; },
          captureBundle: async () => { captured = true; return {}; },
        });
        const pickerRejected = await handlers.get('select-interview-preparation-bundle')({}, { nodeId: 'node-1' }, controller.signal).then(() => false, () => true);
        assert(pickerRejected && !captured, 'cancellation after native picker must prevent capture/persistence');
        return { cancelled: true };
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview preparation: preserves a published artifact when a concurrent caller accepts it before cancellation',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-'));
      const originalLink = fs.promises.link;
      try {
        const bundle = await fixture(root);
        let holdFirstPublish;
        const releaseFirstPublish = new Promise(resolve => { holdFirstPublish = resolve; });
        let targetLinked;
        const firstTargetLinked = new Promise(resolve => { targetLinked = resolve; });
        let firstTarget = true;
        fs.promises.link = async (...args) => {
          const result = await originalLink(...args);
          if (firstTarget && String(args[1]).endsWith('.json')) {
            firstTarget = false;
            targetLinked();
            await releaseFirstPublish;
          }
          return result;
        };
        const controller = new AbortController();
        const cancelledCapture = captureInterviewPreparationBundle({ directory: bundle, userDataPath: root, signal: controller.signal });
        await firstTargetLinked;
        const accepted = await captureInterviewPreparationBundle({ directory: bundle, userDataPath: root });
        controller.abort(new Error('cancelled after concurrent acceptance'));
        holdFirstPublish();
        assert(await cancelledCapture.then(() => false, () => true), 'the cancelled publisher must still reject');
        const target = path.join(root, 'interview-helper-artifacts', `${accepted.artifactId}.json`);
        assert(fs.existsSync(target), 'cancellation must not delete an immutable target already accepted by an EEXIST caller');
        const loaded = await loadInterviewPreparationBundle({ artifactId: accepted.artifactId, userDataPath: root });
        assert(loaded?.artifactId === accepted.artifactId, 'the accepted content-addressed artifact must remain reloadable');
        return { preserved: true };
      } finally {
        fs.promises.link = originalLink;
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview preparation: validates research provenance and binds stable brief inputs without raw research',
    run: async () => {
      const bundle = { artifactId: 'b'.repeat(64), digests: { applicationHtml: 'c'.repeat(64) }, job: { title: 'Product Manager', company: 'Acme', location: 'Toronto' }, listingText: 'Product Manager at Acme', applicationPositioning: { resume: 'Delivery work.', coverLetter: 'Build reliable systems.' } };
      const rawResearch = 'Acme serves teams. Source: https://acme.test/news Published 2026-01-01';
      const context = { rawResearch, bundle, snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: bundle.artifactId, createdAt: '2026-10-08T00:00:00.000Z' };
      const brief = validateInterviewBriefAssessment(briefValue(), context);
      assert(brief.version === 1 && brief.inputs.careerSnapshotId === SNAPSHOT_ID && brief.sources.length === 1 && !JSON.stringify(brief).includes(rawResearch) && !JSON.stringify(brief).includes('evidenceQuote'), 'brief must use the compact public projection without private quotes');
      const emptySummaryValue = briefValue(); emptySummaryValue.role.summary = '';
      const emptySummaryBrief = validateInterviewBriefAssessment(emptySummaryValue, context);
      assert(emptySummaryBrief.role.summary === '', 'the worker public projection must retain an explicitly empty optional summary');
      const bad = briefValue(); bad.companyFacts[0].evidenceQuote = 'invented quote';
      let quoteRejected = false;
      try { validateInterviewBriefAssessment(bad, context); } catch { quoteRejected = true; }
      assert(quoteRejected, 'research quote must be literal raw-research provenance');
      const unknownUrl = briefValue(); unknownUrl.companyFacts[0].sourceUrl = 'https://not-present.test/news';
      let urlRejected = false;
      try { validateInterviewBriefAssessment(unknownUrl, context); } catch { urlRejected = true; }
      assert(urlRejected, 'research source URL must be literal raw-research provenance');
      const inventedFact = briefValue(); inventedFact.companyFacts[0].fact = 'Acme invented a capability.';
      let factRejected = false;
      try { validateInterviewBriefAssessment(inventedFact, context); } catch { factRejected = true; }
      assert(factRejected, 'research facts must be literal raw-research provenance rather than a claim paired with an unrelated valid quote');
      const inventedPositioning = briefValue(); inventedPositioning.applicationPositioning[0].point = 'Invented candidate positioning.';
      let positioningRejected = false;
      try { validateInterviewBriefAssessment(inventedPositioning, context); } catch { positioningRejected = true; }
      assert(positioningRejected, 'application positioning points must be literal document provenance rather than a claim paired with an unrelated valid quote');
      const slashRawResearch = 'Acme serves teams. Source: https://example.com Published 2026-01-01';
      const slashContext = { ...context, rawResearch: slashRawResearch };
      const normalizedUrl = briefValue(); normalizedUrl.companyFacts[0].sourceUrl = 'https://example.com';
      const normalizedUrlBrief = validateInterviewBriefAssessment(normalizedUrl, slashContext);
      assert(normalizedUrlBrief.companyFacts[0].sourceUrl === 'https://example.com/', 'a literal raw source URL may be canonicalized for persistence after provenance validation');
      const normalizedOnlyUrl = briefValue(); normalizedOnlyUrl.companyFacts[0].sourceUrl = 'https://example.com/';
      let normalizedOnlyUrlRejected = false;
      try { validateInterviewBriefAssessment(normalizedOnlyUrl, slashContext); } catch { normalizedOnlyUrlRejected = true; }
      assert(normalizedOnlyUrlRejected, 'a nonliteral canonical source URL must be rejected even if its raw URL equivalent exists');
      const privateSourceResearch = 'Acme serves teams. Source: https://acme.test/news?access_token=top-secret&email=ada%40example.test#fragment Published 2026-01-01';
      const privateSourceContext = { ...context, rawResearch: privateSourceResearch };
      const privateSource = briefValue();
      privateSource.companyFacts[0].sourceUrl = 'https://acme.test/news?access_token=top-secret&email=ada%40example.test#fragment';
      const redactedSourceBrief = validateInterviewBriefAssessment(privateSource, privateSourceContext);
      assert(redactedSourceBrief.companyFacts[0].sourceUrl === 'https://acme.test/news'
        && redactedSourceBrief.sources[0].sourceUrl === 'https://acme.test/news'
        && !JSON.stringify(redactedSourceBrief).match(/access_token|top-secret|ada%40example|fragment/iu), 'raw evidence URLs must be literal before their persisted citation drops arbitrary query and fragment data');
      const googleSourceResearch = 'Acme Jobs source https://www.google.com/search?q=private%40example.test&udm=8&htidocid=abc123&signature=secret Published 2026-01-01';
      const googleSourceContext = { ...context, rawResearch: googleSourceResearch };
      const googleSource = briefValue();
      googleSource.companyFacts[0].sourceUrl = 'https://www.google.com/search?q=private%40example.test&udm=8&htidocid=abc123&signature=secret';
      googleSource.companyFacts[0].fact = 'Acme Jobs source';
      googleSource.companyFacts[0].evidenceQuote = 'Acme Jobs source';
      const redactedGoogleBrief = validateInterviewBriefAssessment(googleSource, googleSourceContext);
      assert(redactedGoogleBrief.sources[0].sourceUrl === 'https://www.google.com/search?udm=8&htidocid=abc123'
        && !redactedGoogleBrief.sources[0].sourceUrl.includes('q=') && !redactedGoogleBrief.sources[0].sourceUrl.includes('signature'), 'Google research citations must retain only their constrained Jobs identity');
      const nonliteralDate = briefValue(); nonliteralDate.companyFacts[0].sourceDate = 'January 1, 2026';
      let nonliteralDateRejected = false;
      try { validateInterviewBriefAssessment(nonliteralDate, context); } catch { nonliteralDateRejected = true; }
      assert(nonliteralDateRejected, 'research source dates must be literal raw-research provenance');
      const unknownDate = briefValue(); unknownDate.companyFacts[0].sourceDate = 'unknown';
      assert(validateInterviewBriefAssessment(unknownDate, context).companyFacts[0].sourceDate === 'unknown', 'unknown is the only source-date value allowed without raw-research provenance');
      const emptyDate = briefValue(); emptyDate.companyFacts[0].sourceDate = '';
      let emptyDateRejected = false;
      try { validateInterviewBriefAssessment(emptyDate, context); } catch { emptyDateRejected = true; }
      assert(emptyDateRejected, 'blank source dates must not silently become unknown');
      const conflictingRole = briefValue(); conflictingRole.role = { ...conflictingRole.role, title: 'Invented title', company: 'Invented company', location: 'Elsewhere' };
      const boundRole = validateInterviewBriefAssessment(conflictingRole, context);
      assert(boundRole.role.title === 'Product Manager' && boundRole.role.company === 'Acme' && boundRole.role.location === 'Toronto', 'captured bundle identity must take precedence over worker role identity');
      const incompleteBundle = { ...bundle, job: { title: '', company: '', location: '' }, listingText: 'Product Manager role' };
      const incompleteContext = { ...context, bundle: incompleteBundle, rawResearch: `${rawResearch} Acme Toronto` };
      const groundedFallback = validateInterviewBriefAssessment(briefValue(), incompleteContext);
      assert(groundedFallback.role.title === 'Product Manager' && groundedFallback.role.company === 'Acme' && groundedFallback.role.location === 'Toronto', 'literal worker role fallbacks may use captured listing or raw research');
      const hallucinatedFallback = briefValue(); hallucinatedFallback.role = { ...hallucinatedFallback.role, title: 'Invented title', company: 'Invented company', location: 'Elsewhere' };
      const unknownFallback = validateInterviewBriefAssessment(hallucinatedFallback, incompleteContext);
      assert(unknownFallback.role.title === 'Unknown role' && unknownFallback.role.company === 'Unknown company' && unknownFallback.role.location === 'Unknown', 'unsupported worker role fallbacks must become unknown');
      const unsafeSummary = briefValue(); unsafeSummary.role.summary = 'Café — product\u202E strategy';
      const safeSummary = validateInterviewBriefAssessment(unsafeSummary, context);
      assert(safeSummary.role.summary === 'Café — product strategy', 'generated brief display text must remove bidi controls without stripping ordinary non-ASCII punctuation or letters');
      const unsafeDate = briefValue(); unsafeDate.companyFacts[0].sourceDate = '2026-01-0\u202E1';
      let dateRejected = false;
      try { validateInterviewBriefAssessment(unsafeDate, context); } catch { dateRejected = true; }
      assert(dateRejected, 'research source dates with bidi controls must be rejected rather than normalized');
      let rawOpts; let textOpts;
      let rawPrompt; let assessmentPrompt;
      const result = await buildInterviewBrief({ nodeId: 'node-1', snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: bundle.artifactId, manualAiRunId: 'run-1', userDataPath: '/tmp', loadBundle: async () => bundle, callRaw: async (prompt, opts) => { rawPrompt = prompt; rawOpts = opts; return rawResearch; }, callText: async (prompt, opts) => { assessmentPrompt = prompt; textOpts = opts; return emptySummaryValue; } });
      assert(rawOpts.task === 'interview-brief-research' && rawOpts.grounding === true && textOpts.task === 'interview-brief-assessment' && result.brief.briefId === emptySummaryBrief.briefId && result.brief.role.summary === '', 'two-stage worker requests must preserve an empty optional summary in their stable public digest');
      assert(/untrusted-interview-canonical-job-url-/u.test(rawPrompt) && /untrusted-interview-canonical-job-url-/u.test(assessmentPrompt) && /untrusted-interview-original-listing-/u.test(rawPrompt) && /untrusted-interview-grounded-research-/u.test(assessmentPrompt) && /untrusted-interview-application-positioning-/u.test(assessmentPrompt), 'all renderer- or external-controlled prompt inputs must use nonce-bound wrappers');
      assert(/<untrusted-interview-canonical-job-url-[^>]+>\nhttps:\/\/jobs\.example\.test\/1\n<\/untrusted-interview-canonical-job-url-/u.test(rawPrompt), 'the canonical URL must occur only inside its untrusted-data boundary');
      assert(rawPrompt.includes("Compare the live canonical job URL's role/company identity") && assessmentPrompt.includes('If the page is inaccessible, the identity is ambiguous, or the targets mismatch, state that plainly in warnings.'), 'both worker stages must preserve role identity and expose inaccessible, ambiguous, or mismatched targets as warnings');
      assert(assessmentPrompt.includes('fact, sourceUrl itself, and evidenceQuote must each be exact literal substrings of RAW RESEARCH') && assessmentPrompt.includes('sourceDate must be exactly "unknown" or an exact literal substring of RAW RESEARCH'), 'assessment prompt must state literal fact/URL and exact-or-unknown date provenance');
      assert(assessmentPrompt.includes('fallback title, company, or location must be an exact literal substring of ORIGINAL LISTING or RAW RESEARCH'), 'assessment prompt must require literal listing-or-research provenance for worker role fallbacks');
      assert((() => { try { rawOpts.responseValidator(''); return false; } catch { return true; } })(), 'raw response validator must throw for empty output');
      const cancelledAfterResearch = new AbortController();
      let assessmentStarted = false;
      const cancellationRejected = await buildInterviewBrief({
        nodeId: 'node-1', snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: bundle.artifactId, manualAiRunId: 'run-2', signal: cancelledAfterResearch.signal, userDataPath: '/tmp',
        loadBundle: async () => bundle,
        callRaw: async () => { cancelledAfterResearch.abort(new Error('cancelled after research')); return rawResearch; },
        callText: async () => { assessmentStarted = true; return briefValue(); },
      }).then(() => false, () => true);
      assert(cancellationRejected && !assessmentStarted, 'cancellation after research must prevent an assessment handoff from being started');
      return { briefId: brief.briefId.slice(0, 12) };
    },
  },
  {
    name: 'interview preparation: seals, reloads, and verifies the exact main-published prepared brief',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prepared-brief-'));
      try {
        const bundle = { artifactId: 'b'.repeat(64), digests: { applicationHtml: 'c'.repeat(64) }, job: { title: 'Product Manager', company: 'Acme', location: 'Toronto' }, listingText: 'Product Manager at Acme', applicationPositioning: { resume: 'Delivery work.', coverLetter: 'Build reliable systems.' } };
        const context = { rawResearch: 'Acme serves teams. Source: https://acme.test/news Published 2026-01-01', bundle, snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: bundle.artifactId, createdAt: '2026-10-08T00:00:00.000Z' };
        const sealedBrief = validateInterviewBriefAssessment(briefValue(), context);
        const published = await publishInterviewPreparedBrief({ brief: sealedBrief, userDataPath: root });
        assert(isPublishedInterviewBrief(published.brief) && published.briefRecordId === interviewPreparedBriefRecordId(sealedBrief), 'main publication must seal the complete validated public brief under its full-record digest');
        const concurrent = await Promise.all([publishInterviewPreparedBrief({ brief: sealedBrief, userDataPath: root }), publishInterviewPreparedBrief({ brief: sealedBrief, userDataPath: root })]);
        assert(concurrent.every(item => item.briefRecordId === published.briefRecordId), 'concurrent same-record publication must accept only the exact already-verified immutable record');
        const loaded = await loadInterviewPreparedBrief({ briefRecordId: published.briefRecordId, brief: sealedBrief, userDataPath: root });
        assert(JSON.stringify(loaded) === JSON.stringify(sealedBrief), 'the exact sealed brief must reload for the window authority boundary');
        const forged = structuredClone(sealedBrief); forged.createdAt = '2026-10-08T01:00:00.000Z';
        assert(await loadInterviewPreparedBrief({ briefRecordId: published.briefRecordId, brief: forged, userDataPath: root }) === null, 'a changed createdAt must not reuse an existing semantic brief record');
        const changed = structuredClone(sealedBrief); changed.roleThemes = ['Changed but self-hashed'];
        changed.briefId = sha((value => {
          const semantic = { version: value.version, inputs: value.inputs, role: value.role, roleThemes: value.roleThemes, companyFacts: value.companyFacts, recentContext: value.recentContext, likelyQuestions: value.likelyQuestions, questionsToAsk: value.questionsToAsk, applicationPositioning: value.applicationPositioning, warnings: value.warnings };
          const stable = input => Array.isArray(input) ? `[${input.map(stable).join(',')}]` : (!input || typeof input !== 'object' ? JSON.stringify(input) : `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${stable(input[key])}`).join(',')}}`);
          return stable(semantic);
        })(changed));
        assert(await loadInterviewPreparedBrief({ brief: changed, userDataPath: root }) === null, 'a renderer can self-hash a forged brief but cannot create its main-owned record');
        const recordPath = path.join(root, 'interview-helper-prepared-briefs', `${published.briefRecordId}.json`);
        await fs.promises.writeFile(recordPath, '{"schemaVersion":1}');
        assert(await loadInterviewPreparedBrief({ briefRecordId: published.briefRecordId, brief: sealedBrief, userDataPath: root }) === null, 'a corrupt stored prepared-brief record must be rejected');
        await fs.promises.unlink(recordPath);
        await fs.promises.symlink(path.join(root, 'missing.json'), recordPath);
        assert(await loadInterviewPreparedBrief({ briefRecordId: published.briefRecordId, brief: sealedBrief, userDataPath: root }) === null, 'a symlinked prepared-brief record must be rejected');
        await fs.promises.unlink(recordPath);
        await fs.promises.writeFile(recordPath, 'x'.repeat(512 * 1024 + 1));
        assert(await loadInterviewPreparedBrief({ briefRecordId: published.briefRecordId, brief: sealedBrief, userDataPath: root }) === null, 'an oversized prepared-brief record must be rejected before parsing');
        await fs.promises.unlink(recordPath);

        const handlers = new Map();
        registerInterviewPreparationHandlers({ appInstance: { getPath: () => root }, registerHandler: (channel, handler) => handlers.set(channel, handler), buildBrief: async () => ({ brief: sealedBrief }),
          // This case isolates brief publication. Separate answer-bank tests
          // exercise the third handoff, grounding and real sealed store.
          buildAnswers: async () => ({ bank: {} }), publishAnswers: async () => ({ answerBankAvailable: true, answerCardCount: 16 }) });
        const reply = await handlers.get('build-interview-brief')({}, { nodeId: 'node-1', snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: bundle.artifactId, manualAiRunId: 'run-prepared-brief' });
        assert(reply?.briefRecordId === interviewPreparedBriefRecordId(sealedBrief) && (await loadInterviewPreparedBrief({ briefRecordId: reply.briefRecordId, brief: reply.brief, userDataPath: root })), 'the build handler must publish and reload the sealed record before returning success');
        return { recordId: published.briefRecordId.slice(0, 12) };
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview preparation: strips unsafe generated bundle display text and rejects unsafe stored display text',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-'));
      try {
        const bundle = await fixture(root, { auditJob: { title: 'Café — Product\u202E', company: 'Acme', location: 'Toronto' } });
        const artifact = await captureInterviewPreparationBundle({ directory: bundle, userDataPath: root });
        assert(artifact.job.title === 'Café — Product', 'bundle display projection must remove bidi controls while retaining ordinary Unicode text');
        const target = path.join(root, 'interview-helper-artifacts', `${artifact.artifactId}.json`);
        const stored = JSON.parse(await fs.promises.readFile(target, 'utf8'));
        stored.displayName = 'bundle\u0085name';
        const payload = { ...stored };
        delete payload.artifactId;
        const unsafeArtifactId = sha((value => {
          const stable = input => Array.isArray(input) ? `[${input.map(stable).join(',')}]` : (!input || typeof input !== 'object' ? JSON.stringify(input) : `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${stable(input[key])}`).join(',')}}`);
          return stable(value);
        })(payload));
        stored.artifactId = unsafeArtifactId;
        await fs.promises.writeFile(path.join(root, 'interview-helper-artifacts', `${unsafeArtifactId}.json`), JSON.stringify(stored));
        assert(await loadInterviewPreparationBundle({ artifactId: unsafeArtifactId, userDataPath: root }) === null, 'stored bundle display fields with C1 controls must be rejected');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview preparation: rejects corrupted preexisting artifact targets and unsafe artifact roots',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-'));
      try {
        const bundle = await fixture(root);
        const artifact = await captureInterviewPreparationBundle({ directory: bundle, userDataPath: root });
        const target = path.join(root, 'interview-helper-artifacts', `${artifact.artifactId}.json`);
        await fs.promises.writeFile(target, '{"artifactId":"corrupt"}');
        const collisionRejected = await captureInterviewPreparationBundle({ directory: bundle, userDataPath: root }).then(() => false, () => true);
        assert(collisionRejected, 'a same-name corrupt preexisting artifact must not be accepted');
        const secondRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-root-'));
        const externalRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-external-'));
        try {
          const unsafeDir = path.join(secondRoot, 'interview-helper-artifacts');
          await fs.promises.symlink(root, unsafeDir);
          const unsafeRejected = await captureInterviewPreparationBundle({ directory: bundle, userDataPath: secondRoot }).then(() => false, () => true);
          assert(unsafeRejected, 'artifact store symlink must be rejected');
          const linkedUserData = path.join(secondRoot, 'linked-user-data');
          await fs.promises.symlink(externalRoot, linkedUserData);
          const linkedParentRejected = await captureInterviewPreparationBundle({ directory: bundle, userDataPath: linkedUserData }).then(() => false, () => true);
          assert(linkedParentRejected && !fs.existsSync(path.join(externalRoot, 'interview-helper-artifacts')), 'a symlinked user-data root must be rejected before it can create an artifact directory outside the app root');
        } finally {
          await fs.promises.rm(secondRoot, { recursive: true, force: true });
          await fs.promises.rm(externalRoot, { recursive: true, force: true });
        }
        return { hardened: true };
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview preparation: a source cited twice with different dates still passes the publish gate',
    run: async () => {
      const bundle = { artifactId: 'b'.repeat(64), digests: { applicationHtml: 'c'.repeat(64) }, job: { title: 'Product Manager', company: 'Acme', location: 'Toronto' }, listingText: 'Product Manager at Acme', applicationPositioning: { resume: 'Delivery work.', coverLetter: 'Build reliable systems.' } };
      const rawResearch = 'Acme serves teams. Acme launched onboarding. Source: https://acme.test/news https://acme.test/news?ref=x Published 2026-01-01';
      const context = { rawResearch, bundle, snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: bundle.artifactId, createdAt: '2026-10-08T00:00:00.000Z' };
      for (const secondUrl of ['https://acme.test/news', 'https://acme.test/news?ref=x']) {
        const value = briefValue();
        value.companyFacts[0].sourceDate = 'unknown';
        value.recentContext = [{ fact: 'Acme launched onboarding.', sourceUrl: secondUrl, sourceDate: '2026-01-01', evidenceQuote: 'Acme launched onboarding.' }];
        const sealed = validateInterviewBriefAssessment(value, context);
        assert(sealed.sources.length === 1 && sealed.sources[0].sourceDate === 'unknown', `a repeated source keeps its first-cited date (${secondUrl})`);
        assert(isPublishedInterviewBrief(sealed) && /^[a-f0-9]{64}$/u.test(interviewPreparedBriefRecordId(sealed)), `a validator-accepted brief citing one source twice must seal (${secondUrl})`);
      }
    },
  },
  {
    name: 'interview preparation: the assessment validator refuses a response the publish gate would reject',
    run: async () => {
      const bundle = { artifactId: 'b'.repeat(64), digests: { applicationHtml: 'c'.repeat(64) }, job: { title: 'Product Manager', company: 'Acme', location: 'Toronto' }, listingText: 'Product Manager at Acme', applicationPositioning: { resume: 'Delivery work.', coverLetter: 'Build reliable systems.' } };
      // Canonicalizing the embedded URL adds a trailing slash, pushing this
      // maximum-length literal fact past the sealed brief's display bound.
      // A fact that is not a literal raw-research substring can never publish.
      // (A capped field that URL scrubbing lengthens used to be the trigger
      // here; it is now re-bounded after scrubbing and seals.)
      const rawResearch = `${'A'.repeat(40)} Source: https://acme.test/news Published 2026-01-01`;
      const value = briefValue();
      value.companyFacts[0] = { fact: 'Acme invented this fact.', sourceUrl: 'https://acme.test/news', sourceDate: '2026-01-01', evidenceQuote: 'AAAAAAAAAA' };
      let validator;
      await buildInterviewBrief({ nodeId: 'node-1', snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: bundle.artifactId, manualAiRunId: 'run-1', userDataPath: '/tmp', loadBundle: async () => bundle, callRaw: async () => rawResearch, callText: async (_prompt, opts) => { validator = opts.responseValidator; return briefValue(); } }).catch(() => undefined);
      assert(typeof validator === 'function', 'the assessment handoff must carry a response validator');
      let rejected = false;
      try { validator(value); } catch { rejected = true; }
      assert(rejected, 'a response that cannot be published must be rejected before it is accepted as a durable manual-AI step');
      const publishable = briefValue();
      publishable.companyFacts[0] = { fact: 'A'.repeat(40), sourceUrl: 'https://acme.test/news', sourceDate: '2026-01-01', evidenceQuote: 'AAAAAAAAAA' };
      assert(validator(publishable).briefId, 'a publishable response is still accepted');
    },
  },
  {
    name: 'interview preparation: captured bundle prose keeps word boundaries across line breaks',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-'));
      try {
        const bundle = path.join(root, 'bundle');
        await fs.promises.mkdir(bundle, { recursive: true });
        await fs.promises.writeFile(path.join(bundle, 'Application.html'), '<section data-ic-document-panel="resume"><main><p>Led delivery\nacross teams</p><ul><li>Built\tsystems</li></ul></main></section>');
        await fs.promises.writeFile(path.join(bundle, 'Original Job Listing.md'), '# Senior Engineer\nToronto, ON\n\nResponsibilities:\n- Own reliability\n');
        const artifact = await captureInterviewPreparationBundle({ directory: bundle, userDataPath: root });
        let rawPrompt; let assessmentPrompt;
        const rawResearch = 'Acme serves teams. Source: https://acme.test/news Published 2026-01-01';
        await buildInterviewBrief({ nodeId: 'node-1', snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: artifact.artifactId, manualAiRunId: 'run-1', userDataPath: root,
          callRaw: async prompt => { rawPrompt = prompt; return rawResearch; },
          callText: async prompt => { assessmentPrompt = prompt; throw new Error('stop after recording the assessment prompt'); } }).catch(() => undefined);
        assert(rawPrompt.includes('# Senior Engineer Toronto, ON Responsibilities: - Own reliability') && !rawPrompt.includes('EngineerToronto'), 'listing lines must be separated by spaces, not glued together');
        assert(assessmentPrompt.includes('Led delivery across teams') && assessmentPrompt.includes('Built systems') && !assessmentPrompt.includes('Builtsystems'), 'application positioning must keep words separated across newlines and tabs');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview preparation: a literal research fact spanning a line break keeps its provenance',
    run: async () => {
      const bundle = { artifactId: 'b'.repeat(64), digests: { applicationHtml: 'c'.repeat(64) }, job: { title: 'Product Manager', company: 'Acme', location: 'Toronto' }, listingText: 'Product Manager at Acme', applicationPositioning: { resume: 'Delivery work.', coverLetter: 'Build reliable systems.' } };
      const rawResearch = '- Acme serves enterprise\n  teams worldwide. Source: https://acme.test/news Published 2026-01-01';
      const context = { rawResearch, bundle, snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: bundle.artifactId, createdAt: '2026-10-08T00:00:00.000Z' };
      const value = briefValue();
      value.companyFacts[0] = { fact: 'Acme serves enterprise\n  teams worldwide.', sourceUrl: 'https://acme.test/news', sourceDate: '2026-01-01', evidenceQuote: 'teams worldwide.' };
      const brief = validateInterviewBriefAssessment(value, context);
      assert(brief.companyFacts[0].fact === 'Acme serves enterprise teams worldwide.' && isPublishedInterviewBrief(brief), 'an exact multi-line fact is accepted and displayed whitespace-collapsed');
      const normalizedOnly = briefValue();
      normalizedOnly.companyFacts[0] = { ...value.companyFacts[0], fact: 'Acme serves enterprise teams worldwide.' };
      let rejected = false;
      try { validateInterviewBriefAssessment(normalizedOnly, context); } catch { rejected = true; }
      assert(rejected, 'a fact that is not a literal raw substring is still rejected');
    },
  },
  {
    name: 'interview preparation: free-text brief fields never persist URL query or fragment data',
    run: async () => {
      const secret = 'https://acme.test/news?access_token=top-secret&email=ada%40example.test#fragment';
      const listingUrl = 'https://www.linkedin.com/jobs/view/123/?refId=abc&trackingId=TRACK-SECRET';
      const bundle = { artifactId: 'b'.repeat(64), digests: { applicationHtml: 'c'.repeat(64) }, job: { title: '', company: 'Acme', location: 'Toronto' }, listingText: `Product Manager listing ${listingUrl}`, applicationPositioning: { resume: `Portfolio at ${secret}.`, coverLetter: 'Build reliable systems.' } };
      const rawResearch = `Acme serves teams. Source: ${secret} Published 2026-01-01`;
      const context = { rawResearch, bundle, snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: bundle.artifactId, createdAt: '2026-10-08T00:00:00.000Z' };
      const value = briefValue();
      value.role = { title: `Product Manager listing ${listingUrl}`, company: 'Acme', location: 'Toronto', summary: `See ${secret}` };
      value.companyFacts[0] = { fact: `Acme serves teams. Source: ${secret}`, sourceUrl: secret, sourceDate: '2026-01-01', evidenceQuote: 'Acme serves teams.' };
      value.warnings = [`Captured listing URL ${listingUrl} differs.`];
      value.roleThemes = [`Read (${secret}).`];
      value.applicationPositioning = [{ documentKind: 'resume', point: `Portfolio at ${secret}.`, evidenceQuote: 'Portfolio at' }];
      const brief = validateInterviewBriefAssessment(value, context);
      const serialized = JSON.stringify(brief);
      assert(!/access_token|top-secret|ada%40example|fragment|TRACK-SECRET|refId/iu.test(serialized), 'no free-text field may persist a URL query or fragment');
      assert(brief.companyFacts[0].fact === 'Acme serves teams. Source: https://acme.test/news'
        && brief.roleThemes[0] === 'Read (https://acme.test/news).'
        && brief.warnings[0] === 'Captured listing URL https://www.linkedin.com/jobs/view/123/ differs.'
        && brief.applicationPositioning[0].point === 'Portfolio at https://acme.test/news.'
        && brief.role.title === 'Product Manager listing https://www.linkedin.com/jobs/view/123/'
        && brief.role.summary === 'See https://acme.test/news', 'embedded URLs keep their canonical public form and surrounding punctuation');
      assert(isPublishedInterviewBrief(brief), 'a scrubbed brief still seals');
    },
  },
  {
    name: 'interview preparation: URL scrubbing that lengthens a field at its cap still seals within the display bound',
    run: async () => {
      // 'https://acme.test' canonicalizes with an added slash, and a credential
      // URL becomes '[link removed]': both are longer than the worker's text.
      const slashUrl = 'https://acme.test';
      const credentialUrl = 'https://u:p@acme.test/x';
      const title = `${'T'.repeat(300 - slashUrl.length - 1)} ${slashUrl}`;
      const bundle = { artifactId: 'b'.repeat(64), digests: { applicationHtml: 'c'.repeat(64) }, job: { title, company: 'Acme', location: 'Toronto' }, listingText: 'Product Manager at Acme', applicationPositioning: { resume: 'Delivery work.', coverLetter: 'Build reliable systems.' } };
      const rawResearch = `Acme serves teams. Source: https://acme.test/news Published 2026-01-01 ${credentialUrl}`;
      const context = { rawResearch, bundle, snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: bundle.artifactId, createdAt: '2026-10-08T00:00:00.000Z' };
      const value = briefValue();
      value.role.summary = `${'S'.repeat(1200 - credentialUrl.length - 1)} ${credentialUrl}`;
      value.warnings = [`${'W'.repeat(1200 - slashUrl.length - 1)} ${slashUrl}`];
      assert(title.length === 300 && value.role.summary.length === 1200 && value.warnings[0].length === 1200, 'fixture fields sit exactly at their caps');
      const brief = validateInterviewBriefAssessment(value, context);
      assert(brief.role.title.length <= 300 && brief.role.summary.length <= 1200 && brief.warnings[0].length <= 1200, 'scrubbed fields stay within their display bounds');
      assert(!brief.role.summary.includes('u:p@') && !brief.role.summary.includes('https://'), 'the credential URL is removed from the capped summary');
      assert(isPublishedInterviewBrief(brief), 'a brief whose scrubbing lengthened a capped field still seals');
    },
  },
  {
    name: 'interview preparation: research source dates must be short non-blank text, never a URL',
    run: async () => {
      const secret = 'https://acme.test/news?access_token=top-secret';
      const bundle = { artifactId: 'b'.repeat(64), digests: { applicationHtml: 'c'.repeat(64) }, job: { title: 'Product Manager', company: 'Acme', location: 'Toronto' }, listingText: 'Product Manager at Acme', applicationPositioning: { resume: 'Delivery work.', coverLetter: 'Build reliable systems.' } };
      const context = { rawResearch: `Acme serves teams. Source: https://acme.test/news ${secret} Published 2026-01-01`, bundle, snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: bundle.artifactId, createdAt: '2026-10-08T00:00:00.000Z' };
      for (const sourceDate of [secret, ' ']) {
        const value = briefValue();
        value.companyFacts[0].sourceDate = sourceDate;
        let rejected = false;
        try { validateInterviewBriefAssessment(value, context); } catch { rejected = true; }
        assert(rejected, `source date ${JSON.stringify(sourceDate)} must be rejected as research provenance`);
      }
    },
  },
  {
    name: 'interview preparation: positioning text keeps words apart across adjacent HTML elements',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-'));
      try {
        const bundle = path.join(root, 'bundle');
        await fs.promises.mkdir(bundle, { recursive: true });
        await fs.promises.writeFile(path.join(bundle, 'Application.html'), '<section data-ic-document-panel="resume"><main><p class="role-dates">2021 – 2024</p><ul><li>Cut latency 40%.</li><li>Built API.</li></ul><dl><dt>Languages</dt><dd>TypeScript</dd></dl></main></section><section data-ic-document-panel="cover"><main><p>Hello</p><p>there</p></main></section>');
        await fs.promises.writeFile(path.join(bundle, 'Original Job Listing.md'), '# Engineer\nToronto\n');
        const artifact = await captureInterviewPreparationBundle({ directory: bundle, userDataPath: root });
        const { assessmentPrompt } = await promptsFor(artifact, root);
        const readable = assessmentPrompt.replace(/\u2029/gu, ' ');
        assert(readable.includes('Cut latency 40%. Built API.') && readable.includes('Languages TypeScript') && readable.includes('2021 \u2013 2024 Cut latency'), 'adjacent list items, definition rows and dates must be separated');
        assert(!/%\.Built|LanguagesTypeScript|2024Cut/u.test(assessmentPrompt), 'no adjacent elements may be glued into run-on words');
        assert(readable.includes('Hello there') && !assessmentPrompt.includes('Hellothere'), 'cover letter paragraphs must be separated');
        const positioning = { resume: 'Cut latency 40%. Built API.', coverLetter: 'Hello there' };
        const context = { rawResearch: 'Acme. Source: https://acme.test/news Published 2026-01-01', bundle: { artifactId: artifact.artifactId, digests: { applicationHtml: 'c'.repeat(64) }, job: { title: 'Engineer', company: 'Acme', location: 'Toronto' }, listingText: 'Engineer', applicationPositioning: positioning }, snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: artifact.artifactId, createdAt: '2026-10-08T00:00:00.000Z' };
        const value = briefValue();
        value.companyFacts = []; value.recentContext = [];
        value.applicationPositioning = [{ documentKind: 'resume', point: 'Cut latency 40%. Built API.', evidenceQuote: 'Built API.' }];
        assert(validateInterviewBriefAssessment(value, context).applicationPositioning[0].point === 'Cut latency 40%. Built API.', 'a naturally spaced positioning point must be accepted');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview preparation: rejections name the failing item and field and never echo content',
    run: async () => {
      const bundle = { artifactId: 'b'.repeat(64), digests: { applicationHtml: 'c'.repeat(64) }, job: { title: 'Product Manager', company: 'Acme', location: 'Toronto' }, listingText: 'Product Manager at Acme', applicationPositioning: { resume: 'Delivery work.', coverLetter: 'Build reliable systems.' } };
      const rawResearch = 'Acme serves teams. Source: https://acme.test/news Published January 6, 2026';
      const context = { rawResearch, bundle, snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: bundle.artifactId, createdAt: '2026-10-08T00:00:00.000Z' };
      const messageOf = value => { try { validateInterviewBriefAssessment(value, context); } catch (error) { return error.message; } return ''; };
      const good = { fact: 'Acme serves teams.', sourceUrl: 'https://acme.test/news', sourceDate: 'January 6, 2026', evidenceQuote: 'Acme serves teams.' };
      const value = briefValue();
      value.companyFacts = [good, { ...good, sourceDate: '2026-01-06' }];
      assert(/companyFacts\[1\]\.sourceDate/u.test(messageOf(value)) && !/2026-01-06/u.test(messageOf(value)), `a normalized date must name companyFacts[1].sourceDate without echoing it, got: ${messageOf(value)}`);
      value.companyFacts = [good]; value.recentContext = [{ ...good, fact: 'Invented claim' }];
      assert(/recentContext\[0\]\.fact/u.test(messageOf(value)) && !/Invented claim/u.test(messageOf(value)), `an invented fact must name recentContext[0].fact, got: ${messageOf(value)}`);
      value.recentContext = []; value.companyFacts = [{ ...good, sourceUrl: 'https://other.test/x' }];
      assert(/companyFacts\[0\]\.sourceUrl/u.test(messageOf(value)), 'a foreign URL must name the sourceUrl field');
      value.companyFacts = [{ ...good, evidenceQuote: 'not in research' }];
      assert(/companyFacts\[0\]\.evidenceQuote/u.test(messageOf(value)), 'a foreign quote must name the evidenceQuote field');
      value.companyFacts = [good];
      value.applicationPositioning = [{ documentKind: 'resume', point: 'Delivery work.', evidenceQuote: 'Delivery work.' }, { documentKind: 'resume', point: 'Made up point', evidenceQuote: 'Delivery work.' }];
      assert(/applicationPositioning\[1\]\.point/u.test(messageOf(value)) && !/Made up point/u.test(messageOf(value)), `an invented positioning point must name applicationPositioning[1].point, got: ${messageOf(value)}`);
    },
  },
  {
    name: 'interview preparation: identity redaction keeps dates, year ranges and decimal pay ranges but still redacts phone numbers',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-'));
      try {
        const bundle = path.join(root, 'bundle');
        await fs.promises.mkdir(bundle, { recursive: true });
        await fs.promises.writeFile(path.join(bundle, 'Application.html'), '<section data-ic-document-panel="resume"><main><p>Shipped 2019 - 2023 platform</p></main></section>');
        await fs.promises.writeFile(path.join(bundle, 'Original Job Listing.md'), '# Engineer\nPosted 2026-01-15. Pay range 145.00 - 165.00 per hour. Call 416-555-0199 or (416) 555-0199 or +1 416 555 0199 or 4165550199 or ada@example.test.\n');
        const artifact = await captureInterviewPreparationBundle({ directory: bundle, userDataPath: root });
        const { rawPrompt, assessmentPrompt } = await promptsFor(artifact, root);
        assert(rawPrompt.includes('2026-01-15') && rawPrompt.includes('145.00 - 165.00'), 'dates and decimal pay ranges must survive redaction');
        assert(assessmentPrompt.includes('2019 - 2023'), 'year ranges must survive redaction');
        const listing = /<untrusted-interview-original-listing-[^>]+>\n([\s\S]*?)\n<\/untrusted-interview-original-listing-[^>]+>/u.exec(rawPrompt)?.[1];
        assert(listing && !/416|555-0199|4165550199|ada@example/u.test(listing)
          && (listing.match(/\[redacted phone\]/gu) || []).length >= 4 && listing.includes('[redacted email]'),
        'phone numbers and emails must still be redacted');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview preparation: free-text scrubbing also covers scheme-less links and queries cut by an apostrophe',
    run: async () => {
      const bundle = { artifactId: 'b'.repeat(64), digests: { applicationHtml: 'c'.repeat(64) }, job: { title: 'Product Manager', company: 'Acme', location: 'Toronto' }, listingText: 'Product Manager at Acme', applicationPositioning: { resume: 'Delivery work.', coverLetter: 'Build reliable systems.' } };
      const context = { rawResearch: 'Acme serves teams. Source: https://acme.test/news Published 2026-01-01', bundle, snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: bundle.artifactId, createdAt: '2026-10-08T00:00:00.000Z' };
      const value = briefValue();
      value.role = { ...value.role, summary: 'Apply via boards.greenhouse.io/acme/jobs/123?gh_src=TRACK-SECRET&email=ada%40example.test' };
      value.roleThemes = ['See www.acme.test/careers?session=SESSION-SECRET'];
      value.warnings = ["Listing link https://acme.test/apply?x='1'&token=TOKEN-SECRET differs", 'Did you use Node.js? Yes, v1.2 works.'];
      const brief = validateInterviewBriefAssessment(value, context);
      const serialized = JSON.stringify(brief);
      assert(!/TRACK-SECRET|ada%40example|SESSION-SECRET|TOKEN-SECRET/u.test(serialized), `no query value may persist, got: ${serialized}`);
      assert(brief.role.summary === 'Apply via boards.greenhouse.io/acme/jobs/123' && brief.roleThemes[0] === 'See www.acme.test/careers', 'scheme-less links keep host and path');
      assert(brief.warnings[1] === 'Did you use Node.js? Yes, v1.2 works.', 'ordinary sentence punctuation after a dotted word is left alone');
      assert(isPublishedInterviewBrief(brief), 'a scrubbed brief still seals');
    },
  },
  {
    name: 'interview preparation: array-typed ids are rejected by every request validator',
    run: async () => {
      const id = 'a'.repeat(64);
      const base = { nodeId: 'interview-helper-1', snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: id, manualAiRunId: 'run-1' };
      validateInterviewBriefRequestArgs(base);
      for (const override of [{ bundleArtifactId: [id] }, { manualAiRunId: ['run-1'] }]) {
        let rejected = false;
        try { validateInterviewBriefRequestArgs({ ...base, ...override }); } catch { rejected = true; }
        assert(rejected, `${Object.keys(override)[0]} as an array must be rejected`);
      }
      validateInterviewPreparationLoadArgs({ nodeId: 'interview-helper-1', artifactId: id });
      let loadRejected = false;
      try { validateInterviewPreparationLoadArgs({ nodeId: 'interview-helper-1', artifactId: [id] }); } catch { loadRejected = true; }
      assert(loadRejected, 'artifactId as an array must be rejected');
    },
  },
  {
    name: 'interview preparation: a PDF the receipt binds but the folder no longer holds is declared-absent and still verified',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-'));
      try {
        // Plain listing with no company line, so company/location can only come from the receipt.
        const listing = '# Product Manager\n\nAcme seeks a product leader.\n';
        const job = { title: 'Product Manager', company: 'Acme', location: 'Toronto' };
        const dir = await writeBundleFiles(path.join(root, 'bundle'), { 'Application.html': SIMPLE_HTML, 'Original Job Listing.md': listing, 'Resume.pdf': RESUME_PDF, 'Cover Letter.pdf': COVER_PDF, 'Generation Audit.json': receipt({ listing, resumePdf: RESUME_PDF, coverPdf: COVER_PDF, job }) });
        const cap = () => captureInterviewPreparationBundle({ directory: dir, userDataPath: root });
        const complete = await cap();
        assert(complete.verification.status === 'verified' && complete.verification.reason === 'saved-artifacts-hashes-match', 'a complete bundle verifies plainly');
        await fs.promises.unlink(path.join(dir, 'Cover Letter.pdf'));
        const coverGone = await cap();
        assert(coverGone.verification.status === 'verified' && coverGone.verification.reason === 'saved-artifacts-hashes-match-declared-absent:cover-letter-pdf', `a bound cover PDF that is no longer in the folder is an observation, not a hash mismatch, got ${JSON.stringify(coverGone.verification)}`);
        assert(coverGone.job.company === 'Acme' && coverGone.job.location === 'Toronto', 'a declared-absent PDF keeps the receipt job identity');
        assert(coverGone.artifactId !== complete.artifactId, 'the observation is part of the content address');
        await fs.promises.unlink(path.join(dir, 'Resume.pdf'));
        const bothGone = await cap();
        assert(bothGone.verification.status === 'verified' && bothGone.verification.reason === 'saved-artifacts-hashes-match-declared-absent:resume-pdf,cover-letter-pdf' && bothGone.verification.reason.length <= 120, 'both bound PDFs absent are both named, within the reason bound');
        await fs.promises.writeFile(path.join(dir, 'Cover Letter.pdf'), COVER_PDF);
        const resumeGone = await cap();
        assert(resumeGone.verification.status === 'verified' && resumeGone.verification.reason === 'saved-artifacts-hashes-match-declared-absent:resume-pdf', 'a bound resume PDF that is no longer in the folder is named on its own');
        // A malformed bound hash is still invalid, even with the PDF absent.
        await fs.promises.writeFile(path.join(dir, 'Resume.pdf'), RESUME_PDF);
        await fs.promises.unlink(path.join(dir, 'Cover Letter.pdf'));
        await fs.promises.writeFile(path.join(dir, 'Generation Audit.json'), receipt({ listing, resumePdf: RESUME_PDF, coverPdf: COVER_PDF, job, savedOverrides: { coverLetterPdfSha256: 'zz' } }));
        const malformed = await cap();
        assert(malformed.verification.status === 'hash-mismatch' && malformed.verification.reason === 'invalid-durable-artifact-hash' && malformed.job.company === '', 'a malformed bound hash with the PDF absent is still a mismatch');
        // A present PDF that differs from the receipt, or that the receipt never bound, is still a mismatch.
        await fs.promises.writeFile(path.join(dir, 'Generation Audit.json'), receipt({ listing, resumePdf: RESUME_PDF, coverPdf: COVER_PDF, job }));
        await fs.promises.writeFile(path.join(dir, 'Cover Letter.pdf'), Buffer.from('%PDF-1.4 edited cover'));
        const differs = await cap();
        assert(differs.verification.status === 'hash-mismatch' && differs.verification.reason === 'durable-artifact-hash-mismatch', 'a present PDF that differs from the receipt is a mismatch');
        await fs.promises.writeFile(path.join(dir, 'Generation Audit.json'), receipt({ listing, resumePdf: RESUME_PDF, job }));
        const unbound = await cap();
        assert(unbound.verification.status === 'hash-mismatch' && unbound.verification.reason === 'durable-artifact-hash-mismatch', 'a present PDF the receipt never bound is a mismatch');
        // The verifier stays byte exact for the HTML even when a PDF is absent.
        await fs.promises.writeFile(path.join(dir, 'Generation Audit.json'), receipt({ listing, resumePdf: RESUME_PDF, coverPdf: COVER_PDF, job }));
        await fs.promises.unlink(path.join(dir, 'Cover Letter.pdf'));
        assert((await cap()).verification.status === 'verified', 'the restored receipt verifies again with the cover absent');
        await fs.promises.writeFile(path.join(dir, 'Application.html'), `${SIMPLE_HTML}\n`);
        const edited = await cap();
        assert(edited.verification.status === 'hash-mismatch' && edited.verification.reason === 'durable-artifact-hash-mismatch' && edited.job.company === '', 'a changed Application.html stays a hash mismatch and a receipt cannot inject identity');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview preparation: an unverified bundle reads job identity from the listing header with the writer escapes undone',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-'));
      try {
        const job = { title: 'Staff Engineer - Data (Platform) *Lead* [EMEA] C++ v1.2 #1 a_b `x` {y} <z> ! | + \\ end', company: 'Acme-Corp (US) Inc.', location: 'New York, NY - Hybrid (2 days)' };
        const listing = formatOriginalJobListingMarkdown({ ...job, description: 'Body text.' });
        for (const character of '\\`*_{}<>()#+.!|-[]') assert(listing.includes(`\\${character}`), `fixture must really carry the writer's escape of ${character}`);
        const injected = { title: 'Injected title', company: 'Injected Co', location: 'Nowhere' };
        const cases = {
          'hash-mismatch': await captureWithListing(root, 'mismatch', listing, { receiptJob: injected, tamper: true }),
          legacy: await captureWithListing(root, 'legacy', listing),
          invalid: await captureWithListing(root, 'invalid', listing, { invalidReceipt: injected }),
        };
        assert(cases['hash-mismatch'].verification.status === 'hash-mismatch' && cases.legacy.verification.status === 'legacy-unverified' && cases.invalid.verification.status === 'unverified-invalid-audit', 'fixture must cover the three unverified statuses');
        for (const [label, artifact] of Object.entries(cases)) {
          assert(artifact.job.title === job.title && !artifact.job.title.includes('\\-') && artifact.job.company === job.company && artifact.job.location === job.location, `${label}: title/company/location must equal the listing header with escapes undone, got ${JSON.stringify(artifact.job)}`);
          assert(!JSON.stringify(artifact.job).includes('Injected'), `${label}: an unverified receipt must not inject identity`);
        }
        const reloaded = await loadInterviewPreparationBundle({ artifactId: cases.legacy.artifactId, userDataPath: root });
        assert(JSON.stringify(reloaded.job) === JSON.stringify(cases.legacy.job), 'the header identity survives the artifact reload');
        // A verified receipt still wins over the listing header.
        const verified = await captureWithListing(root, 'verified', listing, { receiptJob: { title: 'Receipt Title', company: 'Acme', location: 'Toronto' } });
        assert(verified.verification.status === 'verified' && verified.job.title === 'Receipt Title' && verified.job.company === 'Acme' && verified.job.location === 'Toronto', 'a verified receipt keeps precedence over the listing header');
        // The prompt carries the recovered identity as the application target.
        const { assessmentPrompt } = await promptsFor(cases.legacy, root);
        assert(assessmentPrompt.includes('"company":"Acme-Corp (US) Inc."') && assessmentPrompt.includes('"location":"New York, NY - Hybrid (2 days)"'), 'the brief prompt must receive the recovered company and location');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview preparation: listing header identity ignores a body, a missing separator, an empty value line, and keeps placeholders blank',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-'));
      try {
        const noSeparator = await captureWithListing(root, 'no-separator', '# Product Manager\n\n**Company:** Evil Corp\n**Location:** Mars\n');
        assert(noSeparator.job.title === 'Product Manager' && noSeparator.job.company === '' && noSeparator.job.location === '', `a listing without the writer's separator must not have its body read as identity, got ${JSON.stringify(noSeparator.job)}`);
        const bodyOnly = await captureWithListing(root, 'body-only', '# Role\n\n---\n\n## Original scraped listing\n\n**Company:** Body Corp\n**Location:** Body Land\n');
        assert(bodyOnly.job.company === '' && bodyOnly.job.location === '', 'lines after the first --- separator are body text, never identity');
        const emptyCompany = await captureWithListing(root, 'empty-company', '# Role\n\n**Company:**\n**Location:** Toronto\n\n---\n\nbody\n');
        assert(emptyCompany.job.company === '' && emptyCompany.job.location === 'Toronto', `an empty **Company:** line must not leak the next line, got ${JSON.stringify(emptyCompany.job)}`);
        const emptyLocation = await captureWithListing(root, 'empty-location', '# Role\n\n**Company:** Acme\n**Location:** \n**Compensation:** $1\n\n---\n\nbody\n');
        assert(emptyLocation.job.company === 'Acme' && emptyLocation.job.location === '', `an empty **Location:** line must not leak the next line, got ${JSON.stringify(emptyLocation.job)}`);
        const placeholders = await captureWithListing(root, 'placeholders', formatOriginalJobListingMarkdown({ description: 'Body.' }));
        assert(placeholders.job.title === '' && placeholders.job.company === '' && placeholders.job.location === '', `the writer's Untitled role / Unknown company placeholders are not identity, got ${JSON.stringify(placeholders.job)}`);
        const crlf = await captureWithListing(root, 'crlf', '# Role\r\n\r\n**Company:** Acme\r\n**Location:** Toronto\r\n\r\n---\r\n\r\nbody\r\n');
        assert(crlf.job.title === 'Role' && crlf.job.company === 'Acme' && crlf.job.location === 'Toronto', `a CRLF header reads the same, got ${JSON.stringify(crlf.job)}`);
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview preparation: a BOM or indented heading still reads as the title, and header company and location are identity-redacted',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-'));
      try {
        const bom = String.fromCodePoint(0xFEFF);
        const withBom = await captureWithListing(root, 'bom', `${bom}# Product Manager\n\n**Company:** Acme\n**Location:** Toronto\n\n---\n\nbody\n`);
        assert(withBom.job.title === 'Product Manager' && withBom.job.company === 'Acme' && withBom.job.location === 'Toronto', `a BOM before the heading must not blank the title, got ${JSON.stringify(withBom.job)}`);
        const indented = await captureWithListing(root, 'indented', '  # Product Manager\n\n**Company:** Acme\n\n---\n\nbody\n');
        assert(indented.job.title === 'Product Manager', `an indented heading is still the title, got ${JSON.stringify(indented.job)}`);
        const contact = await captureWithListing(root, 'contact', '# Role\n\n**Company:** bob@example.test\n**Location:** +1 415 555 1212\n\n---\n\nbody\n');
        assert(!/bob@|415|555/u.test(JSON.stringify(contact.job)) && contact.job.company === '[redacted email]' && contact.job.location === '[redacted phone]', `header company and location get the same email/phone redaction as the listing text, got ${JSON.stringify(contact.job)}`);
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview preparation: a declared-absent cover PDF verifies with receipt identity, while an HTML change with it absent stays a mismatch with listing-header identity',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-'));
      try {
        const job = { title: 'Platform Engineer - Data', company: 'Acme Robotics', location: 'Remote (US)' };
        const listing = formatOriginalJobListingMarkdown({ ...job, description: 'Own the data platform.' });
        const dir = await writeBundleFiles(path.join(root, 'bundle'), { 'Application.html': SIMPLE_HTML, 'Original Job Listing.md': listing, 'Resume.pdf': RESUME_PDF, 'Generation Audit.json': receipt({ listing, resumePdf: RESUME_PDF, coverPdf: COVER_PDF, job }) });
        const cap = () => captureInterviewPreparationBundle({ directory: dir, userDataPath: root });
        const verified = await cap();
        assert(verified.verification.status === 'verified' && verified.verification.reason === 'saved-artifacts-hashes-match-declared-absent:cover-letter-pdf', 'the real-world shape (cover PDF bound but no longer in the folder) verifies');
        assert(verified.job.title === job.title && verified.job.company === job.company && verified.job.location === job.location, 'the verified bundle has company and location');
        assert(verified.integritySummary === 'Matches its saved generation receipt; a PDF it lists is no longer in the folder (Cover Letter.pdf)', `the row names the missing PDF, got ${verified.integritySummary}`);
        await fs.promises.writeFile(path.join(dir, 'Application.html'), `${SIMPLE_HTML}\n`);
        const edited = await cap();
        assert(edited.verification.status === 'hash-mismatch' && edited.verification.reason === 'durable-artifact-hash-mismatch', 'a changed Application.html is a mismatch even with the cover absent');
        assert(edited.job.title === job.title && edited.job.company === job.company && edited.job.location === job.location, `the mismatched bundle still has identity, from the listing header, got ${JSON.stringify(edited.job)}`);
        assert(edited.integritySummary === 'Files differ from the saved generation receipt; job details read from the saved listing', `a mismatch is described by what was observed, got ${edited.integritySummary}`);
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview preparation: integrity text describes every status and reason without the raw token, a guessed cause, or Sync',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-prep-'));
      try {
        const FROM_LISTING = 'job details read from the saved listing';
        const MATCHES = 'Matches its saved generation receipt';
        const DECLARED = 'saved-artifacts-hashes-match-declared-absent';
        const expected = [
          ['verified', 'saved-artifacts-hashes-match', MATCHES],
          ['verified', `${DECLARED}:cover-letter-pdf`, `${MATCHES}; a PDF it lists is no longer in the folder (Cover Letter.pdf)`],
          ['verified', `${DECLARED}:resume-pdf`, `${MATCHES}; a PDF it lists is no longer in the folder (Resume.pdf)`],
          ['verified', `${DECLARED}:resume-pdf,cover-letter-pdf`, `${MATCHES}; PDFs it lists are no longer in the folder (Resume.pdf, Cover Letter.pdf)`],
          ['verified', `${DECLARED}:cover-letter-pdf,cover-letter-pdf`, `${MATCHES}; a PDF it lists is no longer in the folder (Cover Letter.pdf)`],
          ['verified', DECLARED, `${MATCHES}; a PDF it lists is no longer in the folder`],
          ['verified', `${DECLARED}:__proto__,constructor,<b>x</b>`, `${MATCHES}; a PDF it lists is no longer in the folder`],
          ['legacy-unverified', 'no-generation-audit', `No generation receipt; ${FROM_LISTING}`],
          ['legacy-unverified', 'no-durable-saved-artifacts', `Generation receipt lists no saved-file hashes; ${FROM_LISTING}`],
          ['unverified-invalid-audit', 'invalid-generation-audit', `Generation receipt unreadable; ${FROM_LISTING}`],
          ['hash-mismatch', 'durable-artifact-hash-mismatch', `Files differ from the saved generation receipt; ${FROM_LISTING}`],
          // Stored by earlier builds for a receipt-listed PDF the folder lacked (and still used for a malformed hash).
          ['hash-mismatch', 'invalid-durable-artifact-hash', `A PDF listed in the receipt is missing or unreadable; ${FROM_LISTING}`],
          ['hash-mismatch', 'some-other-reason', `Files differ from the saved generation receipt; ${FROM_LISTING}`],
        ];
        for (const [status, reason, text] of expected) {
          const artifactId = await storeArtifact(root, { status, reason });
          const loaded = await loadInterviewPreparationBundle({ artifactId, userDataPath: root });
          assert(loaded?.integritySummary === text, `${status} / ${reason} must read "${text}", got ${JSON.stringify(loaded?.integritySummary)}`);
          assert(loaded.integritySummary !== status && loaded.integritySummary.length <= 500 && !/sync/iu.test(loaded.integritySummary) && ![...loaded.integritySummary].some(character => character.codePointAt(0) < 32), `${status} / ${reason}: the text must be bounded, free of controls, and not name Sync`);
          assert(JSON.stringify(loaded.verification) === JSON.stringify({ status, reason }), 'the structured verification is unchanged');
        }
        // A fresh capture projects the same text.
        const fresh = await captureInterviewPreparationBundle({ directory: await fixture(path.join(root, 'fresh')), userDataPath: root });
        assert(fresh.integritySummary === MATCHES, `a fresh verified capture reads "${MATCHES}", got ${fresh.integritySummary}`);
        const stale = await captureInterviewPreparationBundle({ directory: await fixture(path.join(root, 'stale'), { verified: false }), userDataPath: root });
        assert(stale.integritySummary === `Files differ from the saved generation receipt; ${FROM_LISTING}`, 'a fresh mismatch capture reads as a difference');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview preparation: a worker role fallback must be a whole token of the listing or research, not a fragment',
    run: async () => {
      const ZU = `Z${String.fromCodePoint(0xFC)}`; const ZURICH = `${ZU}rich`;
      const listingText = `Platform Engineer at Acme Robotics. Plan A: lead the platform team. Competes with Globex Corp. Requires C++ and Go. Based in ${ZURICH} (Remote).`;
      const rawResearch = 'Acme serves teams. Source: https://acme.test/news Published 2026-01-01';
      const bundle = { artifactId: 'b'.repeat(64), digests: { applicationHtml: 'c'.repeat(64) }, job: { title: '', company: '', location: '' }, listingText, applicationPositioning: { resume: 'Delivery work.', coverLetter: 'Build reliable systems.' } };
      const roleFor = role => validateInterviewBriefAssessment({ ...briefValue(), role: { ...briefValue().role, ...role } }, { rawResearch, bundle, snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: bundle.artifactId, createdAt: '2026-10-08T00:00:00.000Z' }).role;
      assert(roleFor({ company: 'A' }).company === 'Unknown company', 'a single character is never a grounded company, even when it is a word of the listing');
      assert(roleFor({ company: 'cme Robot' }).company === 'Unknown company', 'a fragment that starts and ends mid-word is not grounded');
      assert(roleFor({ company: 'Acme Robot' }).company === 'Unknown company', 'a fragment that ends mid-word is not grounded');
      assert(roleFor({ company: 'cme Robotics' }).company === 'Unknown company', 'a fragment that starts mid-word is not grounded');
      assert(roleFor({ location: 'rich' }).location === 'Unknown' && roleFor({ location: ZU }).location === 'Unknown', 'word boundaries are Unicode aware');
      assert(roleFor({ title: 'Platform Engine' }).title === 'Unknown role' && roleFor({ title: 'latform Engineer' }).title === 'Unknown role', 'a title fragment is not grounded');
      assert(roleFor({ company: 'A.me Robotics' }).company === 'Unknown company', 'the worker value is matched literally, never as a pattern');
      assert(roleFor({ company: '.*' }).company === 'Unknown company' && roleFor({ company: '(Acme' }).company === 'Unknown company', 'pattern characters in a worker value neither throw nor match loosely');
      const genuine = roleFor({ title: 'Platform Engineer', company: 'Acme Robotics', location: ZURICH });
      assert(genuine.title === 'Platform Engineer' && genuine.company === 'Acme Robotics' && genuine.location === ZURICH, 'genuine whole-token fallbacks are still accepted');
      assert(roleFor({ title: 'C++' }).title === 'C++' && roleFor({ location: '(Remote)' }).location === '(Remote)' && roleFor({ company: 'Acme' }).company === 'Acme', 'edges that are not word characters need no boundary, and research text also grounds a value');
      const roleForListing = (text, role) => validateInterviewBriefAssessment({ ...briefValue(), role: { ...briefValue().role, ...role } }, { rawResearch, bundle: { ...bundle, listingText: text }, snapshotId: SNAPSHOT_ID, canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: bundle.artifactId, createdAt: '2026-10-08T00:00:00.000Z' }).role;
      // Digits are word characters too: a value may not start or end inside a number or alphanumeric token.
      assert(roleForListing('Owned by x3M corp', { company: '3M' }).company === 'Unknown company' && roleForListing('Owned by 3Mx corp', { company: '3M' }).company === 'Unknown company', 'a digit-edged value is not grounded by a larger token');
      assert(roleForListing('Owned by 23M corp', { company: '3M' }).company === 'Unknown company' && roleForListing('Owned by Globex2 corp', { company: 'Globex' }).company === 'Unknown company', 'a digit neighbour continues the word');
      assert(roleForListing('Owned by 3M corp', { company: '3M' }).company === '3M', 'a whole digit-edged token is grounded');
      // Scripts written without spaces: a neighbouring character does not make a genuine value a partial word.
      const rakuten = String.fromCodePoint(0x697D, 0x5929); const wa = String.fromCodePoint(0x306F); const company = String.fromCodePoint(0x4F1A, 0x793E);
      assert(roleForListing(`${rakuten}${wa}${company}`, { company: rakuten }).company === rakuten, 'a Han company followed by kana is grounded');
      const thai = String.fromCodePoint(0xE2A, 0xE27, 0xE31, 0xE2A, 0xE14, 0xE35);
      assert(roleForListing(`${thai}${rakuten}`, { company: rakuten }).company === rakuten, 'a spaceless-script neighbour does not block grounding');
      // A combining mark continues the word: the base letters of a decomposed word are not a whole token.
      const decomposed = `Zu${String.fromCodePoint(0x308)}rich`;
      assert(roleForListing(`Based in ${decomposed}.`, { location: 'Zu' }).location === 'Unknown', 'a prefix of a word that continues with a combining mark is not grounded');
    },
  },
];

// Helpers for the receipt-bound PDF, listing-header identity and integrity-text tests above
// (function declarations and consts are initialised before any test runs).
const SIMPLE_HTML = '<html><body><section data-ic-document-panel="resume"><main>Led delivery.</main></section><section data-ic-document-panel="cover"><main>Build reliable systems.</main></section></body></html>';
const RESUME_PDF = Buffer.from('%PDF-1.4 resume');
const COVER_PDF = Buffer.from('%PDF-1.4 cover');

async function writeBundleFiles(directory, files) {
  await fs.promises.mkdir(directory, { recursive: true });
  await Promise.all(Object.entries(files).map(([name, data]) => fs.promises.writeFile(path.join(directory, name), data)));
  return directory;
}

/** A durable receipt over the given bytes; savedOverrides replaces individual savedArtifacts entries. */
function receipt({ html = SIMPLE_HTML, listing, resumePdf = null, coverPdf = null, job, savedOverrides = {} }) {
  return JSON.stringify({
    version: 1, schema: 'infinite-canvas-generation-audit', job,
    savedArtifacts: { applicationHtmlSha256: sha(html), originalJobListingSha256: sha(listing), resumePdfSha256: resumePdf ? sha(resumePdf) : null, coverLetterPdfSha256: coverPdf ? sha(coverPdf) : null, ...savedOverrides },
  });
}

/** Capture a bundle that holds only Application.html and the given listing, with an optional receipt. */
async function captureWithListing(root, name, listing, { receiptJob = null, tamper = false, invalidReceipt = null } = {}) {
  const files = { 'Application.html': SIMPLE_HTML, 'Original Job Listing.md': listing };
  if (receiptJob) files['Generation Audit.json'] = receipt({ listing, job: receiptJob, savedOverrides: tamper ? { applicationHtmlSha256: '0'.repeat(64) } : {} });
  if (invalidReceipt) files['Generation Audit.json'] = JSON.stringify({ version: 9, schema: 'wrong', job: invalidReceipt });
  const directory = await writeBundleFiles(path.join(root, name), files);
  return captureInterviewPreparationBundle({ directory, userDataPath: root });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

/** Write a content-addressed artifact with an arbitrary verification, as an earlier build would have stored it. */
async function storeArtifact(root, verification) {
  const payload = { schemaVersion: 1, displayName: 'Stored bundle', verification, digests: { applicationHtml: sha('html'), originalJobListing: sha('listing') }, job: { title: 'Role', company: '', location: '' }, listingText: 'Role', applicationPositioning: { resume: '', coverLetter: '' } };
  const artifactId = sha(stableJson(payload));
  const store = path.join(await fs.promises.realpath(root), 'interview-helper-artifacts');
  await fs.promises.mkdir(store, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(path.join(store, `${artifactId}.json`), JSON.stringify({ ...payload, artifactId }), { mode: 0o600 });
  return artifactId;
}
