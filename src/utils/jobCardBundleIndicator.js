// Pure, side-effect-free indicator for an already-generated/saved Local AI
// application bundle. Kept free of React so it can be exercised in isolation.
//
// A bundle is only "saved" when the durable job pointer is fully settled:
//   localApplication.status === 'saved' && non-empty localApplication.id
// Anything else (queued, importing, failed, status-error, malformed, null,
// and so on) returns null so the card renders no at-a-glance indicator.

const SAVED_TITLE = 'An application bundle (résumé, cover letter, editable HTML) is already saved for this job.';

// The card shows a red X laid across it while a bundle is saved (see
// JobCardNode). `cross` is the colour class of that overlay; both tones are red
// so "saved" reads the same at a glance, while `title`/`label` still carry the
// attention detail for the accessible name.
export const APPLICATION_BUNDLE_TONES = Object.freeze({
  saved: Object.freeze({ cross: 'text-red-500/70' }),
  attention: Object.freeze({ cross: 'text-red-500/70' }),
});

export function applicationBundleIndicator(localApplication) {
  if (!localApplication || typeof localApplication !== 'object' || Array.isArray(localApplication)) return null;
  if (localApplication.status !== 'saved') return null;
  if (typeof localApplication.id !== 'string' || localApplication.id.length === 0) return null;

  if (Array.isArray(localApplication.missingArtifacts) && localApplication.missingArtifacts.length > 0) {
    const names = localApplication.missingArtifacts.map((name) => String(name ?? ''));
    const joined = names.join(' and ');
    return {
      tone: 'attention',
      label: 'Bundle saved · PDFs missing',
      title: `Application bundle saved, but ${joined} could not be rendered. Use Repair bundle on this card to retry.`,
    };
  }

  if (typeof localApplication.message === 'string' && /pages against its/.test(localApplication.message)) {
    return {
      tone: 'attention',
      label: 'Bundle saved · length warning',
      title: localApplication.message,
    };
  }

  const savedDir = typeof localApplication.savedDir === 'string' && localApplication.savedDir.length > 0
    ? localApplication.savedDir
    : '';
  return {
    tone: 'saved',
    label: 'Application ready',
    title: savedDir ? `${SAVED_TITLE} Folder: ${savedDir}` : SAVED_TITLE,
  };
}

export default applicationBundleIndicator;
