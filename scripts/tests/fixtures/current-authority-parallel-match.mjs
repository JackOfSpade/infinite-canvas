// Synthetic-only fixture for the bridge's current-authority match queue.
// Twenty-one short source units make twenty-one requirement receipt pages;
// the small approved snapshot stays a single catalog page, yielding exactly
// 21 deterministic requirement×catalog pairs without any production data.
//
// `longListing: true` instead produces a 151-unit listing page (three fixed
// 64-unit audit windows: [0,64), [64,128), [128,151)) with six synthetic
// requirements at known unit indexes, so audit carry-forward and discovery
// prefix carry can be exercised.  Sentences are joined without separators
// because the host splits units after '.', so each sentence is exactly one
// unit; the host-rendered title/company header occupies the first
// LONG_LISTING_HEADER_UNITS units.  `unitTexts[i]` is the text of absolute
// unit i (null for header units) and `requirementUnitIndexes[k]` is the
// absolute unit index of `requirements[k]`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeApprovedCareerSnapshotFixture } from '../careerSnapshotFixture.mjs';

// The host-rendered header is nine units and a short host trailer follows the
// snippet, so the listing page holds LONG_LISTING_UNIT_COUNT + 2 units and
// its final audit window is [128,151).
export const LONG_LISTING_HEADER_UNITS = 9;
export const LONG_LISTING_UNIT_COUNT = 149;
export const LONG_LISTING_REQUIREMENT_UNITS = Object.freeze([12, 40, 70, 100, 130, 148]);

export function longListingFillerText(unitIndex) {
  return `Synthetic overview line ${String(unitIndex).padStart(3, '0')} adds context.`;
}

export async function makeCurrentAuthorityParallelMatchFixture({
  trailingCoverageOnlyUnit = false,
  coverageOnlyPrefix = false,
  coverageOnlyAfterRequirementIndex = null,
  coverageOnlyAfterEveryRequirement = false,
  extraAchievementCount = 0,
  longListing = false,
} = {}) {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'current-authority-parallel-match-')));
  const canvasFilePath = path.join(root, 'Synthetic Canvas.json');
  await fs.promises.writeFile(canvasFilePath, '{"version":1}', 'utf8');
  const snapshot = await writeApprovedCareerSnapshotFixture({
    sourceName: extraAchievementCount ? `Synthetic Parallel Match catalog-${extraAchievementCount}.md` : 'Synthetic Parallel Match.md',
    extraAchievementCount,
  });
  if (longListing) {
    const requirements = LONG_LISTING_REQUIREMENT_UNITS.map((_unit, index) => `Synthetic capability ${String(index + 1).padStart(2, '0')} is required.`);
    const unitTexts = Array.from({ length: LONG_LISTING_UNIT_COUNT }, (_unused, unitIndex) => {
      if (unitIndex < LONG_LISTING_HEADER_UNITS) return null;
      const requirementIndex = LONG_LISTING_REQUIREMENT_UNITS.indexOf(unitIndex);
      return requirementIndex >= 0 ? requirements[requirementIndex] : longListingFillerText(unitIndex);
    });
    return {
      root,
      canvasFilePath,
      snapshotId: snapshot.snapshotId,
      requirements,
      requirementUnitIndexes: [...LONG_LISTING_REQUIREMENT_UNITS],
      unitTexts,
      headerUnitCount: LONG_LISTING_HEADER_UNITS,
      longListing: true,
      job: { title: 'Synthetic Parallel Match Engineer', company: 'Example Systems', snippet: unitTexts.slice(LONG_LISTING_HEADER_UNITS).join('') },
      trailingCoverageOnlyUnit: false, coverageOnlyPrefix: false, coverageOnlyAfterRequirementIndex: null, coverageOnlyAfterEveryRequirement: false,
    };
  }
  const requirements = Array.from({ length: 21 }, (_unused, index) => `Synthetic capability ${String(index + 1).padStart(2, '0')} is required.`);
  return {
    root,
    canvasFilePath,
    snapshotId: snapshot.snapshotId,
    requirements,
    job: {
      title: 'Synthetic Parallel Match Engineer',
      company: 'Example Systems',
      snippet: [
        ...(coverageOnlyPrefix ? ['Synthetic opening overview; no requirement.'] : []),
        ...requirements.flatMap((requirement, index) => [
          requirement,
          ...(coverageOnlyAfterEveryRequirement || coverageOnlyAfterRequirementIndex === index ? ['Synthetic mid-list overview; no requirement.'] : []),
        ]),
        ...(trailingCoverageOnlyUnit ? ['Synthetic company overview; no additional requirement.'] : []),
      ].join('\n'),
    },
    trailingCoverageOnlyUnit, coverageOnlyPrefix, coverageOnlyAfterRequirementIndex, coverageOnlyAfterEveryRequirement,
  };
}
