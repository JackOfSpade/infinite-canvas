import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Replace one complete application workspace as a transaction.
 *
 * `data: null` deliberately means "this artifact was not produced" and removes
 * an older sibling from a prior generation. All new bytes are staged before
 * any visible file changes. Existing files are then moved to same-directory
 * backups; if a promotion or readback check fails, every original is restored.
 * An entry may additionally supply `expectedCurrentData`; after its current
 * destination is moved aside, the backup must still match those bytes before
 * ANY promotion begins. This closes stale-read races for callers that first
 * render a derived artifact from an editable on-disk source.
 * This avoids both mixed-generation bundles and stale PDFs beside new HTML.
 */
export async function replaceApplicationBundleAtomically(entries, { fileOps = fs.promises, verify = null } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Application bundle replacement requires at least one destination.');
  }
  const transactionId = crypto.randomUUID();
  const normalized = entries.map((entry) => {
    if (!entry || typeof entry.destination !== 'string' || !entry.destination.trim()) {
      throw new Error('Every application bundle entry requires a destination path.');
    }
    const destination = path.resolve(entry.destination);
    const hasExpectedCurrentData = Object.prototype.hasOwnProperty.call(entry, 'expectedCurrentData');
    if (hasExpectedCurrentData && entry.expectedCurrentData == null) {
      throw new Error('Application bundle expected-current data must be bytes or text.');
    }
    return {
      destination,
      data: entry.data == null ? null : entry.data,
      expectedCurrentData: hasExpectedCurrentData ? Buffer.from(entry.expectedCurrentData) : null,
      hasExpectedCurrentData,
      temporary: path.join(path.dirname(destination), `.${path.basename(destination)}.${transactionId}.tmp`),
      backup: path.join(path.dirname(destination), `.${path.basename(destination)}.${transactionId}.bak`),
      hadOriginal: false,
      mode: 0o600,
      promoted: false,
      preserveBackup: false,
    };
  });
  const destinations = new Set();
  for (const entry of normalized) {
    if (destinations.has(entry.destination)) {
      throw new Error(`Application bundle contains a duplicate destination: ${entry.destination}`);
    }
    destinations.add(entry.destination);
  }
  try {
    for (const entry of normalized) {
      let destinationStat;
      try {
        destinationStat = await fileOps.lstat(entry.destination);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      entry.hadOriginal = Boolean(destinationStat);
      if (destinationStat && !destinationStat.isFile() && !destinationStat.isSymbolicLink()) {
        throw new Error(`Application bundle destination must be a regular file: ${entry.destination}`);
      }
      // A symbolic link is moved aside as an object and never followed. Do
      // not stat it for mode: that would inspect the link target and turn an
      // otherwise safe replacement into an unintended read outside the
      // application directory.
      if (destinationStat?.isFile()) {
        entry.mode = destinationStat.mode & 0o777;
      }
    }
    // Read/copy callers prepare every `data` value before this helper, so a
    // missing source cannot disturb the destination. Stage writes in
    // parallel, but wait for every attempt to settle rather than short-
    // circuiting on the first rejection: Promise.all would move on to the
    // catch/finally blocks while sibling writes are still in flight, and the
    // finally block's unlink-every-.tmp pass could then run before a slower
    // sibling's 'wx' open creates its file — leaving an orphaned hidden temp
    // file beside the saved application with nothing left to remove it.
    const staged = await Promise.allSettled(normalized.filter(entry => entry.data != null)
      .map(entry => fileOps.writeFile(entry.temporary, entry.data, { mode: entry.mode, flag: 'wx' })));
    const firstStagingFailure = staged.find(result => result.status === 'rejected');
    if (firstStagingFailure) throw firstStagingFailure.reason;

    for (const entry of normalized) {
      if (entry.hadOriginal) await fileOps.rename(entry.destination, entry.backup);
    }
    // The backup is the exact original object the transaction would otherwise
    // delete after success. Validate it only after the rename, not during an
    // earlier preflight: an external editor can save between those moments.
    // Run this before promoting any staged sibling so a mismatch has a simple
    // full rollback and can never leave a new PDF beside an old HTML.
    for (const entry of normalized) {
      if (!entry.hasExpectedCurrentData) continue;
      if (!entry.hadOriginal) {
        throw new Error(`Application bundle source disappeared before promotion: ${entry.destination}`);
      }
      const backupStat = await fileOps.lstat(entry.backup);
      if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
        throw new Error(`Application bundle source changed into an unsafe file before promotion: ${entry.destination}`);
      }
      const actual = await fileOps.readFile(entry.backup);
      if (!Buffer.from(actual).equals(entry.expectedCurrentData)) {
        throw new Error(`Application bundle source changed before promotion: ${entry.destination}`);
      }
    }
    for (const entry of normalized) {
      if (entry.data == null) continue;
      await fileOps.rename(entry.temporary, entry.destination);
      entry.promoted = true;
    }

    const verification = typeof verify === 'function' ? await verify() : null;
    await Promise.all(normalized.filter(entry => entry.hadOriginal)
      .map(entry => fileOps.unlink(entry.backup).catch(() => {})));
    return verification;
  } catch (error) {
    // Remove only the explicit destinations that this transaction promoted,
    // then put every prior sibling back in place.
    await Promise.all(normalized.filter(entry => entry.promoted)
      .map(entry => fileOps.unlink(entry.destination).catch(() => {})));
    for (const entry of normalized) {
      if (!entry.hadOriginal) continue;
      try { await fileOps.rename(entry.backup, entry.destination); }
      catch { entry.preserveBackup = true; }
    }
    throw error;
  } finally {
    // A backup that could not be restored is intentionally preserved for
    // manual recovery instead of being erased during cleanup.
    await Promise.all(normalized.flatMap(entry => entry.preserveBackup ? [entry.temporary] : [entry.temporary, entry.backup])
      .map(target => fileOps.unlink(target).catch(() => {})));
  }
}
