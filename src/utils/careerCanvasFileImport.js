import { filePayloadFromDraggedNodes, fileSupportedByHub } from './hubNodeDrop.js';

// These small pure helpers keep the accessible picker testable without a
// ReactFlow/Electron runtime. A consent selection is deliberately a pair: an
// existing canvas card can keep its id while being relinked to a new path.
export function canvasCareerImportCandidates(nodes) {
  return filePayloadFromDraggedNodes(nodes).filter((file) => fileSupportedByHub('jobhub', file));
}

export function sameCareerCanvasFileSelection(selection, file) {
  return selection?.nodeId === file?.nodeId && selection?.filePath === file?.filePath;
}

export function toggleCareerCanvasFileSelection(selections, file) {
  if (!file?.nodeId || !file?.filePath) return Array.isArray(selections) ? selections : [];
  const current = Array.isArray(selections) ? selections : [];
  if (current.some((selection) => sameCareerCanvasFileSelection(selection, file))) {
    return current.filter((selection) => !sameCareerCanvasFileSelection(selection, file));
  }
  return [
    ...current.filter((selection) => selection.nodeId !== file.nodeId),
    { nodeId: file.nodeId, filePath: file.filePath },
  ];
}

export function reconcileCareerCanvasFileSelections(selections, files) {
  const current = Array.isArray(selections) ? selections : [];
  const available = Array.isArray(files) ? files : [];
  return current.filter((selection) => available.some((file) => sameCareerCanvasFileSelection(selection, file)));
}

export function selectedCareerCanvasFiles(files, selections) {
  const available = Array.isArray(files) ? files : [];
  const current = Array.isArray(selections) ? selections : [];
  return available.filter((file) => current.some((selection) => sameCareerCanvasFileSelection(selection, file)));
}

// Use strict true so a missing/undefined reply from a future ingress cannot
// close the chooser as though it had acquired the one-shot import generation.
export function careerCanvasImportAdmissionSucceeded(result) {
  return result === true;
}
