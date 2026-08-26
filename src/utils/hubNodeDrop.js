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

export function fileSupportedByHub(hubType, file) {
  const name = file?.filename || file?.filePath || '';
  if (hubType === 'jobhub') return !/\.app$/i.test(name);
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
