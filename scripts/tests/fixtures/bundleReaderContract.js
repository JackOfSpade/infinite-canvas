// The saved-bundle contract an outside reader relies on, kept as a small test
// oracle. Infinite Canvas writes Application.html, Original Job Listing.md,
// Generation Audit.json and the two PDFs; the separate Interview Helper app
// reads them back and trusts a bundle only when the receipt's savedArtifacts
// hashes match the files on disk. These tests assert the writer side of that
// contract (Sync and reconcile keep the receipt bound; the listing header keeps
// its identity lines) without importing the reader.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const AUDIT_SCHEMA = 'infinite-canvas-generation-audit';
const AUDIT_VERSION = 1;
const ID_RE = /^[a-f0-9]{64}$/u;
const MARKDOWN_ESCAPED_RE = /\\([\\`*_{}<>()#+.!|[\]-])/gu;

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const hashValue = value => (typeof value === 'string' && ID_RE.test(value) ? value.toLowerCase() : '');
const safeString = (value, max = 1200) => (typeof value === 'string'
  ? value.replace(/[\t\n\v\f\r]/gu, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, max)
  : '');
const redactIdentity = text => safeString(String(text || '')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[redacted email]')
  .replace(/(?:\+?\d[\d .()-]{7,}\d)/gu, '[redacted phone]'));

function readOptional(directory, name) {
  try { return fs.readFileSync(path.join(directory, name)); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function listingHeaderIdentity(markdown) {
  const separator = /\r?\n---\r?\n/u.exec(markdown);
  if (!separator) return null;
  const head = markdown.slice(0, separator.index);
  const pick = re => safeString(re.exec(head)?.[1]?.replace(MARKDOWN_ESCAPED_RE, '$1'), 300);
  const unlessPlaceholder = (value, placeholder) => (value === placeholder ? '' : value);
  return {
    title: unlessPlaceholder(pick(/^[\uFEFF \t]*#[ \t]+(.+)$/mu), 'Untitled role'),
    company: unlessPlaceholder(safeString(redactIdentity(pick(/^\*\*Company:\*\*[ \t]+(.+)$/mu)), 300), 'Unknown company'),
    location: safeString(redactIdentity(pick(/^\*\*Location:\*\*[ \t]+(.+)$/mu)), 300),
  };
}

function verificationFor(auditText, files) {
  if (!auditText) return { status: 'legacy-unverified', reason: 'no-generation-audit' };
  let audit;
  try { audit = JSON.parse(auditText); } catch { audit = null; }
  if (!plainObject(audit) || audit.version !== AUDIT_VERSION || audit.schema !== AUDIT_SCHEMA) return { status: 'unverified-invalid-audit', reason: 'invalid-generation-audit' };
  const saved = audit.savedArtifacts;
  if (!plainObject(saved)) return { status: 'legacy-unverified', reason: 'no-durable-saved-artifacts' };
  const expected = {
    applicationHtmlSha256: sha256(files.html),
    originalJobListingSha256: sha256(files.listing),
    ...(files.resumePdf ? { resumePdfSha256: sha256(files.resumePdf) } : {}),
    ...(files.coverPdf ? { coverLetterPdfSha256: sha256(files.coverPdf) } : {}),
  };
  for (const [key, digest] of Object.entries(expected)) if (hashValue(saved[key]) !== digest) return { status: 'hash-mismatch', reason: 'durable-artifact-hash-mismatch' };
  // A receipt may bind a PDF the folder no longer holds; that is an observation, not a mismatch.
  for (const key of ['resumePdfSha256', 'coverLetterPdfSha256']) {
    if (saved[key] != null && !hashValue(saved[key])) return { status: 'hash-mismatch', reason: 'invalid-durable-artifact-hash' };
  }
  return { status: 'verified', reason: 'saved-artifacts-hashes-match' };
}

/** Reads a saved bundle folder the way the outside reader does and returns its verdict and job identity. */
export function readBundleContract({ directory }) {
  const files = {
    html: readOptional(directory, 'Application.html'),
    listing: readOptional(directory, 'Original Job Listing.md'),
    resumePdf: readOptional(directory, 'Resume.pdf'),
    coverPdf: readOptional(directory, 'Cover Letter.pdf'),
  };
  if (!files.html || !files.listing) throw new Error('a saved bundle needs Application.html and Original Job Listing.md');
  const audit = readOptional(directory, 'Generation Audit.json')?.toString('utf8');
  const verification = verificationFor(audit, files);
  const listingText = files.listing.toString('utf8');
  const header = listingHeaderIdentity(listingText);
  const heading = safeString(listingText.split(/\r?\n/u).find(line => /^\s*#+\s+/u.test(line))?.replace(/^\s*#+\s*/u, ''), 300);
  const auditJob = verification.status === 'verified' ? JSON.parse(audit).job : null;
  return {
    verification,
    job: {
      title: safeString(auditJob?.title, 300) || (header ? header.title : heading),
      company: safeString(auditJob?.company, 300) || header?.company || '',
      location: safeString(auditJob?.location, 300) || header?.location || '',
    },
  };
}
