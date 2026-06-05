export function normalizePhotoPathList(paths) {
  return [...new Set(
    (Array.isArray(paths) ? paths : [])
      .map(p => typeof p === 'string' ? p.trim() : '')
      .filter(Boolean)
  )];
}

export function appendPhotoPaths(existing, additions) {
  return normalizePhotoPathList([
    ...normalizePhotoPathList(existing),
    ...normalizePhotoPathList(additions),
  ]);
}

export function appendPhotoFiles(existing, files) {
  const before = normalizePhotoPathList(existing);
  const incomingPaths = (Array.isArray(files) ? files : [])
    .map(file => file?.filePath || file?.path || '')
    .filter(path => typeof path === 'string' && path.trim());
  const imagePaths = appendPhotoPaths(before, incomingPaths);
  return {
    imagePaths,
    accepted: normalizePhotoPathList(incomingPaths).length,
    added: imagePaths.length - before.length,
  };
}

export function removePhotoPathAt(paths, index) {
  const list = normalizePhotoPathList(paths);
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return list;
  return list.filter((_, i) => i !== index);
}
