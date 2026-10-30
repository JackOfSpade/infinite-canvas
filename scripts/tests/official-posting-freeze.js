import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL } from '../../electron/ipc/officialPostingNegativePolicy.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import {
  __freezeOfficialPostingJobForTests as freeze,
  __projectLocalApplicationJobForAcceptanceHarness as project,
  LOCAL_AI_APPLICATION_SNIPPET_MAX_CHARS, getLocalApplicationHandoff, queueLocalApplicationJob, registerLocalAiApplicationHandlers,
} from '../../electron/ipc/localAiApplication.js';
import { writeApprovedCareerSnapshotFixture } from './careerSnapshotFixture.mjs';
import { createOfficialPostingStore } from '../../electron/ipc/officialPostingStore.js';
import { prepareOfficialPostingForGeneration } from '../../electron/ipc/officialPostingGeneration.js';
import { officialPostingSemanticInputHash } from '../../electron/ipc/officialPostingSemantic.js';
import { formatOriginalJobListingMarkdown } from '../../electron/ipc/applicationBundle.js';
import { OFFICIAL_POSTING_GENERATION_RECEIPT_MAX_AGE_MS } from '../../electron/ipc/officialPostingFields.js';

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const officialText = 'Requirements: build reliable platform services and review operational incidents with engineering colleagues.';
const row = extra => ({ title: 'Platform Engineer at Northwind Labs', company: 'Acme Talent Partners', location: 'Remote, Canada',
  salary: 'CAD 120000 per year', snippet: 'Our client is hiring a platform engineer to maintain reliable services and review operational incidents.',
  url: 'https://board.example.test/role/one', googleCardUrl: 'https://www.google.com/search?htidocid=synthetic-one',
  sourceJobKey: 'synthetic-one', postingVariants: [{ location: 'Remote, Canada', url: 'https://board.example.test/role/one' }], ...extra });
const prepared = (description = officialText, extra = {}) => ({ description, postedBy: 'Acme Talent Partners',
  officialPosting: { level: 'L2', outcome: 'found', employer: 'Northwind Labs', title: 'Platform Engineer',
    sourceUrl: 'https://jobs.ashbyhq.com/northwind-synthetic/posting-one',
    officialApplyUrl: 'https://jobs.ashbyhq.com/northwind-synthetic/posting-one/application',
    ats: 'ashby', tenant: 'northwind-synthetic', contentHash: hash(description), trail: ['careers-page'], ...extra } });

export default [
  {
    name: 'generation refresh freezes a replacement official link and current description without rebuilding the saved card',
    async run() {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'official-posting-refreshed-queue-'));
      const canvasFilePath = path.join(directory, 'canvas.json');
      try {
        await fs.promises.writeFile(canvasFilePath, '{}');
        const { snapshotId: careerSnapshotId } = await writeApprovedCareerSnapshotFixture();
        const raw = row();
        const store = createOfficialPostingStore(path.join(directory, 'official-postings'));
        await store.save(project(raw), { officialPosting: prepared().officialPosting, description: officialText });
        const currentText = `${officialText} Current responsibilities now include reviewing route scheduling data with partner teams.`;
        const currentUrl = 'https://jobs.ashbyhq.com/northwind-synthetic/current-posting';
        let discoveries = 0;
        const result = await prepareOfficialPostingForGeneration({ job: { ...raw, officialPosting: prepared().officialPosting },
          cardId: 'refresh-card', nodeId: 'refresh-board', manualAiRunId: 'refresh-generation' }, {
          projectJob: project, store, bridgeStatus: () => ({ enabled: true, link: { state: 'linked' } }),
          resolve: async (jobs, options) => {
            discoveries++; assert.equal(options.bypassCache, true);
            const posting = { ...prepared(currentText).officialPosting, title: 'Software Platform Engineer',
              location: { display: 'Brookvale, Ontario, Canada', workMode: 'hybrid', remote: false },
              salary: { text: 'CAD 130000–150000 per year', provenance: 'posted' },
              sourceUrl: currentUrl, officialApplyUrl: `${currentUrl}/application`,
              trail: ['semantic-match-v1', 'comparative-match'],
              semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(jobs[0]), sourceHash: hash(currentText) } };
            const record = await store.save(jobs[0], { officialPosting: posting, description: currentText });
            return { jobs: [{ ...jobs[0], postedBy: raw.company, officialPosting: record.officialPosting }] };
          },
        });
        assert.equal(discoveries, 1); assert.equal(result.officialPosting.sourceUrl, currentUrl);
        const queued = await queueLocalApplicationJob({ canvasFilePath, careerSnapshotId, transport: 'paste', nodeId: 'refresh-card',
          resolutionId: result.resolutionId, job: { ...raw, officialPosting: prepared().officialPosting } });
        const input = JSON.parse(await fs.promises.readFile(path.join(queued.folder, 'input.json'), 'utf8'));
        assert.equal(input.job.officialPosting.sourceUrl, currentUrl);
        assert.equal(input.job.applyUrl, `${currentUrl}/application`);
        assert.equal(input.job.snippet, currentText);
        assert.equal(input.job.company, 'Northwind Labs');
        assert.equal(input.job.title, 'Software Platform Engineer');
        assert.equal(input.job.location, 'Brookvale, Ontario, Canada');
        assert.equal(input.job.salary, 'CAD 130000–150000 per year');
        assert.equal(input.job.salaryProvenance, 'posted');
        assert.equal(await fs.promises.readFile(path.join(queued.folder, 'context', 'scraped-listing.md'), 'utf8'),
          formatOriginalJobListingMarkdown(project(raw)));
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'production queue requires a recent generation lookup and rejects a closed official source before creating files',
    async run() {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'official-posting-fresh-queue-'));
      const canvasFilePath = path.join(directory, 'canvas.json');
      try {
        await fs.promises.writeFile(canvasFilePath, '{}');
        const { snapshotId: careerSnapshotId } = await writeApprovedCareerSnapshotFixture();
        const raw = row({ title: 'Platform Engineer', company: 'Northwind Labs',
          listingLiveness: { verdict: 'open', basis: 'ai', board: 'linkedin', at: new Date().toISOString() } });
        for (const [kind,age] of [['expired', OFFICIAL_POSTING_GENERATION_RECEIPT_MAX_AGE_MS + 1], ['closed', 0]]) {
          const result = await prepareOfficialPostingForGeneration({ job: raw, cardId: 'fresh-card', nodeId: 'fresh-board', manualAiRunId: `fresh-${kind}` }, {
            projectJob: project, now: () => Date.now() - age,
            store: createOfficialPostingStore(path.join(directory, `store-${kind}`)),
            bridgeStatus: () => ({ enabled: true, link: { state: 'linked' } }),
            resolve: async jobs => ({ jobs: jobs.map(job => ({ ...job, officialPosting: { level: 'L5', employer: job.company,
              outcome: kind === 'closed' ? 'closed' : 'not-found',
              trail: kind === 'closed' ? ['closed', 'semantic-match-v1'] : [OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL, 'bridge-research', 'semantic-match-v1'],
              semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(job) } } })) }),
          });
          assert.ok(result.resolutionId);
          await assert.rejects(queueLocalApplicationJob({ canvasFilePath, careerSnapshotId, transport: 'paste', nodeId: 'fresh-card',
            resolutionId: result.resolutionId, job: raw, listingOverride: true }),
          error => error.code === (kind === 'closed' ? 'OFFICIAL_POSTING_CLOSED' : 'OFFICIAL_POSTING_LOOKUP_STALE'));
          assert.equal(fs.existsSync(path.join(directory, '.local-ai')), false);
        }
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'semantic queue freeze retains a verified hyphenated employer and its official description',
    run() {
      const raw = row();
      const input = project(raw);
      const value = prepared(officialText, { employer: 'Atlas-Orbit Labs', trail: ['semantic-match-v1'],
        semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(input), sourceHash: 'd'.repeat(64) } });
      const result = freeze(raw, value);
      assert.equal(result.company, 'Atlas-Orbit Labs');
      assert.equal(result.postedBy, raw.company);
      assert.equal(result.snippet, officialText);
      assert.equal(result.officialPosting.level, 'L2');
      const changed = freeze({ ...raw, snippet: 'Different source facts.' }, value);
      assert.notEqual(changed.officialPosting.level, 'L2', 'a mismatched semantic proof cannot bypass the legacy fallback');
    },
  },
  {
    name: 'fresh official text does not republish absent current pay and location from the original board metadata',
    run() {
      const raw = row({ salary: 'Old board pay', salaryProvenance: 'posted', location: 'Old board location' });
      const value = { ...prepared(officialText, { location: undefined, salary: undefined }),
        freshness: 'fresh-discovery', semanticMatching: true };
      const current = freeze(raw, value);
      assert.equal(current.snippet, officialText);
      assert.equal(current.salary, ''); assert.equal(current.salaryProvenance, 'unknown'); assert.equal(current.location, '');
      const linkOnly = freeze(raw, { ...value, officialPosting: { ...value.officialPosting, level: 'L4', outcome: 'link-only', contentHash: '' } });
      assert.equal(linkOnly.snippet, raw.snippet);
      assert.equal(linkOnly.salary, raw.salary); assert.equal(linkOnly.location, raw.location);
      assert.equal(raw.salary, 'Old board pay'); assert.equal(raw.location, 'Old board location');
    },
  },
  {
    name: 'official-posting freeze overlays only trusted employer and complete text while preserving scraped identity and second-pass fields',
    run() {
      const raw = row(); const before = structuredClone(raw); const job = freeze(raw, prepared());
      assert.equal(job.company, 'Northwind Labs'); assert.equal(job.snippet, officialText);
      assert.equal(job.postedBy, raw.company); assert.equal(job.applyUrl, prepared().officialPosting.officialApplyUrl);
      assert.equal(job.officialPosting.level, 'L2');
      for (const key of ['title', 'location', 'salary', 'url', 'googleCardUrl', 'sourceJobKey', 'postingVariants']) assert.deepEqual(job[key], project(raw)[key]);
      assert.deepEqual(project(job), job); assert.deepEqual(raw, before);
    },
  },
  {
    name: 'official-posting freeze discards renderer employer, poster, link and resolution authority without a prepared record',
    run() {
      const forged = row({ officialPosting: prepared().officialPosting, postedBy: 'Forged Poster', applyUrl: 'https://forged.example.test/apply' });
      const unknown = freeze(forged);
      assert.equal(unknown.company, ''); assert.equal(unknown.postedBy, forged.company);
      assert.equal(unknown.officialPosting.level, 'L6'); assert.ok(unknown.officialPosting.trail.includes('no-resolution'));
      assert.equal(unknown.applyUrl, ''); assert.equal(unknown.snippet, forged.snippet);
      const own = freeze(row({ company: 'Northwind Labs', title: 'Platform Engineer', snippet: 'Maintain platform services for the engineering team.' }));
      assert.equal(own.company, 'Northwind Labs'); assert.equal(own.officialPosting.level, 'L5');
    },
  },
  {
    name: 'official-posting freeze rejects oversized official text as L4 without clipping it or losing the verified apply link',
    run() {
      const text = 'x'.repeat(LOCAL_AI_APPLICATION_SNIPPET_MAX_CHARS + 1);
      const raw = row(); const job = freeze(raw, prepared(text));
      assert.equal(job.officialPosting.level, 'L4'); assert.equal(job.officialPosting.outcome, 'link-only');
      assert.ok(job.officialPosting.trail.includes('oversize')); assert.equal(job.snippet, raw.snippet);
      assert.equal(job.company, 'Northwind Labs'); assert.equal(job.applyUrl, prepared().officialPosting.officialApplyUrl);
      assert.ok(!job.officialPosting.contentHash);
    },
  },
  {
    name: 'official-posting freeze rejects altered controls, edge whitespace, mismatched hashes and unnameable official employers',
    run() {
      for (const text of [`${officialText}\u0000`, `${officialText}\r`, ` ${officialText}`, `${officialText}\n`]) {
        const job = freeze(row(), prepared(text));
        assert.equal(job.officialPosting.level, 'L4'); assert.ok(job.officialPosting.trail.includes('invalid-text'));
        assert.equal(job.snippet, row().snippet);
      }
      assert.equal(freeze(row(), prepared(officialText, { contentHash: '0'.repeat(64) })).officialPosting.level, 'L4');
      const unnamed = freeze(row(), prepared(officialText, { employer: 'Northwind; injected employer' }));
      assert.equal(unnamed.officialPosting.level, 'L4'); assert.equal(unnamed.company, '');
      const linkOnly = freeze(row(), prepared('', { level: 'L4', outcome: 'link-only', contentHash: '' }));
      assert.equal(linkOnly.company, 'Northwind Labs'); assert.equal(linkOnly.snippet, row().snippet);
      const unsafeFallback = freeze(row(), prepared('', { level: 'L5', outcome: 'not-found', employer: 'Northwind; unsafe name', contentHash: '' }));
      assert.equal(unsafeFallback.officialPosting.level, 'L6'); assert.equal(unsafeFallback.company, '');
    },
  },
  {
    name: 'official-posting queue consumes the real bound prepare record and freezes official evidence before authority is created',
    async run() {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'official-posting-bound-queue-'));
      const canvasFilePath = path.join(directory, 'canvas.json');
      try {
        await fs.promises.writeFile(canvasFilePath, '{}');
        const { snapshotId: careerSnapshotId } = await writeApprovedCareerSnapshotFixture();
        const raw = row({ snippet: `${row().snippet} SCRAPED_AUDIT_ONLY_SENTINEL` }); const text = `${officialText} `.repeat(6).trim();
        const store = createOfficialPostingStore(path.join(directory, 'official-postings'));
        await store.save(project(raw), { officialPosting: prepared(text).officialPosting, description: text });
        const node = { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Platform Engineer',
          hiringOrganization: { name: 'Northwind Labs' }, url: prepared().officialPosting.sourceUrl,
          jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: { '@type': 'Country', name: 'Canada' },
          description: text, validThrough: '2030-12-31', baseSalary: { currency: 'CAD', value: { value: 120000, unitText: 'YEAR' } } };
        const preparedResult = await prepareOfficialPostingForGeneration({ job: raw, cardId: 'bound-card', nodeId: 'bound-board', manualAiRunId: 'bound-run' }, {
          projectJob: project, store, semanticMatching: false, bridgeStatus: () => ({ enabled: false }),
          fetch: async url => ({ body: `<script type="application/ld+json">${JSON.stringify(node)}</script>`, contentType: 'text/html', statusCode: 200, url }),
        });
        assert.ok(preparedResult.resolutionId); assert.equal(preparedResult.officialPosting.level, 'L2');
        registerLocalAiApplicationHandlers();
        const sender = { id: 71941, isDestroyed: () => false, once() {}, on() {}, removeListener() {} };
        const response = await ipcMain.__getInvokeHandler('queue-local-application')({ sender }, { canvasFilePath, careerSnapshotId, transport: 'paste', nodeId: 'bound-card',
          resolutionId: preparedResult.resolutionId, job: { ...raw, postedBy: 'Forged Poster', applyUrl: 'https://forged.example.test/apply',
            officialPosting: { ...prepared().officialPosting, employer: 'Forged Employer' } } });
        assert.equal(response.success, true, response.error);
        assert.equal(response.officialPosting.level, 'L2'); assert.equal(response.postedBy, raw.company);
        const queued = response.localJob;
        const input = JSON.parse(await fs.promises.readFile(path.join(queued.folder, 'input.json'), 'utf8'));
        assert.equal(input.job.company, 'Northwind Labs'); assert.equal(input.job.snippet, text);
        assert.equal(input.job.postedBy, raw.company); assert.equal(input.job.officialPosting.contentHash, hash(text));
        assert.equal(input.job.title, raw.title); assert.equal(input.job.url, raw.url);
        assert.ok(input.job.applyUrl.startsWith('https://jobs.ashbyhq.com/northwind-synthetic/'));
        const scrapedPath = path.join(queued.folder, 'context', 'scraped-listing.md');
        const expectedScraped = formatOriginalJobListingMarkdown(project(raw));
        assert.equal(await fs.promises.readFile(scrapedPath, 'utf8'), expectedScraped);
        assert.equal(input.job.officialPosting.scrapedListingSha256, hash(expectedScraped));
        if (process.platform !== 'win32') assert.equal((await fs.promises.stat(scrapedPath)).mode & 0o777, 0o600);
        const beforeAuditEdit = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath });
        assert.ok(!beforeAuditEdit.handoff.prompt.includes('SCRAPED_AUDIT_ONLY_SENTINEL'));
        const inputBytes = await fs.promises.readFile(path.join(queued.folder, 'input.json'));
        await fs.promises.writeFile(scrapedPath, 'This audit sidecar is not prompt or authority evidence.');
        const open = fs.promises.open; const readFile = fs.promises.readFile; let auditReadAttempts = 0;
        let afterAuditEdit;
        try {
          const refuseAuditRead = file => {
            if (String(file) === scrapedPath) { auditReadAttempts++; throw new Error('The scraped audit is not a frozen authority source.'); }
          };
          fs.promises.open = async (file, ...args) => { refuseAuditRead(file); return open(file, ...args); };
          fs.promises.readFile = async (file, ...args) => { refuseAuditRead(file); return readFile(file, ...args); };
          afterAuditEdit = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath });
        } finally { fs.promises.open = open; fs.promises.readFile = readFile; }
        assert.equal(auditReadAttempts, 0);
        assert.equal(afterAuditEdit.handoff.prompt, beforeAuditEdit.handoff.prompt);
        assert.deepEqual(await fs.promises.readFile(path.join(queued.folder, 'input.json')), inputBytes);
        await fs.promises.writeFile(scrapedPath, expectedScraped, { mode: 0o600 });
        await assert.rejects(queueLocalApplicationJob({ canvasFilePath, careerSnapshotId, transport: 'paste', nodeId: 'foreign-card',
          resolutionId: preparedResult.resolutionId, job: { ...raw, title: 'Different Engineer at Northwind Labs' } }),
        error => error.code === 'OFFICIAL_POSTING_LOOKUP_INCOMPLETE');
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'official-posting queue rejects unknown receipts while retained internal fixtures preserve their source projection',
    async run() {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'official-posting-freeze-'));
      const canvasFilePath = path.join(directory, 'canvas.json');
      try {
        await fs.promises.writeFile(canvasFilePath, '{}');
        const { snapshotId: careerSnapshotId } = await writeApprovedCareerSnapshotFixture();
        const raw = row({ officialPosting: prepared().officialPosting, postedBy: 'Forged Poster', applyUrl: 'https://forged.example.test/apply' });
        await assert.rejects(queueLocalApplicationJob({ canvasFilePath, careerSnapshotId, transport: 'paste', job: raw,
          resolutionId: crypto.randomUUID(), nodeId: 'freeze-synthetic-card' }), error => error.code === 'OFFICIAL_POSTING_LOOKUP_INCOMPLETE');
        assert.equal(fs.existsSync(path.join(directory, '.local-ai')), false, 'a bad source receipt creates no queue files');
        const own = row({ company: 'Northwind Labs', title: 'Platform Engineer', snippet: 'Maintain platform services for the engineering team.' });
        const unchanged = await queueLocalApplicationJob({ canvasFilePath, careerSnapshotId, transport: 'paste', job: own, nodeId: 'unchanged-synthetic-card' });
        const unchangedInput = JSON.parse(await fs.promises.readFile(path.join(unchanged.folder, 'input.json'), 'utf8'));
        assert.equal(unchangedInput.job.company, own.company); assert.equal(unchangedInput.job.snippet, own.snippet);
        assert.equal(Object.hasOwn(unchangedInput.job.officialPosting, 'scrapedListingSha256'), false);
        assert.equal(fs.existsSync(path.join(unchanged.folder, 'context', 'scraped-listing.md')), false);
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'official-posting production queue rejects missing and incomplete receipts despite forged renderer lookup state',
    async run() {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'official-posting-queue-gate-'));
      const canvasFilePath = path.join(directory, 'canvas.json');
      try {
        await fs.promises.writeFile(canvasFilePath, '{}');
        const { snapshotId: careerSnapshotId } = await writeApprovedCareerSnapshotFixture();
        const raw = row({ title: 'Platform Engineer', company: 'Northwind Labs' });
        const result = await prepareOfficialPostingForGeneration({ job: raw, cardId: 'incomplete-card', nodeId: 'incomplete-board', manualAiRunId: 'incomplete-run' }, {
          projectJob: project, store: createOfficialPostingStore(path.join(directory, 'official-postings')),
          bridgeStatus: () => ({ enabled: false }), fetch: async () => { throw Object.assign(new Error('Unavailable'), { code: 'fetch-failed' }); },
        });
        assert.ok(result.resolutionId);
        assert.equal(result.listingCheck.action, 'refuse-retry');
        registerLocalAiApplicationHandlers();
        const sender = { id: 71942, isDestroyed: () => false, once() {}, on() {}, removeListener() {} };
        for (const resolutionId of [undefined, crypto.randomUUID(), result.resolutionId]) {
          const response = await ipcMain.__getInvokeHandler('queue-local-application')({ sender }, {
            canvasFilePath, careerSnapshotId, transport: 'paste', nodeId: 'incomplete-card', resolutionId,
            listingOverride: true, job: { ...raw, officialPosting: prepared().officialPosting },
          });
          assert.equal(response.success, false);
          assert.match(response.error, /official posting|lookup/iu);
          assert.equal(fs.existsSync(path.join(directory, '.local-ai')), false, 'a refused lookup creates no queued application');
        }
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
];
