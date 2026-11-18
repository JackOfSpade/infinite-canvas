// Interview Helper only: the career drop accepts any file type. The canvas Job
// Search keeps its text-only rule in src/utils/careerTextFiles.js.
const baseName = path => String(path || '').split(/[\\/]/u).pop();
// .txt and .md are passed to the compile untouched (same path, same bytes).
export const isPassThroughCareerName = path => /\.(txt|md)$/iu.test(baseName(path));

const text = (value, limit) => typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : '';

/**
 * Pairs the dropped paths with the conversion reply (same order). Main answers
 * { files:[{ name, convertedName, filePath, status, method, reason, machineExtracted, token }] }
 * with status 'converted' | 'passthrough' | 'refused'. Returns { rows, good: [{ filePath }], refused }
 * or null when the reply is unusable.
 */
export function planCareerConversionResults(dropped, reply) {
  const files = reply?.files;
  if (!reply?.success || !Array.isArray(files) || files.length !== dropped.length) return null;
  const rows = []; const good = [];
  files.forEach((file, index) => {
    const name = text(file?.name, 180) || baseName(dropped[index]);
    const filePath = text(file?.filePath, 4096);
    if ((file?.status === 'converted' || file?.status === 'passthrough') && filePath) {
      good.push({ filePath });
      rows.push({ name, ok: true, convertedName: text(file.convertedName, 200) || name, method: file.machineExtracted === true ? 'machine_extracted' : file.status === 'passthrough' ? 'passthrough' : text(file.method, 60),
        note: text(file.reason, 400), token: text(file.token, 200) });
    } else rows.push({ name, ok: false, reason: text(file?.reason, 300) || 'This file could not be converted to text.' });
  });
  return { rows, good, refused: rows.length - good.length };
}
