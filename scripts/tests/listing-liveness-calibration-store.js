import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { __runWithIpcRequestContextForTests } from '../../electron/ipc/ipcUtils.js';
import { createListingLivenessSearchSession } from '../../electron/ipc/listingLivenessSearch.js';
import { createListingLivenessCalibrationStore } from '../../electron/ipc/listingLivenessCalibration.js';
import { recordListingEvidence } from '../../electron/ipc/listingLivenessStore.js';

export default [{
  name: 'real search-time liveness answer writes the injected calibration file with counts only',
  async run() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'synthetic-listing-calibration-'));
    try {
      const store = createListingLivenessCalibrationStore(root);
      const row = { source: 'linkedin', jobkey: 'synthetic-calibration-one',
        url: 'https://www.linkedin.com/jobs/view/synthetic-calibration-one',
        title: 'Synthetic Platform Engineer', company: 'Example Works', location: 'Remote',
        listingLiveness: { verdict: 'pending', basis: 'neither', board: 'linkedin', at: '2026-10-26T12:00:00.000Z' } };
      const evidence = { board: 'linkedin', ruleKey: 'linkedin', requestedUrl: row.url, finalUrl: row.url,
        expectedTitle: row.title, expectedCompany: row.company, expectedLocation: row.location,
        title: row.title, h1: row.title,
        chromeText: 'Applications are open for this synthetic position. The team describes its interview process and responsibilities.',
        descriptionText: 'Build synthetic platform services.', descriptionIsPage: false,
        closedHits: [], openSignals: [{ ruleId: 'linkedin-enabled-apply', state: 'shadow' }],
        jsonLd: { validThrough: '', isListed: null }, redirectedAway: false, titleMatchesPage: true, httpStatus: 200 };
      await __runWithIpcRequestContextForTests({ livenessEvidence: new Map() }, async () => {
        assert.equal(recordListingEvidence(row, evidence), true);
        const session = createListingLivenessSearchSession({ calibrationStore: store,
          bridgeStatus: () => ({ enabled: true, link: { state: 'linked' }, chat: { pool: { active: false } } }),
          now: () => Date.parse('2026-10-26T12:00:00Z'),
          callText: async (_prompt, options) => options.responseValidator({ rows: [
            { id: 'r1', verdict: 'open', quote: 'Applications are open for this synthetic position.' },
          ] }),
        });
        assert.equal((await session.classifyPrimary([row]))[0].listingLiveness.verdict, 'open');
      });
      const raw = await fs.readFile(store.file, 'utf8');
      const saved = JSON.parse(raw);
      assert.equal(saved.boards.linkedin.aiCheckedPages, 1);
      assert.equal(saved.boards.linkedin.rules['linkedin-enabled-apply'].firedAndAiOpen, 1);
      assert.equal(saved.boards.linkedin.rules['linkedin-enabled-apply'].state, 'shadow');
      for (const forbidden of [row.jobkey, row.url, row.title, row.company, evidence.chromeText]) {
        assert.equal(raw.includes(forbidden), false, 'the calibration file stores neither page evidence nor identity');
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
}];
