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
 * This avoids both mixed-generation bundles and stale PDFs beside new HTML.
 */
export async function replaceApplicationBundleAtomically(entries, { fileOps = fs.promises, verify = null } = {}) {
  const transactionId = crypto.randomUUID();
  const normalized = entries.map(entry => ({
    destination: path.resolve(entry.destination),
    data: entry.data == null ? null : entry.data,
    temporary: path.join(path.dirname(entry.destination), `.${path.basename(entry.destination)}.${transactionId}.tmp`),
    backup: path.join(path.dirname(entry.destination), `.${path.basename(entry.destination)}.${transactionId}.bak`),
    hadOriginal: false,
    promoted: false,
    preserveBackup: false,
  }));
  const exists = async (target) => {
    try { await fileOps.access(target); return true; }
    catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  };

  try {
    // Read/copy callers prepare every `data` value before this helper, so a
    // missing source cannot disturb the destination. Stage writes in parallel.
    await Promise.all(normalized.filter(entry => entry.data != null)
      .map(entry => fileOps.writeFile(entry.temporary, entry.data)));

    for (const entry of normalized) {
      entry.hadOriginal = await exists(entry.destination);
      if (entry.hadOriginal) await fileOps.rename(entry.destination, entry.backup);
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
