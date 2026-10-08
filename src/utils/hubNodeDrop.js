import { isProductImageFile } from './fileDropUtils.js';
import {
  canSellHubAcceptDisplayPhotoDrop,
  getHubDropRejectLabel,
} from './hubDropEligibility.js';

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
  if (hubType === 'jobhub') return !names.some(isAppBundlePathOrName);
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
