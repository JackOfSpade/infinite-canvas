import { isProductImageFile } from './fileDropUtils.js';
import { isCareerTextFileName } from './careerTextFiles.js';
import {
  canSellHubAcceptDisplayPhotoDrop,
  getHubDropRejectLabel,
} from './hubDropEligibility.js';
import { jobBoardCareerDropVerdict } from './jobBoardCareerOverride.js';

export function filePayloadFromDraggedNodes(nodes) {
  return (nodes || [])
    .filter(n => n?.type === 'document' && typeof n.data?.filePath === 'string' && n.data.filePath.trim())
    .map(n => ({
      nodeId: n.id,
      filePath: n.data.filePath,
      filename: n.data.filename || n.data.filePath.split(/[\\/]/).pop() || 'file',
    }));
}

// Display names are editable and native paths sometimes carry a harmless
// trailing separator/whitespace. Normalize only that suffix before checking
// the final extension; do not resolve or touch the filesystem here.
export function isAppBundlePathOrName(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replace(/[\\/]+$/, '');
  return /\.app$/i.test(normalized);
}

export function fileSupportedByHub(hubType, file) {
  // A DocumentNode display name is editable and may be stale. Treat an app
  // bundle as unsupported when either visible name OR actual path says .app;
  // accepting a disguised bundle here would bypass the same policy enforced by
  // Job Search's final admission filter.
  const names = [file?.filename, file?.filePath].filter(value => typeof value === 'string');
  // Career data is plain text only: the real path must be .txt or .md.
  // A Job Board's career override uses the identical career-text rule.
  if (hubType === 'jobhub' || hubType === 'jobboard') {
    return !names.some(isAppBundlePathOrName) && isCareerTextFileName(file?.filePath);
  }
  if (hubType === 'sellhub') return isProductImageFile(file);
  return false;
}

export function buildHubHoverState(targetHub, dragSet) {
  if (!targetHub) return null;
  if (targetHub.data?.locked) {
    return { kind: 'reject', label: 'Locked' };
  }

  const filePayload = filePayloadFromDraggedNodes(dragSet);
  if (filePayload.length === 0) {
    const draggedJobBoard = (dragSet || []).some(node => node?.type === 'jobboard');
    return {
      kind: 'reject',
      label: targetHub.type === 'jobhub' && draggedJobBoard
        ? 'Drop a career file instead'
        : 'Unsupported component',
    };
  }

  const acceptedFiles = filePayload.filter(file => fileSupportedByHub(targetHub.type, file));
  // A Job Board takes canvas career files as its career override: the whole
  // selection must be text, then the Board's own override lifecycle decides.
  if (targetHub.type === 'jobboard') {
    if (acceptedFiles.length !== filePayload.length) {
      return { kind: 'reject', label: 'Text files only (.txt, .md)' };
    }
    return jobBoardCareerDropVerdict(targetHub.data);
  }
  // Job Search refuses a whole drop that holds any non-text file, so the cue
  // must not promise "Use as resume" for a mixed selection.
  if (targetHub.type === 'jobhub' && acceptedFiles.length !== filePayload.length) {
    return { kind: 'reject', label: 'Text files only (.txt, .md)' };
  }
  if (acceptedFiles.length === 0) {
    return {
      kind: 'reject',
      label: targetHub.type === 'jobhub' ? 'Unsupported resume file' : 'Images only',
    };
  }

  if (canSellHubAcceptDisplayPhotoDrop(targetHub)) {
    return { kind: 'accept', label: 'Add display photos' };
  }

  const lockLabel = getHubDropRejectLabel(targetHub);
  if (lockLabel) {
    return { kind: 'reject', label: lockLabel };
  }

  return {
    kind: 'accept',
    label: targetHub.type === 'jobhub' ? 'Use as resume' : 'Use as photos',
  };
}
