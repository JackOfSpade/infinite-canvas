import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCurrentSnapshotResolutionSelfTest } from '../acceptance/currentCareerSnapshotResolver.mjs';
import { deferOwnedBridgeLaneCleanup } from '../acceptance/bridgeLaneCleanup.mjs';
import { projectSavedJobCardForAcceptanceHarness } from '../../.test-artifacts/blackbox-run/application-acceptance-harness.mjs';
import { assert } from './testHelpers.js';

export default [
  {
    name: 'one-card live acceptance resolves only the deterministic current career snapshot',
    run: async () => {
      const result = await runCurrentSnapshotResolutionSelfTest();
      assert(result.currentAddressOnly && result.rejectsHistoricalFallback && result.rejectsSourceMismatch && result.rejectsAmbiguousSourceSet && result.snapshotCas
        && result.captureMutationCas && result.captureCtimeCas && result.snapshotCtimeCas && result.captureSymlinkCas,
        'current career snapshot resolver proof did not cover the required fail-closed cases');
      return result;
    },
  },
  {
    name: 'one-card live acceptance freezes the selected card listing rather than only its identity',
    run: () => {
      const selected = {
        title: 'Role', company: 'Company', snippet: 'A complete saved listing body with specific requirements.',
        location: 'Remote', source: 'saved-board', postingVariants: [],
      };
      const projected = projectSavedJobCardForAcceptanceHarness(selected);
      assert(projected.snippet === selected.snippet && projected.title === selected.title && projected.company === selected.company,
        'one-card acceptance must project the selected card’s actual listing body into the frozen queue input');
      assert(!Object.hasOwn(projected, 'description'), 'one-card projection must use the same card payload contract as production queueing, not an unobserved alternate field');
      return { selectedListingBodyPreserved: true };
    },
  },
  {
    name: 'one-card live acceptance never rewrites a bridge lane after a concurrent parent swap',
    run: () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bridge-lane-cleanup-'));
      try {
        const userData = path.join(root, 'user-data');
        const bridge = path.join(userData, 'handoff-bridge');
        const outside = path.join(root, 'outside-bridge');
        fs.mkdirSync(bridge, { recursive: true, mode: 0o700 });
        fs.mkdirSync(outside, { mode: 0o700 });
        const laneFile = path.join(bridge, 'lanes.json');
        const outsideFile = path.join(outside, 'lanes.json');
        const before = Buffer.from('{"v":1,"lanes":[{"jobId":"unrelated"}]}\n');
        const concurrent = Buffer.from('{"v":1,"lanes":[{"jobId":"owned"},{"jobId":"concurrent"}]}\n');
        fs.writeFileSync(laneFile, before, { mode: 0o600 });
        fs.writeFileSync(outsideFile, before, { mode: 0o600 });
        const moved = `${bridge}.moved`;
        const result = deferOwnedBridgeLaneCleanup({
          jobId: '12345678-1234-1234-1234-123456789abc',
          canvasFilePath: '/tmp/isolated-canvas.json',
          afterValidationForTest: () => {
            fs.writeFileSync(laneFile, concurrent, { mode: 0o600 });
            fs.renameSync(bridge, moved);
            fs.symlinkSync(outside, bridge);
          },
        });
        assert(result.deferred && !result.removed, 'stopped harness must defer lane cleanup to the live bridge owner');
        assert(fs.readFileSync(outsideFile).equals(before), 'parent swap must not redirect a bridge lane write outside user-data');
        assert(fs.readFileSync(path.join(moved, 'lanes.json')).equals(concurrent), 'post-validation concurrent lane change must survive cleanup');
        assert(fs.lstatSync(bridge).isSymbolicLink(), 'the harness must not traverse or replace the swapped bridge parent');
        return { deferred: true, parentSwapNoWrite: true, concurrentUpdatePreserved: true };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
];
