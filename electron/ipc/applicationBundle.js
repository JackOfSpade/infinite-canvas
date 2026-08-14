/**
 * Portable application-artifact bundles.
 *
 * A generated résumé is deliberately HTML-first, but handing a recruiter (or
 * future-you) several unrelated downloads makes it too easy to lose the source
 * listing or the editable file. This module writes a standards-compliant ZIP
 * without another runtime dependency so the Electron main process, the test
 * runner, and packaged builds all agree on the archive layout.
 */
import zlib from 'node:zlib';

const UTF8_FLAG = 0x0800;
const DEFLATE_METHOD = 8;
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export function sanitizeApplicationBundlePart(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[\s\S]/g, char => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ? ' ' : char)
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .trim();
  const capped = [...cleaned].slice(0, 100).join('').replace(/[. ]+$/g, '').trim();
  if (!capped || capped === '.' || capped === '..') return fallback;
  const stem = capped.split('.')[0].toUpperCase();
  return WINDOWS_RESERVED_NAMES.has(stem) ? fallback : capped;
}

function dosDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = Math.max(1980, Math.min(2107, safe.getFullYear()));
  return {
    time: ((safe.getHours() & 0x1f) << 11) | ((safe.getMinutes() & 0x3f) << 5) | Math.floor(safe.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((safe.getMonth() + 1) << 5) | safe.getDate(),
  };
}

// Small table-based CRC32 implementation. ZIP stores a checksum of the
// uncompressed bytes and Node's standard library intentionally does not expose
// one; keeping it here avoids an archiver dependency solely for four files.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let bit = 0; bit < 8; bit += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function assertArchivePath(name) {
  const value = String(name || '').replace(/\\/g, '/');
  const unsafe = !value || value.startsWith('/') || value.includes('\u0000') || value.split('/').some((part) => {
    const stem = part.split('.')[0].toUpperCase();
    return !part || part === '.' || part === '..' || WINDOWS_RESERVED_NAMES.has(stem);
  });
  if (unsafe) {
    throw new Error(`Unsafe ZIP entry name: ${JSON.stringify(name)}`);
  }
  return value;
}

/**
 * Build a compact, standards-compliant ZIP in memory.
 *
 * Entries are intentionally files only: the company directory is expressed by
 * their shared prefix, which every ZIP reader presents as a directory while
 * avoiding a redundant empty-directory record.
 */
export function createZipBuffer(entries, { modifiedAt = new Date() } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('A ZIP bundle needs at least one file.');
  const { time, date } = dosDateTime(modifiedAt);
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;

  for (const entry of entries) {
    const name = assertArchivePath(entry?.name);
    const nameBytes = Buffer.from(name, 'utf8');
    const source = Buffer.isBuffer(entry?.data) ? entry.data : Buffer.from(String(entry?.data ?? ''), 'utf8');
    const compressed = zlib.deflateRawSync(source);
    const checksum = crc32(source);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(DEFLATE_METHOD, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localRecords.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix host, ZIP specification 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(DEFLATE_METHOD, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0x81a40000, 38); // regular file, 0644
    central.writeUInt32LE(offset, 42);
    centralRecords.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralSize = centralRecords.reduce((total, record) => total + record.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localRecords, ...centralRecords, end]);
}

function markdownSingleLine(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function markdownInlineText(value) {
  return markdownSingleLine(value).replace(/[\\`*_{}<>()#+.!|-]/g, '\\$&').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function safeHttpUrl(value) {
  const raw = markdownSingleLine(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch { return ''; }
}

function textFence(value) {
  const source = String(value || '');
  const longest = Math.max(2, ...(source.match(/`+/g) || []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${source}\n${fence}`;
}

/** Pretty-print exactly the source-side information supplied for a job card. */
export function formatOriginalJobListingMarkdown(job = {}) {
  const title = markdownInlineText(job.title) || 'Untitled role';
  const company = markdownInlineText(job.company) || 'Unknown company';
  const description = String(job.description || '');
  const snippet = String(job.snippet || '');
  const lines = [
    `# ${title}`,
    '',
    `**Company:** ${company}`,
  ];
  const metadata = [
    ['Location', job.location],
    ['Compensation', job.salary],
    ['Posted', job.posted],
    ['Source', job.source],
    ['Language', job.language],
  ];
  for (const [label, value] of metadata) {
    const text = markdownInlineText(value);
    if (!text) continue;
    lines.push(`**${label}:** ${text}`);
  }
  const url = safeHttpUrl(job.url);
  if (url) lines.push(`**Listing URL:** <${url}>`);
  lines.push('', '---', '', '## Original scraped listing', '');
  if (description) lines.push(textFence(description));
  else if (snippet) lines.push(textFence(snippet));
  else lines.push('_No listing text was returned by the source._');
  lines.push('');
  return lines.join('\n');
}

/**
 * Create the user-facing bundle layout:
 *
 *   Company Name.zip
 *   └── Company Name/
 *       ├── Application.html
 *       ├── Resume.pdf
 *       ├── Cover Letter.pdf
 *       └── Original Job Listing.md
 */
export function createApplicationBundle({ company, applicationHtml, resumePdf, coverLetterPdf, jobListingMarkdown, modifiedAt } = {}) {
  const folderName = sanitizeApplicationBundlePart(company, 'Company');
  const html = String(applicationHtml || '');
  if (!html.trim()) throw new Error('The editable application HTML is required to create an application bundle.');
  const pdf = Buffer.isBuffer(resumePdf) ? resumePdf : (resumePdf ? Buffer.from(resumePdf) : null);
  if (!pdf?.length) throw new Error('The résumé PDF is unavailable. Resolve any résumé review items and export again after the PDF has been generated.');
  if (pdf.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('The résumé PDF artifact is invalid; export it again before creating the bundle.');
  const coverPdf = Buffer.isBuffer(coverLetterPdf) ? coverLetterPdf : (coverLetterPdf ? Buffer.from(coverLetterPdf) : null);
  if (!coverPdf?.length) throw new Error('The cover-letter PDF is unavailable. Export the cover letter again before creating the bundle.');
  if (coverPdf.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('The cover-letter PDF artifact is invalid; export it again before creating the bundle.');
  const listing = String(jobListingMarkdown || '');
  if (!listing.trim()) throw new Error('The original job-listing Markdown is required to create an application bundle.');
  const prefix = folderName;
  const entries = [
    { name: `${prefix}/Application.html`, data: html },
    { name: `${prefix}/Resume.pdf`, data: pdf },
    { name: `${prefix}/Cover Letter.pdf`, data: coverPdf },
    { name: `${prefix}/Original Job Listing.md`, data: listing },
  ];
  return {
    fileName: `${folderName}.zip`,
    folderName,
    entries: entries.map(entry => entry.name),
    buffer: createZipBuffer(entries, { modifiedAt }),
  };
}
