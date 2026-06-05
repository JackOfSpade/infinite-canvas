import { PRODUCT_IMAGE_EXT_RE } from './fileExtensions.js';
import { normalizePhotoPathList } from './photoPathList.js';

function toFileArray(files) {
  if (!files) return [];
  return Array.isArray(files) ? files : Array.from(files);
}

function defaultPathResolver(file) {
  return globalThis.window?.electronAPI?.getPathForFile?.(file) || '';
}

export function getLocalFilePath(file, pathResolver = defaultPathResolver) {
  if (!file) return '';
  const directPath = file.path || file.filePath || '';
  if (typeof directPath === 'string' && directPath.trim()) return directPath.trim();

  try {
    const resolved = pathResolver?.(file) || '';
    return typeof resolved === 'string' ? resolved.trim() : '';
  } catch {
    return '';
  }
}

export function getFileDisplayName(file, pathResolver = defaultPathResolver) {
  const name = file?.name || file?.filename || '';
  if (typeof name === 'string' && name.trim()) return name.trim();
  const path = getLocalFilePath(file, pathResolver);
  return path.split(/[\\/]/).pop() || '';
}

export function summarizeFileExtensions(files) {
  return toFileArray(files).map(file => {
    const name = file?.name || file?.filename || file?.filePath || file?.path || '';
    return (String(name).match(/\.[a-z0-9]+$/i)?.[0] || '?').toLowerCase();
  });
}

export function filesToDropPayloads(files, pathResolver = defaultPathResolver) {
  return toFileArray(files)
    .map(file => {
      const path = getLocalFilePath(file, pathResolver);
      return {
        name: getFileDisplayName(file, () => path),
        type: file?.type || '',
        size: file?.size || 0,
        path,
      };
    })
    .filter(file => file.path);
}

function hasProductImageExtension(file, path) {
  const candidates = [
    file?.name,
    file?.filename,
    file?.filePath,
    file?.path,
    path,
  ];
  return candidates.some(value => (
    typeof value === 'string' && PRODUCT_IMAGE_EXT_RE.test(value)
  ));
}

export function isProductImageFile(file, pathResolver = defaultPathResolver) {
  return hasProductImageExtension(file, getLocalFilePath(file, pathResolver));
}

export function filesToProductImagePaths(files, pathResolver = defaultPathResolver) {
  return normalizePhotoPathList(
    toFileArray(files)
      .map(file => ({ file, path: getLocalFilePath(file, pathResolver) }))
      .filter(({ file, path }) => path && hasProductImageExtension(file, path))
      .map(({ path }) => path)
  );
}
