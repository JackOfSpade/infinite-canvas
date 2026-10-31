import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electronPkg from 'electron';
import { assert } from './testHelpers.js';
import { writeApprovedCareerSnapshotFixture } from './careerSnapshotFixture.mjs';
import { careerSnapshotStorageRoot, readPinnedCareerSnapshot } from '../../electron/ipc/careerSnapshot.js';

export default [{
  name: 'interview snapshot read-only: real pinned reader preserves modes and rejects tampering and symlinks',
  run: async () => {
    const fixture = await writeApprovedCareerSnapshotFixture({ sourceName: 'Interview read-only fixture.md' });
    const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-snapshot-readonly-'));
    try {
      const root = careerSnapshotStorageRoot(temporary);
      await fs.promises.cp(careerSnapshotStorageRoot(electronPkg.app.getPath('userData')), root, { recursive: true });
      const snapshots = path.join(root, 'career-snapshots');
      const file = path.join(snapshots, `${fixture.snapshotId}.json`);
      const bytes = await fs.promises.readFile(file);
      await fs.promises.chmod(root, 0o750);
      await fs.promises.chmod(snapshots, 0o750);
      const before = await Promise.all([root, snapshots, file].map(name => fs.promises.stat(name)));
      const loaded = await readPinnedCareerSnapshot(root, fixture.snapshotId, { readOnly: true });
      assert(loaded?.profile.identity.name === 'Ada Lovelace', 'the read-only path must load and validate a real approved snapshot');
      const after = await Promise.all([root, snapshots, file].map(name => fs.promises.stat(name)));
      assert(before.every((stat, index) => stat.mode === after[index].mode && stat.mtimeMs === after[index].mtimeMs && stat.ctimeMs === after[index].ctimeMs), 'read-only snapshot reads must not change permissions, data or metadata');
      const corrupt = JSON.parse(bytes);
      corrupt.profile.achievements[0].claim = 'Invented achievement.';
      await fs.promises.writeFile(file, JSON.stringify(corrupt));
      assert(await readPinnedCareerSnapshot(root, fixture.snapshotId, { readOnly: true }) === null, 'read-only reads must retain real approval and evidence validation');
      await fs.promises.writeFile(file, bytes);
      const outside = path.join(temporary, 'outside.json');
      await fs.promises.writeFile(outside, bytes);
      await fs.promises.unlink(file);
      await fs.promises.symlink(outside, file);
      const rejectedFile = await readPinnedCareerSnapshot(root, fixture.snapshotId, { readOnly: true }).then(() => false, () => true);
      assert(rejectedFile, 'read-only reads must retain the trusted file symlink rejection');
      await fs.promises.rm(root, { recursive: true });
      const actual = path.join(temporary, 'actual-store');
      await fs.promises.mkdir(actual);
      await fs.promises.symlink(actual, root);
      const rejectedDirectory = await readPinnedCareerSnapshot(root, fixture.snapshotId, { readOnly: true }).then(() => false, () => true);
      assert(rejectedDirectory, 'read-only reads must retain the trusted directory symlink rejection');
      return { readOnly: true, tamperRejected: true, symlinksRejected: true };
    } finally {
      await fs.promises.rm(temporary, { recursive: true, force: true });
    }
  },
}];
