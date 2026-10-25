import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLocalGenerationAuditArtifact, stageLocalApplicationWorkspaceArtifacts } from '../../electron/ipc/localAiApplication.js';
import { formatOriginalJobListingMarkdown } from '../../electron/ipc/applicationBundle.js';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const original = formatOriginalJobListingMarkdown({ title: 'Platform Engineer', company: 'Acme Talent Partners',
  snippet: 'SCRAPED_AUDIT_ONLY_SENTINEL: maintain dispatch reporting tools.', url: 'https://board.example.test/jobs/one' });
const listing = formatOriginalJobListingMarkdown({ title: 'Platform Engineer', company: 'Northwind Labs',
  snippet: 'Maintain reliable platform services for engineering colleagues.' }, { audience: 'bundle' });
const staging = outDir => ({ outDir, applicationHtml: '<html><main>New application.</main></html>', jobListingMarkdown: listing,
  scrapedListingMarkdown: original, generationAuditArtifact: '{"new":true}\n' });
async function temporary(run) {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'official-audit-staging-')));
  try { return await run(root); } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
}

export default [
  {
    name: 'Official posting audit staging: exact optional scraped bytes replace a symlink as a private regular file without following it',
    async run() {
      await temporary(async root => {
        const outDir = path.join(root, 'workspace'); await fs.promises.mkdir(outDir);
        const sentinel = path.join(root, 'outside.md'); await fs.promises.writeFile(sentinel, 'Outside bytes stay unchanged.');
        const target = path.join(outDir, 'Scraped Listing.md'); await fs.promises.symlink(sentinel, target);
        const result = await stageLocalApplicationWorkspaceArtifacts(staging(outDir));
        assert.equal(result.scrapedListingPath, target); assert.equal(await fs.promises.readFile(target, 'utf8'), original);
        assert.equal(await fs.promises.readFile(sentinel, 'utf8'), 'Outside bytes stay unchanged.');
        const stat = await fs.promises.lstat(target); assert.ok(stat.isFile() && !stat.isSymbolicLink());
        if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
        assert.equal(await fs.promises.readFile(result.jobListingPath, 'utf8'), listing);
      });
    },
  },
  {
    name: 'Official posting audit staging: absence remains optional and removes a stale scraped sibling atomically',
    async run() {
      await temporary(async root => {
        const first = await stageLocalApplicationWorkspaceArtifacts(staging(root));
        assert.ok(fs.existsSync(first.scrapedListingPath));
        const second = await stageLocalApplicationWorkspaceArtifacts({ ...staging(root), scrapedListingMarkdown: null });
        assert.equal(second.scrapedListingPath, null);
        assert.equal(fs.existsSync(path.join(root, 'Scraped Listing.md')), false);
        const omitted = { ...staging(root) }; delete omitted.scrapedListingMarkdown;
        assert.equal((await stageLocalApplicationWorkspaceArtifacts(omitted)).scrapedListingPath, null);
      });
    },
  },
  {
    name: 'Official posting audit staging: a scraped-file write or promotion failure preserves the entire prior bundle and cleans temporary files',
    async run() {
      for (const failure of ['write', 'promotion']) await temporary(async root => {
        const names = ['Application.html', 'Original Job Listing.md', 'Scraped Listing.md', 'Generation Audit.json', 'Resume.pdf', 'Cover Letter.pdf'];
        await Promise.all(names.map(name => fs.promises.writeFile(path.join(root, name), `Prior ${name} bytes.`)));
        const before = new Map(await Promise.all(names.map(async name => [name, await fs.promises.readFile(path.join(root, name))])));
        const writeFile = fs.promises.writeFile; const rename = fs.promises.rename; let injected = false;
        try {
          if (failure === 'write') fs.promises.writeFile = async (file, ...args) => {
            if (path.basename(String(file)).startsWith('.Scraped Listing.md.') && String(file).endsWith('.tmp')) {
              injected = true; throw Object.assign(new Error('Injected scraped staging write failure'), { code: 'EIO' });
            }
            return writeFile(file, ...args);
          };
          else fs.promises.rename = async (source, destination) => {
            if (!injected && path.basename(String(source)).startsWith('.Scraped Listing.md.') && String(source).endsWith('.tmp')) {
              injected = true; throw Object.assign(new Error('Injected scraped staging promotion failure'), { code: 'EIO' });
            }
            return rename(source, destination);
          };
          await assert.rejects(stageLocalApplicationWorkspaceArtifacts(staging(root)), /Injected scraped staging/u);
        } finally { fs.promises.writeFile = writeFile; fs.promises.rename = rename; }
        assert.equal(injected, true);
        for (const name of names) assert.deepEqual(await fs.promises.readFile(path.join(root, name)), before.get(name));
        assert.deepEqual((await fs.promises.readdir(root)).sort(), names.sort());
      });
    },
  },
  {
    name: 'Official posting audit staging: optional scraped hash is isolated from prompt-source digests and contains no raw audit prose',
    run() {
      const args = { jobId: '123e4567-e89b-42d3-a456-426614174703', input: { job: { title: 'Platform Engineer', company: 'Northwind Labs' } },
        jobListingMarkdown: listing, createdAt: '2026-01-01T00:00:00.000Z' };
      const legacy = JSON.parse(buildLocalGenerationAuditArtifact(args));
      const presentText = buildLocalGenerationAuditArtifact({ ...args, scrapedListingMarkdown: original });
      const present = JSON.parse(presentText);
      assert.equal(Object.hasOwn(legacy.finalArtifacts, 'scrapedListingSha256'), false);
      assert.equal(present.finalArtifacts.scrapedListingSha256, sha(original));
      assert.deepEqual(present.inputSummary.inputDigests, legacy.inputSummary.inputDigests);
      assert.equal(present.finalArtifacts.originalJobListingSha256, sha(listing));
      assert.ok(!presentText.includes('SCRAPED_AUDIT_ONLY_SENTINEL'));
      delete present.finalArtifacts.scrapedListingSha256; assert.deepEqual(present, legacy);
    },
  },
  {
    name: 'Official posting audit staging: card and fallback save capabilities forward the optional registered scraped artifact path',
    async run() {
      const [card, fallback] = await Promise.all([
        fs.promises.readFile(new URL('../../src/nodes/JobCardNode.jsx', import.meta.url), 'utf8'),
        fs.promises.readFile(new URL('../../src/hooks/useLocalAiFallbackManager.js', import.meta.url), 'utf8'),
      ]);
      const cardSave = card.slice(card.indexOf('const saved = await window.electronAPI.saveApplication({'));
      const fallbackSave = fallback.slice(fallback.indexOf('const saved = await window.electronAPI.saveApplication({'));
      assert.ok(cardSave.slice(0, cardSave.indexOf('});')).includes('scrapedListingPath: local.scrapedListingPath'));
      assert.ok(fallbackSave.slice(0, fallbackSave.indexOf('});')).includes('scrapedListingPath: result.scrapedListingPath'));
    },
  },
];
