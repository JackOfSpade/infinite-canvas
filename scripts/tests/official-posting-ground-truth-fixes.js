import assert from 'node:assert/strict';
import { officialPostingLookupStatus } from '../../electron/ipc/officialPostingFields.js';
import { extractOfficialPostingVendorCandidates, officialPostingVendorAdapterUrl, officialPostingVendorRoute } from '../../electron/ipc/officialPostingVendorAdapters.js';
import { retainedRecheckTrail } from '../../electron/ipc/officialPostingRefresh.js';

const description = 'Requirements include experience building reliable services and maintaining reporting workflows. Engineers design clear interfaces for dispatch teams and validate operational changes with careful review. The role includes improving data quality across scheduled pipelines and documenting decisions for partner teams. You will work with colleagues to investigate delivery failures and make service behavior understandable. Responsibilities include writing tests for new features and improving the tools used by support teams every day.';

export default [
  {
    name: 'Gem board roots read the public board listing, and only posts naming their own page on that board are kept',
    run() {
      const listing = 'https://api.gem.com/job_board/v0/northwind/job_posts/';
      assert.deepEqual(officialPostingVendorRoute(listing), { ats: 'gem', tenant: 'northwind' });
      assert.equal(officialPostingVendorRoute(`${listing}?board=other`), null);
      assert.equal(officialPostingVendorAdapterUrl({ ats: 'gem', tenant: 'northwind' }, 'https://jobs.gem.com/northwind'), listing);
      const id = '8607b6ab-5488-41f4-a82b-58636df788f6'; const other = '11111111-2222-3333-4444-555555555555';
      const body = JSON.stringify([
        { id, absolute_url: `https://jobs.gem.com/northwind/${id}`, title: 'Software Engineer', content_plain: description,
          requisition_id: '2359', location: { name: 'Lakeview, Canada' }, location_type: 'hybrid', offices: [{ location: { name: 'Lakeview, Canada' } }] },
        { id: other, absolute_url: `https://jobs.gem.com/someone-else/${other}`, title: 'Software Engineer', content_plain: description },
        { id: other, absolute_url: `https://jobs.gem.com/northwind/${id}`, title: 'Software Engineer', content_plain: description },
      ]);
      const found = extractOfficialPostingVendorCandidates({ body, sourceUrl: listing, employer: 'Northwind Labs' });
      assert.equal(found.length, 1);
      assert.equal(found[0].sourceUrl, `https://jobs.gem.com/northwind/${id}`);
      assert.equal(found[0].identifier, '2359');
      assert.equal(found[0].location.display, 'Lakeview, Canada');
      assert.equal(found[0].employer, 'Northwind Labs');
    },
  },
  {
    name: 'A failed recheck keeps the verified record\'s proof codes but reports the latest run\'s own reason',
    run() {
      const prior = { level: 'L2', outcome: 'found', employer: 'Northwind Labs', sourceUrl: 'https://job-boards.greenhouse.io/northwind/jobs/1',
        officialApplyUrl: 'https://job-boards.greenhouse.io/northwind/jobs/1',
        trail: ['domain-proof', 'crawl-partial', 'crawl-budget', 'comparative-match', 'semantic-match-v1', 'reverify-failed', 'semantic-uncertain'] };
      for (const [codes, label] of [[['comparative-a-p1', 'comparative-b-p1', 'official-liveness-unconfirmed'], 'Official posting match uncertain'],
        [['comparative-a-p3', 'comparative-b-p1', 'semantic-uncertain'], 'Official posting match uncertain'],
        [['crawl-budget', 'source-unproven'], 'Employer source verification incomplete']]) {
        const trail = retainedRecheckTrail(prior, { level: 'L5', outcome: 'ambiguous', trail: codes });
        assert.equal(trail.at(-1), 'reverify-failed');
        for (const kept of ['domain-proof', 'comparative-match', 'semantic-match-v1', ...codes]) assert.ok(trail.includes(kept), kept);
        assert.equal(trail.filter(code => code === 'reverify-failed').length, 1);
        if (!codes.includes('crawl-budget')) assert.ok(!trail.includes('crawl-partial') && !trail.includes('crawl-budget'));
        const status = officialPostingLookupStatus({ ...prior, trail });
        assert.equal(status.label, 'Previously verified official posting');
        assert.ok(status.detail.startsWith(`Latest recheck: ${label}.`), status.detail);
      }
    },
  },
];
