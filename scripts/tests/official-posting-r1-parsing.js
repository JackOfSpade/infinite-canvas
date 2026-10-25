import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { walkJsonLdJobPostings } from '../../electron/extractors/jobPostingJsonLd.js';
import { OFFICIAL_FETCH_MAX_BYTES } from '../../electron/ipc/officialPostingFetch.js';
import { freeOfficialPostingLeads } from '../../electron/ipc/officialPostingResolver.js';

const posting = extra => ({ '@type': ['Thing', 'https://schema.org/JobPosting'], title: 'Dispatch Engineer',
  hiringOrganization: [{ name: 'Northwind Labs', sameAs: ['https://northwind.example', 12] }],
  jobLocation: { address: { addressLocality: 'Lakeview' } }, baseSalary: { currency: 'CAD' }, identifier: 'dispatch-1',
  validThrough: '2050-12-31', description: 'Maintain dispatch rosters for freight routes.',
  url: 'https://northwind.example/jobs/dispatch-1', jobLocationType: 'TELECOMMUTE',
  applicantLocationRequirements: { name: 'Canada' }, ...extra });
const script = value => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

export default [
  {
    name: 'R1 JSON-LD scanning bounds three-megabyte malformed opening and closing tags below 200 ms',
    run() {
      walkJsonLdJobPostings(script(posting()));
      const atFetchCap = (prefix, repeat) => prefix + repeat.repeat(Math.ceil((OFFICIAL_FETCH_MAX_BYTES - prefix.length) / repeat.length))
        .slice(0, OFFICIAL_FETCH_MAX_BYTES - prefix.length);
      const sizes = [
        atFetchCap('', '<script '),
        atFetchCap('<script type="application/ld+json">', '</script '),
        atFetchCap('<script type="application/ld+json" data-open="', '<script '),
      ];
      const elapsed = sizes.map(html => {
        assert.equal(Buffer.byteLength(html), OFFICIAL_FETCH_MAX_BYTES);
        const start = performance.now();
        assert.deepEqual(walkJsonLdJobPostings(html), []);
        const ms = performance.now() - start;
        assert.ok(ms < 200, `three-megabyte malformed input took ${ms.toFixed(1)} ms`);
        return Number(ms.toFixed(1));
      });
      return { malformedBytes: OFFICIAL_FETCH_MAX_BYTES, elapsedMs: elapsed };
    },
  },
  {
    name: 'R1 JSON-LD scanning preserves MIME attributes, normalized fields and raw visitor short circuits',
    run() {
      const first = posting(); const second = posting({ title: 'Release Engineer' });
      const html = `<script type="application/ld+json">not JSON</script><SCRIPT data-test='>' data-type="text/plain" TYPE = 'APPLICATION/LD+JSON; charset=utf-8'>${JSON.stringify({ '@graph': [first, { mainEntity: second }] })}</SCRIPT >`;
      const found = walkJsonLdJobPostings(html);
      assert.equal(found.length, 2);
      assert.deepEqual(found[0], { title: first.title, hiringOrganization: { name: 'Northwind Labs', sameAs: ['https://northwind.example'] },
        jobLocation: first.jobLocation, baseSalary: first.baseSalary, identifier: first.identifier, validThrough: first.validThrough,
        description: first.description, url: first.url, jobLocationType: first.jobLocationType,
        applicantLocationRequirements: first.applicantLocationRequirements });
      assert.equal(found[1].title, second.title);
      for (const result of [false, 0, null, 'first']) {
        let calls = 0;
        assert.equal(walkJsonLdJobPostings(html, raw => { calls += 1; assert.deepEqual(raw, first); return result; }), result);
        assert.equal(calls, 1);
      }
      const seen = [];
      assert.equal(walkJsonLdJobPostings(html, raw => { seen.push(raw.title); }), undefined);
      assert.deepEqual(seen, [first.title, second.title]);
      assert.deepEqual(walkJsonLdJobPostings(`<script data-type="application/ld+json" type="text/plain">${JSON.stringify(first)}</script>`), []);
      assert.equal(walkJsonLdJobPostings(`<script type=application/ld+json>${JSON.stringify(first)}</script>`)[0].title, first.title);
    },
  },
  {
    name: 'R1 JSON-LD arrays above the call-argument limit remain traversable without spreading',
    run() {
      const large = Array.from({ length: 160_000 }, () => null);
      large.push({ mainEntity: posting() });
      assert.equal(walkJsonLdJobPostings(script(large))[0].title, 'Dispatch Engineer');
    },
  },
  {
    name: 'R1 free URL leads cap tokens before bounded punctuation removal without synthesizing clipped URLs',
    run() {
      const href = 'https://northwind.example/jobs/dispatch-1';
      assert.deepEqual(freeOfficialPostingLeads({ snippet: `Read ${href}),.; and ${href}.` }), [href]);
      const oversizedPath = `${href}/${'a'.repeat(2100)}`;
      const start = performance.now();
      assert.deepEqual(freeOfficialPostingLeads({ snippet: `${href}${','.repeat(3_000_000)} ${oversizedPath}` }), []);
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 200, `overlong URL tokens took ${elapsed.toFixed(1)} ms`);
      assert.deepEqual(freeOfficialPostingLeads({ snippet: `${oversizedPath} ${href};`, url: href }), [href]);
      return { overlongTokenMs: Number(elapsed.toFixed(1)) };
    },
  },
];
