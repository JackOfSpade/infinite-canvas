/** Immutable authority root and digest used by requirements extraction and audit. */
import crypto from 'node:crypto';

export const APPLICATION_AUTHORITY_WORKFLOW_VERSION = 1;
export const APPLICATION_AUTHORITY_MATCH_PAGE_REQUIREMENTS = 12;
export const APPLICATION_AUTHORITY_MATCH_PAGE_EVIDENCE = 24;
const AUTHORITY_LEDGER_STREAM = /^[a-z][a-z0-9-]{0,39}$/u;
const DEFAULT_REQUIREMENTS_STREAM = 'requirements';

function fail(message) { throw new Error(`Application authority workflow: ${message}`); }

export function canonicalAuthorityValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalAuthorityValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalAuthorityValue(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function authorityDigest(value) {
  return crypto.createHash('sha256').update(canonicalAuthorityValue(value), 'utf8').digest('hex');
}

function digestRecord(record) {
  const { digest: _digest, ...unsigned } = record;
  return authorityDigest(unsigned);
}

function withDigest(record) { return { ...record, digest: digestRecord(record) }; }

function requirePageSize(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${name} must be a positive safe integer.`);
  return value;
}

function streamBinding(receipt, name) {
  if (!receipt || !Number.isSafeInteger(receipt.count) || receipt.count < 1
    || typeof receipt.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.digest)) fail(`${name} stream receipt is invalid.`);
  return { count: receipt.count, digest: receipt.digest };
}

export function createStoreAuthorityWorkflowRoot({ requirements, catalog, rolesDigest, skillsDigest, requirementsStream = DEFAULT_REQUIREMENTS_STREAM, requirementPageSize = APPLICATION_AUTHORITY_MATCH_PAGE_REQUIREMENTS, catalogPageSize = APPLICATION_AUTHORITY_MATCH_PAGE_EVIDENCE } = {}) {
  requirePageSize(requirementPageSize, 'requirementPageSize'); requirePageSize(catalogPageSize, 'catalogPageSize');
  if (typeof rolesDigest !== 'string' || typeof skillsDigest !== 'string') fail('store root needs frozen role and skill digests.');
  if (typeof requirementsStream !== 'string' || !AUTHORITY_LEDGER_STREAM.test(requirementsStream)) fail('requirementsStream is invalid.');
  const root = { version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, kind: 'authority-store-workflow-root',
    requirements: streamBinding(requirements, 'requirements'), catalog: streamBinding(catalog, 'catalog'),
    rolesDigest, skillsDigest, requirementPageSize, catalogPageSize };
  // Keep omitted/default construction byte-for-byte compatible with v1 roots.
  if (requirementsStream !== DEFAULT_REQUIREMENTS_STREAM) root.requirementsStream = requirementsStream;
  return withDigest(root);
}
