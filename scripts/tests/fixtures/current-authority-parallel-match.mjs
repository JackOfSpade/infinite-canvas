// Synthetic-only fixture for the bridge's current-authority match queue.
// Twenty-one short source units make twenty-one requirement receipt pages;
// the small approved snapshot stays a single catalog page, yielding exactly
// 21 deterministic requirement×catalog pairs without any production data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeApprovedCareerSnapshotFixture } from '../careerSnapshotFixture.mjs';

export async function makeCurrentAuthorityParallelMatchFixture() {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'current-authority-parallel-match-')));
  const canvasFilePath = path.join(root, 'Synthetic Canvas.json');
  await fs.promises.writeFile(canvasFilePath, '{"version":1}', 'utf8');
  const snapshot = await writeApprovedCareerSnapshotFixture({ sourceName: 'Synthetic Parallel Match.md' });
  const requirements = Array.from({ length: 21 }, (_unused, index) => `Synthetic capability ${String(index + 1).padStart(2, '0')} is required.`);
  return {
    root,
    canvasFilePath,
    snapshotId: snapshot.snapshotId,
    requirements,
    job: {
      title: 'Synthetic Parallel Match Engineer',
      company: 'Example Systems',
      snippet: requirements.join('\n'),
    },
  };
}
