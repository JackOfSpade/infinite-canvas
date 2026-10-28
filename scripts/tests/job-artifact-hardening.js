import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  APPLICATION_BUNDLE_PART_MAX_BYTES,
  APPLICATION_BUNDLE_PART_MAX_CODE_POINTS,
  formatOriginalJobListingMarkdown,
  normaliseJobPostingVariants,
  sanitizeApplicationBundlePart,
} from '../../electron/ipc/applicationBundle.js';
import { normaliseResumeDownloadBundle } from '../../electron/ipc/resumeHtml.js';
import { __resolveApplicationExportDirectoryForTests } from '../../electron/ipc/jobApplication.js';

export default [
  {
    name: 'application names bound UTF-8 bytes and keep Unicode collision suffixes writable',
    async run() {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ic-unicode-export-')));
      try {
        for (const char of ['職', '🧑']) {
          const name = sanitizeApplicationBundlePart(char.repeat(150), 'Role');
          assert(Buffer.byteLength(name) <= APPLICATION_BUNDLE_PART_MAX_BYTES);
          assert([...name].length <= APPLICATION_BUNDLE_PART_MAX_CODE_POINTS);
          assert(!name.includes('\ufffd'), 'truncation cannot split a Unicode code point');
          assert.equal(normaliseResumeDownloadBundle({ company: char.repeat(150) }).company, name,
            'download metadata and export folders use the same naming policy');
          const output = path.join(root, char === '職' ? 'cjk' : 'emoji');
          await fs.mkdir(output);
          const base = path.join(output, name);
          const original = Buffer.from('# Existing synthetic posting');
          const replacement = Buffer.from('# Different synthetic posting');
          const first = await __resolveApplicationExportDirectoryForTests(output, base, original);
          await fs.writeFile(path.join(first.dir, 'Original Job Listing.md'), original);
          const second = await __resolveApplicationExportDirectoryForTests(output, base, replacement);
          const suffix = crypto.createHash('sha256').update(replacement).digest('hex').slice(0, 8);
          assert.notEqual(first.dir, second.dir);
          assert(path.basename(second.dir).endsWith(` (${suffix})`));
          assert(Buffer.byteLength(path.basename(second.dir)) <= APPLICATION_BUNDLE_PART_MAX_BYTES);
          assert.deepEqual(await fs.readFile(path.join(first.dir, 'Original Job Listing.md')), original);
          assert((await fs.stat(second.dir)).isDirectory());
        }
        assert.equal(sanitizeApplicationBundlePart('A'.repeat(150), 'Role'), 'A'.repeat(100),
          'existing ASCII names keep their established cap');
        for (const count of [81, 85]) {
          const legacyName = '職'.repeat(count);
          assert.equal(sanitizeApplicationBundlePart(legacyName, 'Role'), legacyName,
            'previously writable Unicode names keep their existing directory identity');
        }
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'posting variants preserve case-sensitive paths queries and fragments while deduplicating host casing',
    run() {
      const urls = [
        'https://JOBS.example.test/Role',
        'https://jobs.example.test/Role',
        'https://jobs.example.test/role',
        'https://jobs.example.test/job?id=AbC',
        'https://jobs.example.test/job?id=abc',
        'https://jobs.example.test/jobs#/Role',
        'https://jobs.example.test/jobs#/role',
      ];
      const variants = normaliseJobPostingVariants(urls.map(url => ({ url, location: 'Example City' })));
      assert.deepEqual(variants.map(row => row.url), urls.slice(1));
      const markdown = formatOriginalJobListingMarkdown({ postingVariants: variants });
      for (const variant of variants) assert(markdown.includes(`<${variant.url}>`));
    },
  },
  {
    name: 'listing Markdown handles many backtick runs without a spread-argument crash or altered source',
    run() {
      const description = `${'`x'.repeat(150_000)}\n${'`'.repeat(40)}\nsynthetic source`;
      const markdown = formatOriginalJobListingMarkdown({ description });
      const fence = '`'.repeat(41);
      assert(markdown.includes(`${fence}text\n${description}\n${fence}`));
    },
  },
];
