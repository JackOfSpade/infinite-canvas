import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import electronPkg from 'electron';
import { formatOriginalJobListingMarkdown } from '../../electron/ipc/applicationBundle.js';
import {
  GENERATION_AUDIT_VERSION, __resolveApplicationExportDirectoryForTests,
  inspectApplicationExport, legacyListingCollisionBytes, registerJobApplicationHandlers, registerPendingApplicationWorkspace,
} from '../../electron/ipc/jobApplication.js';
import { __withSyncedGenerationAuditSavedArtifactsForTests } from '../../electron/ipc/applicationSync.js';

const { ipcMain } = electronPkg;
const sha256 = value => value == null ? null : crypto.createHash('sha256').update(value).digest('hex');
const job = extra => ({ title: 'Platform Engineer', company: 'Acme Talent Partners', location: 'Lakeview, Canada',
  snippet: 'Synthetic original listing describes reliable platform tools.', url: 'https://board.example.test/platform',
  postedBy: 'Acme Talent Partners', applyUrl: 'https://careers.example.test/platform',
  officialPosting: { level: 'L4', employer: 'Acme Talent Partners' }, ...extra });
const html = label => `<!doctype html><html><body><section data-ic-document-panel="resume"><main class="page">${label} resume</main></section><section data-ic-document-panel="cover"><main class="page">${label} cover</main></section><script id="ic-application-bundle-data" type="application/json">{}</script></body></html>`;
function auditFor({ applicationHtml, listing, scraped, legacy = false }) {
  return {
    version: GENERATION_AUDIT_VERSION, schema: 'infinite-canvas-generation-audit', jobId: 'synthetic-audit-job',
    createdAt: '2026-01-01T00:00:00.000Z', scope: {}, job: {}, inputSummary: { generationAuditRequired: false },
    finalArtifacts: { resultSha256: 'a'.repeat(64), resumeContentSha256: 'b'.repeat(64), coverLetterContentSha256: 'c'.repeat(64),
      stagedApplicationHtmlSha256: sha256(applicationHtml), originalJobListingSha256: sha256(listing),
      resumePdfSha256: null, coverLetterPdfSha256: null, ...(legacy ? {} : { scrapedListingSha256: sha256(scraped) }) },
    coverLetterArgument: {}, writerQualityReview: {}, hostValidation: {}, measuredFit: {}, handoff: {},
  };
}
async function fixture(run) {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'official-audit-')));
  const outputRoot = path.join(root, 'applications'); await fs.promises.mkdir(outputRoot);
  const sender = Object.assign(new EventEmitter(), { id: 9801, isDestroyed: () => false });
  registerJobApplicationHandlers();
  let sequence = 0;
  const context = {
    root, outputRoot,
    async workspace({ value = job(), scraped = null, company = value.company, identityCompany = null,
      label = 'Synthetic', legacyAudit = false, register = true } = {}) {
      const workDir = path.join(root, `source-${++sequence}`); await fs.promises.mkdir(workDir);
      const resumeHtml = html(label); const listing = formatOriginalJobListingMarkdown(value, { audience: 'bundle' });
      const generationAudit = `${JSON.stringify(auditFor({ applicationHtml: resumeHtml, listing, scraped, legacy: legacyAudit }))}\n`;
      const resumeHtmlPath = path.join(workDir, 'Application.html'); const jobListingPath = path.join(workDir, 'Original Job Listing.md');
      const generationAuditPath = path.join(workDir, 'Generation Audit.json');
      const scrapedListingPath = scraped == null ? null : path.join(workDir, 'Scraped Listing.md');
      await Promise.all([
        fs.promises.writeFile(resumeHtmlPath, resumeHtml), fs.promises.writeFile(jobListingPath, listing),
        fs.promises.writeFile(generationAuditPath, generationAudit),
        ...(scrapedListingPath ? [fs.promises.writeFile(scrapedListingPath, scraped)] : []),
      ]);
      const registration = { workDir, senderId: sender.id, company, identityCompany, applicationRoot: outputRoot,
        resumeHtmlPath, jobListingPath, generationAuditPath, scrapedListingPath,
        generationAuditJobId: 'synthetic-audit-job', generationAuditRequired: false,
        cleanupOnDiscard: false, cleanupOnSaveFailure: false,
        artifactData: { resumeHtml, jobListing: listing, generationAudit, scrapedListing: scraped } };
      if (register) registerPendingApplicationWorkspace(registration);
      return { registration, resumeHtml, listing, generationAudit, scraped,
        args: { resumeHtmlPath, jobListingPath, generationAuditPath, scrapedListingPath, workDir,
          jobTitle: value.title, location: value.location, canvasFilePath: path.join(root, 'canvas.json'), suppressReveal: true } };
    },
    save(workspace, extra = {}) { return ipcMain.__getInvokeHandler('save-application')({ sender }, { ...workspace.args, ...extra }); },
  };
  try { await run(context); } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
}
async function bundleBytes(directory) {
  const names = (await fs.promises.readdir(directory)).filter(name => !name.startsWith('.')).sort();
  return Object.fromEntries(await Promise.all(names.map(async name => [name, (await fs.promises.readFile(path.join(directory, name))).toString('base64')])));
}

const tests = [
  {
    name: 'official-posting audit collision normalization removes only formatter header lines and preserves all other bytes',
    run() {
      const original = job({ snippet: '**Posted by:** keep this body line\n**Apply URL:** keep this too\n**Official posting:** keep this body link\n**Source level:** keep this body level',
        officialPosting: { level: 'L4', employer: 'Acme Talent Partners', sourceUrl: 'https://careers.example.test/platform' } });
      const legacy = Buffer.from(formatOriginalJobListingMarkdown(original));
      assert.equal(legacyListingCollisionBytes(legacy), legacy, 'header-free legacy bytes need no reconstruction');
      for (let mask = 1; mask < 8; mask++) {
        const value = job({ ...original, postedBy: mask & 1 ? original.postedBy : '', applyUrl: mask & 2 ? original.applyUrl : '',
          officialPosting: mask & 4 ? original.officialPosting : undefined });
        assert.deepEqual(legacyListingCollisionBytes(Buffer.from(formatOriginalJobListingMarkdown(value, { audience: 'bundle' }))), legacy);
      }
      const malformed = Buffer.from('# A\n**Posted by:** Leave this without a separator\n');
      assert.equal(legacyListingCollisionBytes(malformed), malformed);
      const binaryTail = Buffer.concat([Buffer.from('# A\n**Posted by:** Remove\n\n---\n'), Buffer.from([255, 0, 13, 10])]);
      assert.deepEqual(legacyListingCollisionBytes(binaryTail), Buffer.concat([Buffer.from('# A\n\n---\n'), Buffer.from([255, 0, 13, 10])]));
      const almost = Buffer.from('# A\n **Posted by:** Keep\n**Posted by:** Keep CRLF\r\n\n---\n**Posted by:** Keep body\n');
      assert.equal(legacyListingCollisionBytes(almost), almost, 'only exact formatter LF header lines may be removed');
    },
  },
  {
    name: 'official-posting audit saves exact scraped bytes and L2 to L4 regeneration reuses its employer folder while removing stale audit',
    async run() {
      await fixture(async test => {
        const original = job({ company: 'Northwind Labs', postedBy: '', officialPosting: { level: 'L4', employer: 'Northwind Labs' } });
        const scraped = formatOriginalJobListingMarkdown(original);
        const l2 = await test.workspace({ value: job({ company: 'Northwind Labs', snippet: 'Different synthetic official posting body.',
          officialPosting: { level: 'L2', employer: 'Northwind Labs' } }), scraped, identityCompany: original.company, label: 'L2' });
        const saved = await test.save(l2); assert.equal(saved.success, true, saved.error);
        assert.equal(saved.dir, path.join(test.outputRoot, original.company, original.location, original.title));
        assert.equal(path.basename(saved.scrapedListingFile), 'Scraped Listing.md');
        assert.equal(await fs.promises.readFile(saved.scrapedListingFile, 'utf8'), scraped);
        assert.equal((await fs.promises.stat(saved.scrapedListingFile)).mode & 0o777, 0o600);
        const receipt = JSON.parse(await fs.promises.readFile(saved.generationAuditFile, 'utf8'));
        assert.equal(receipt.finalArtifacts.scrapedListingSha256, sha256(scraped));
        assert.equal(receipt.savedArtifacts.scrapedListingSha256, sha256(scraped));
        const manifest = await inspectApplicationExport([{ path: saved.scrapedListingFile, expected: true, expectedData: scraped, kind: 'markdown' }]);
        assert.equal(manifest[0].integrityVerified, true);
        const l4 = await test.workspace({ value: original, identityCompany: original.company, label: 'L4' });
        const regenerated = await test.save(l4); assert.equal(regenerated.success, true, regenerated.error);
        assert.equal(regenerated.dir, saved.dir); assert.equal(regenerated.scrapedListingFile, null);
        assert.equal(fs.existsSync(saved.scrapedListingFile), false, 'absence removes the previous optional audit in the same transaction');
        assert.match(await fs.promises.readFile(regenerated.applicationFile, 'utf8'), /L4 resume/u);
        assert.equal(JSON.parse(await fs.promises.readFile(regenerated.generationAuditFile, 'utf8')).savedArtifacts.scrapedListingSha256, null);
      });
    },
  },
  {
    name: 'official-posting audit files recruiter-posted L2 under the verified employer and reuses that folder at L4',
    async run() {
      await fixture(async test => {
        const original = job(); const scraped = formatOriginalJobListingMarkdown(original);
        const employer = 'Northwind Labs';
        const l2 = await test.workspace({ value: job({ company: employer, snippet: 'Complete synthetic official duties.',
          officialPosting: { level: 'L2', employer, sourceUrl: 'https://careers.northwind.test/platform' } }),
        scraped, identityCompany: original.company, label: 'Recruiter L2' });
        const saved = await test.save(l2); assert.equal(saved.success, true, saved.error);
        assert.equal(saved.dir, path.join(test.outputRoot, employer, original.location, original.title));
        assert.equal(await fs.promises.readFile(saved.scrapedListingFile, 'utf8'), scraped);
        const l4 = await test.workspace({ value: job({ company: employer,
          officialPosting: { level: 'L4', employer, sourceUrl: 'https://careers.northwind.test/platform' } }),
        scraped, identityCompany: original.company, label: 'Recruiter L4' });
        const regenerated = await test.save(l4); assert.equal(regenerated.success, true, regenerated.error);
        assert.equal(regenerated.dir, saved.dir);
        assert.equal(await fs.promises.readFile(regenerated.scrapedListingFile, 'utf8'), scraped);
        assert.match(await fs.promises.readFile(regenerated.applicationFile, 'utf8'), /Recruiter L4 resume/u);
        assert.equal(fs.existsSync(path.join(test.outputRoot, original.company)), false);
      });
    },
  },
  {
    name: 'official-posting audit collision identity matches a pre-change occupant and splits genuinely distinct scraped postings',
    async run() {
      await fixture(async test => {
        const original = job(); const scraped = formatOriginalJobListingMarkdown(original);
        const legacyDir = path.join(test.outputRoot, original.company, original.location, original.title);
        await fs.promises.mkdir(legacyDir, { recursive: true });
        await fs.promises.writeFile(path.join(legacyDir, 'Original Job Listing.md'), scraped);
        const first = await test.workspace({ value: job({ snippet: 'Synthetic official body.', officialPosting: { level: 'L2' } }), scraped });
        const saved = await test.save(first); assert.equal(saved.success, true, saved.error); assert.equal(saved.dir, legacyDir);
        const before = await bundleBytes(legacyDir);
        const otherRaw = job({ snippet: 'A genuinely different synthetic posting body.' });
        const second = await test.workspace({ value: job({ snippet: 'Second official body.', officialPosting: { level: 'L3' } }),
          scraped: formatOriginalJobListingMarkdown(otherRaw) });
        const distinct = await test.save(second); assert.equal(distinct.success, true, distinct.error);
        assert.notEqual(distinct.dir, saved.dir); assert.match(path.basename(distinct.dir), / \([a-f0-9]{8}\)$/u);
        assert.deepEqual(await bundleBytes(legacyDir), before);
        const secondAgain = await test.workspace({ value: otherRaw, label: 'Second fallback' });
        const reused = await test.save(secondAgain); assert.equal(reused.success, true, reused.error); assert.equal(reused.dir, distinct.dir);
      });
    },
  },
  {
    name: 'official-posting audit capability requires contained fingerprinted paths and refuses omitted, changed or linked sources',
    async run() {
      await fixture(async test => {
        const scraped = formatOriginalJobListingMarkdown(job());
        const source = await test.workspace({ scraped, register: false });
        const { registration } = source;
        assert.throws(() => registerPendingApplicationWorkspace({ ...registration,
          scrapedListingPath: path.join(test.root, 'outside.md') }), /escaped its registered workspace/u);
        assert.throws(() => registerPendingApplicationWorkspace({ ...registration,
          artifactData: { ...registration.artifactData, scrapedListing: undefined } }), /trusted source fingerprints/u);
        const badAudit = JSON.parse(source.generationAudit); badAudit.finalArtifacts.scrapedListingSha256 = 'f'.repeat(64);
        assert.throws(() => registerPendingApplicationWorkspace({ ...registration,
          artifactData: { ...registration.artifactData, generationAudit: JSON.stringify(badAudit) } }), /staged application artifacts/u);
        delete badAudit.finalArtifacts.scrapedListingSha256;
        assert.throws(() => registerPendingApplicationWorkspace({ ...registration,
          artifactData: { ...registration.artifactData, generationAudit: JSON.stringify(badAudit) } }), /staged application artifacts/u);
        registerPendingApplicationWorkspace(registration);
        const omitted = await test.save(source, { scrapedListingPath: null });
        assert.equal(omitted.success, false); assert.match(omitted.error, /paths did not match/u);
        await fs.promises.appendFile(source.args.scrapedListingPath, 'changed');
        const changed = await test.save(source); assert.equal(changed.success, false); assert.match(changed.error, /changed after it was registered/u);
        const linked = await test.workspace({ scraped });
        const external = path.join(test.root, 'unrelated.md'); await fs.promises.writeFile(external, scraped);
        await fs.promises.unlink(linked.args.scrapedListingPath); await fs.promises.symlink(external, linked.args.scrapedListingPath);
        const refused = await test.save(linked); assert.equal(refused.success, false); assert.match(refused.error, /regular files, not links/u);
        assert.equal(await fs.promises.readFile(external, 'utf8'), scraped);
      });
    },
  },
  {
    name: 'official-posting audit failed staging or readback rolls back the entire prior bundle and removes every transaction temporary',
    async run() {
      await fixture(async test => {
        const scraped = formatOriginalJobListingMarkdown(job());
        const first = await test.workspace({ scraped, label: 'Prior' }); const saved = await test.save(first);
        assert.equal(saved.success, true, saved.error); const before = await bundleBytes(saved.dir);
        for (const failure of ['write', 'read']) {
          const next = await test.workspace({ scraped, value: job({ snippet: `New ${failure} official body.` }), label: `New ${failure}` });
          const originalWrite = fs.promises.writeFile; const originalRead = fs.promises.readFile; let injected = false;
          try {
            if (failure === 'write') fs.promises.writeFile = async function(target, ...args) {
              if (path.dirname(String(target)) === saved.dir && path.basename(String(target)).startsWith('.Scraped Listing.md.') && String(target).endsWith('.tmp')) {
                injected = true; throw Object.assign(new Error('Synthetic scraped staging failure'), { code: 'EIO' });
              }
              return originalWrite.call(this, target, ...args);
            };
            else fs.promises.readFile = async function(target, ...args) {
              if (path.resolve(String(target)) === saved.scrapedListingFile) {
                injected = true; throw Object.assign(new Error('Synthetic scraped readback failure'), { code: 'EIO' });
              }
              return originalRead.call(this, target, ...args);
            };
            const result = await test.save(next); assert.equal(result.success, false); assert.equal(injected, true);
          } finally { fs.promises.writeFile = originalWrite; fs.promises.readFile = originalRead; }
          assert.deepEqual(await bundleBytes(saved.dir), before, `${failure} failure must restore every prior sibling byte`);
          assert.equal((await fs.promises.readdir(saved.dir)).some(name => name.endsWith('.tmp') || name.endsWith('.bak')), false);
        }
      });
    },
  },
  {
    name: 'official-posting audit collision compares present scraped bytes exactly and refuses an unsafe occupant without original fallback',
    async run() {
      await fixture(async test => {
        const baseDir = path.join(test.outputRoot, 'Company', 'Location', 'Role');
        await fs.promises.mkdir(baseDir, { recursive: true });
        const bundle = Buffer.from(formatOriginalJobListingMarkdown(job(), { audience: 'bundle' }));
        const legacy = legacyListingCollisionBytes(bundle);
        await fs.promises.writeFile(path.join(baseDir, 'Scraped Listing.md'), bundle);
        await fs.promises.writeFile(path.join(baseDir, 'Original Job Listing.md'), legacy);
        const exact = await __resolveApplicationExportDirectoryForTests(test.outputRoot, baseDir, bundle, { currentScrapedListing: true });
        assert.equal(exact.dir, baseDir);
        const differs = await __resolveApplicationExportDirectoryForTests(test.outputRoot, baseDir, legacy, { currentScrapedListing: true });
        assert.notEqual(differs.dir, baseDir, 'present scraped bytes are never normalized or replaced by the original sibling');
        await fs.promises.unlink(path.join(baseDir, 'Scraped Listing.md'));
        await fs.promises.symlink(path.join(baseDir, 'Original Job Listing.md'), path.join(baseDir, 'Scraped Listing.md'));
        await assert.rejects(__resolveApplicationExportDirectoryForTests(test.outputRoot, baseDir, legacy), /regular files, not links/u);
      });
    },
  },
  {
    name: 'official-posting audit optional hashes preserve legacy saves and Sync keeps scraped provenance unchanged while validating its format',
    async run() {
      await fixture(async test => {
        const legacy = await test.workspace({ legacyAudit: true }); const saved = await test.save(legacy);
        assert.equal(saved.success, true, saved.error); assert.equal(saved.scrapedListingFile, null);
        const receipt = JSON.parse(await fs.promises.readFile(saved.generationAuditFile, 'utf8'));
        assert.equal(Object.hasOwn(receipt.finalArtifacts, 'scrapedListingSha256'), false);
        assert.equal(Object.hasOwn(receipt.savedArtifacts, 'scrapedListingSha256'), false);
        for (const hash of [undefined, null, 'd'.repeat(64)]) {
          const audit = structuredClone(receipt);
          if (hash !== undefined) { audit.finalArtifacts.scrapedListingSha256 = hash; audit.savedArtifacts.scrapedListingSha256 = hash; }
          const synced = JSON.parse(__withSyncedGenerationAuditSavedArtifactsForTests(JSON.stringify(audit), {
            applicationHtml: 'Synthetic edited HTML', documentKind: 'resume', pdf: Buffer.from('Synthetic PDF'),
          }));
          assert.deepEqual(synced.finalArtifacts, audit.finalArtifacts);
          assert.equal(synced.savedArtifacts.scrapedListingSha256, hash);
          assert.equal(synced.savedArtifacts.originalJobListingSha256, receipt.savedArtifacts.originalJobListingSha256);
          for (const map of ['finalArtifacts', 'savedArtifacts']) for (const invalid of [42, '', 'not-a-hash']) {
            const broken = structuredClone(audit); broken[map].scrapedListingSha256 = invalid;
            assert.throws(() => __withSyncedGenerationAuditSavedArtifactsForTests(JSON.stringify(broken), {
              applicationHtml: 'Synthetic edited HTML', documentKind: 'resume', pdf: Buffer.from('Synthetic PDF'),
            }), /supported durable application audit/u);
          }
        }
      });
    },
  },
];

// Real saves register private capabilities, pending workspaces and IPC handlers.
// A child gets the existing Electron stub's own automatically removed userData
// root, preserving every parent registration rather than resetting global maps.
const runFile = promisify(execFile);
export default process.env.IC_OFFICIAL_POSTING_AUDIT_CHILD === '1' ? tests : tests.map((test, index) => ({
  ...test,
  async run() {
    try {
      await runFile(process.execPath, ['--import', './scripts/test-stubs/register.mjs', '--input-type=module', '-e',
        `const tests = (await import('./scripts/tests/official-posting-audit.js')).default; await tests[${index}].run();`], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: { ...process.env, IC_OFFICIAL_POSTING_AUDIT_CHILD: '1' }, timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`Isolated audit fixture failed: ${test.name}\n${error.stderr || error.message}`, { cause: error });
    }
  },
}));
