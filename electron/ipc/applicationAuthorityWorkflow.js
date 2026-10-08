/**
 * Pure, versioned primitives for the snapshot-authority application workflow.
 *
 * This module intentionally owns no files, prompts, transport, or scheduler.
 * Callers persist its small, digest-bound records in bounded pages and may run
 * descriptors in any order.  Nothing here treats a page limit as a limit on
 * the complete requirements, catalog, or audit.
 */
import crypto from 'node:crypto';

export const APPLICATION_AUTHORITY_WORKFLOW_VERSION = 1;
export const APPLICATION_AUTHORITY_MATCH_PAGE_REQUIREMENTS = 12;
export const APPLICATION_AUTHORITY_MATCH_PAGE_EVIDENCE = 24;
export const APPLICATION_AUTHORITY_REVIEW_TRACKS = Object.freeze([
  'fact-fidelity',
  'resume-hiring-quality',
  'letter-argument-editorial',
  'tailoring-ats',
  'cross-document-coherence',
]);

const PRIORITY_WEIGHT = Object.freeze({ highest: 3, high: 2, supporting: 1 });
const DISPOSITIONS = new Set(['addressed-resume', 'addressed-cover-letter', 'addressed-both', 'omitted-no-evidence', 'omitted-minimum-sufficient', 'contradicted', 'unclear']);
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

// The old reducer retained one receipt digest per catalog page for every
// requirement.  That is O(requirements × catalog pages) memory despite every
// displayed requirement seeing the same ordered receipt page sequence.  Hash
// the exact canonical JSON array incrementally instead: its final digest is
// byte-for-byte authorityDigest(receiptDigests), so persisted v1 workflow
// records and their binding semantics do not change.
function receiptDigestAccumulator() {
  const value = crypto.createHash('sha256'); value.update('[');
  let count = 0;
  return {
    append(digest) {
      if (count) value.update(','); value.update(JSON.stringify(digest)); count += 1;
    },
    digest() { return value.copy().update(']').digest('hex'); },
  };
}

function requireArray(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array.`);
  return value;
}

function requirePageSize(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${name} must be a positive safe integer.`);
  return value;
}

function requireId(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must have a nonempty string id.`);
  return value;
}

function uniqueRows(rows, name) {
  const seen = new Set();
  rows.forEach((row, index) => {
    const id = requireId(row?.id, `${name}[${index}]`);
    if (seen.has(id)) fail(`${name} repeats id ${JSON.stringify(id)}.`);
    seen.add(id);
  });
  return rows;
}

function pageDescriptors(rows, pageSize, kind) {
  const result = [];
  for (let start = 0; start < rows.length || (!rows.length && !result.length); start += pageSize) {
    const slice = rows.slice(start, start + pageSize);
    const descriptor = {
      version: APPLICATION_AUTHORITY_WORKFLOW_VERSION,
      kind,
      index: result.length,
      start,
      end: start + slice.length,
      ids: slice.map(row => row.id),
      contentDigest: authorityDigest(slice),
    };
    result.push(withDigest(descriptor));
    if (!rows.length) break;
  }
  return result;
}

export function validateAuthorityPageDescriptor(page, rows, kind) {
  if (!page || page.version !== APPLICATION_AUTHORITY_WORKFLOW_VERSION || page.kind !== kind
    || !Number.isSafeInteger(page.index) || !Number.isSafeInteger(page.start) || !Number.isSafeInteger(page.end)
    || !Array.isArray(page.ids) || page.end - page.start !== page.ids.length
    || page.digest !== digestRecord(page)) fail(`invalid ${kind} page descriptor.`);
  const slice = rows.slice(page.start, page.end);
  if (JSON.stringify(slice.map(row => row.id)) !== JSON.stringify(page.ids)
    || page.contentDigest !== authorityDigest(slice)) fail(`${kind} page descriptor no longer binds its frozen rows.`);
}

/** Build the immutable root used by matching, selection, and audit stages. */
export function createAuthorityWorkflowRoot({ requirements, catalog, roles = [], skills = [], requirementPageSize = APPLICATION_AUTHORITY_MATCH_PAGE_REQUIREMENTS, catalogPageSize = APPLICATION_AUTHORITY_MATCH_PAGE_EVIDENCE } = {}) {
  uniqueRows(requireArray(requirements, 'requirements'), 'requirements');
  uniqueRows(requireArray(catalog, 'catalog'), 'catalog');
  uniqueRows(requireArray(roles, 'roles'), 'roles');
  uniqueRows(requireArray(skills, 'skills'), 'skills');
  requirePageSize(requirementPageSize, 'requirementPageSize');
  requirePageSize(catalogPageSize, 'catalogPageSize');
  for (const requirement of requirements) if (!PRIORITY_WEIGHT[requirement.priority]) fail(`requirement ${requirement.id} has an invalid priority.`);
  const root = {
    version: APPLICATION_AUTHORITY_WORKFLOW_VERSION,
    kind: 'authority-workflow-root',
    requirementsDigest: authorityDigest(requirements),
    catalogDigest: authorityDigest(catalog),
    rolesDigest: authorityDigest(roles),
    skillsDigest: authorityDigest(skills),
    requirementPageSize,
    catalogPageSize,
    requirementPages: pageDescriptors(requirements, requirementPageSize, 'requirement'),
    catalogPages: pageDescriptors(catalog, catalogPageSize, 'catalog'),
  };
  return withDigest(root);
}

export function assertAuthorityWorkflowRoot(root, { requirements, catalog, roles = [], skills = [] } = {}) {
  if (!root || root.version !== APPLICATION_AUTHORITY_WORKFLOW_VERSION || root.kind !== 'authority-workflow-root'
    || root.digest !== digestRecord(root)) fail('root has an invalid digest or version.');
  if (root.requirementsDigest !== authorityDigest(requirements) || root.catalogDigest !== authorityDigest(catalog)
    || root.rolesDigest !== authorityDigest(roles) || root.skillsDigest !== authorityDigest(skills)) fail('root does not bind the supplied frozen authority data.');
  root.requirementPages.forEach(page => validateAuthorityPageDescriptor(page, requirements, 'requirement'));
  root.catalogPages.forEach(page => validateAuthorityPageDescriptor(page, catalog, 'catalog'));
  const expected = createAuthorityWorkflowRoot({ requirements, catalog, roles, skills, requirementPageSize: root.requirementPageSize, catalogPageSize: root.catalogPageSize });
  if (canonicalAuthorityValue(root) !== canonicalAuthorityValue(expected)) fail('root page metadata differs from its deterministic frozen authority projection.');
  return root;
}

export function* enumerateRequirementCatalogPairs(root) {
  if (!root || root.digest !== digestRecord(root)) fail('cannot enumerate an invalid root.');
  for (const requirementPage of root.requirementPages) for (const catalogPage of root.catalogPages) {
    yield requirementCatalogPairDescriptor(root, requirementPage.index, catalogPage.index);
  }
}

/** Construct one pair directly; callers need never allocate the full product. */
export function requirementCatalogPairDescriptor(root, requirementPageIndex, catalogPageIndex) {
  if (!root || root.digest !== digestRecord(root)) fail('cannot construct a pair from an invalid root.');
  const requirementPage = root.requirementPages[requirementPageIndex];
  const catalogPage = root.catalogPages[catalogPageIndex];
  if (!requirementPage || !catalogPage) fail('pair references a page outside the root.');
  return withDigest({
    version: APPLICATION_AUTHORITY_WORKFLOW_VERSION,
    kind: 'requirement-catalog-pair',
    rootDigest: root.digest,
    requirementPageIndex,
    catalogPageIndex,
    requirementPageDigest: requirementPage.digest,
    catalogPageDigest: catalogPage.digest,
    requirementIds: requirementPage.ids,
    catalogEvidenceIds: catalogPage.ids,
  });
}

export function nextRequirementCatalogPair(root, cursor = { requirementPageIndex: 0, catalogPageIndex: 0 }) {
  const requirementPageIndex = Number(cursor?.requirementPageIndex || 0);
  const catalogPageIndex = Number(cursor?.catalogPageIndex || 0);
  if (!Number.isSafeInteger(requirementPageIndex) || !Number.isSafeInteger(catalogPageIndex) || requirementPageIndex < 0 || catalogPageIndex < 0) fail('pair cursor is invalid.');
  if (requirementPageIndex >= root.requirementPages.length) return null;
  if (catalogPageIndex >= root.catalogPages.length) return requirementPageIndex + 1 < root.requirementPages.length
    ? requirementCatalogPairDescriptor(root, requirementPageIndex + 1, 0) : null;
  return requirementCatalogPairDescriptor(root, requirementPageIndex, catalogPageIndex);
}

// Store-backed roots deliberately bind stream heads/counts instead of copying
// every requirement and catalog row into a manifest or a handoff state.  The
// caller supplies the two immutable receipt pages for the one pair it is about
// to show.  This keeps total work unbounded while retaining a small, exact
// per-call proof.
function streamBinding(receipt, name) {
  if (!receipt || !Number.isSafeInteger(receipt.count) || receipt.count < 1
    || typeof receipt.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.digest)) fail(`${name} stream receipt is invalid.`);
  return { count: receipt.count, digest: receipt.digest };
}

/** The omitted field is the historical v1 `requirements` ledger stream. */
export function storeAuthorityRequirementsStream(root) {
  if (root?.requirementsStream === undefined) return DEFAULT_REQUIREMENTS_STREAM;
  if (typeof root.requirementsStream !== 'string' || !AUTHORITY_LEDGER_STREAM.test(root.requirementsStream)) fail('store root requirements stream is invalid.');
  return root.requirementsStream;
}

function assertStoreAuthorityWorkflowRoot(root) {
  if (!root || root.version !== APPLICATION_AUTHORITY_WORKFLOW_VERSION || root.kind !== 'authority-store-workflow-root'
    || root.digest !== digestRecord(root)) fail('store root is invalid.');
  streamBinding(root.requirements, 'requirements'); streamBinding(root.catalog, 'catalog');
  if (typeof root.rolesDigest !== 'string' || typeof root.skillsDigest !== 'string') fail('store root needs frozen role and skill digests.');
  requirePageSize(root.requirementPageSize, 'requirementPageSize'); requirePageSize(root.catalogPageSize, 'catalogPageSize');
  storeAuthorityRequirementsStream(root);
  return root;
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

function storePageRows(page, kind) {
  if (!page || !Array.isArray(page.records) || typeof page.digest !== 'string') fail(`${kind} store page is invalid.`);
  const rows = page.records.filter(record => record?.kind === kind && record.item).map(record => record.item);
  uniqueRows(rows, `${kind} store page`);
  return rows;
}

function assertRequirementPageStream(root, requirementPage) {
  const requirementsStream = storeAuthorityRequirementsStream(root);
  // Pre-stream v1 receipt pages have no `stream`. Preserve that exact form
  // only for the historical requirements stream; an explicit page must never
  // be accepted from a different stream.
  if (requirementsStream === DEFAULT_REQUIREMENTS_STREAM && requirementPage?.stream === undefined) return;
  if (requirementPage?.stream !== requirementsStream) fail('requirement store page stream does not match the active requirements stream.');
}

export function storeRequirementCatalogPairDescriptor(root, { requirementPage, catalogPage } = {}) {
  assertStoreAuthorityWorkflowRoot(root);
  if (!Number.isSafeInteger(requirementPage?.number) || !Number.isSafeInteger(catalogPage?.number)
    || requirementPage.number < 0 || catalogPage.number < 0 || requirementPage.number >= root.requirements.count || catalogPage.number >= root.catalog.count) fail('store pair references a page outside the root.');
  assertRequirementPageStream(root, requirementPage);
  const requirements = storePageRows(requirementPage, 'requirement');
  const catalog = storePageRows(catalogPage, 'catalog-evidence');
  if (!requirements.length || !catalog.length) fail('store pair cannot bind an empty requirements or catalog page.');
  const pair = { version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, kind: 'store-requirement-catalog-pair', rootDigest: root.digest,
    requirementPageIndex: requirementPage.number, catalogPageIndex: catalogPage.number,
    requirementPageDigest: requirementPage.digest, catalogPageDigest: catalogPage.digest,
    requirementIds: requirements.map(row => row.id), catalogEvidenceIds: catalog.map(row => row.id) };
  const requirementsStream = storeAuthorityRequirementsStream(root);
  if (requirementsStream !== DEFAULT_REQUIREMENTS_STREAM) pair.requirementsStream = requirementsStream;
  return withDigest(pair);
}

export function nextStoreRequirementCatalogPair(root, cursor = {}) {
  assertStoreAuthorityWorkflowRoot(root);
  const requirementPageIndex = Number(cursor.requirementPageIndex || 0); const catalogPageIndex = Number(cursor.catalogPageIndex || 0);
  if (!Number.isSafeInteger(requirementPageIndex) || !Number.isSafeInteger(catalogPageIndex) || requirementPageIndex < 0 || catalogPageIndex < 0) fail('store pair cursor is invalid.');
  if (requirementPageIndex >= root.requirements.count) return null;
  if (catalogPageIndex < root.catalog.count) return { requirementPageIndex, catalogPageIndex };
  return requirementPageIndex + 1 < root.requirements.count ? { requirementPageIndex: requirementPageIndex + 1, catalogPageIndex: 0 } : null;
}

export function createStoreMatchReceipt({ root, pair, response } = {}) {
  assertStoreAuthorityWorkflowRoot(root);
  if (!pair || pair.kind !== 'store-requirement-catalog-pair' || pair.rootDigest !== root?.digest || pair.digest !== digestRecord(pair)) fail('match response has an invalid store pair descriptor.');
  const requirementsStream = storeAuthorityRequirementsStream(root);
  if (pair.requirementsStream !== (requirementsStream === DEFAULT_REQUIREMENTS_STREAM ? undefined : requirementsStream)) fail('match response pair has stale requirements stream metadata.');
  if (!response || response.version !== APPLICATION_AUTHORITY_WORKFLOW_VERSION || response.rootDigest !== root.digest || response.pairDigest !== pair.digest) fail('match response does not bind the current store root and pair digests.');
  const rows = requireArray(response.rows, 'match response rows');
  if (rows.length !== pair.requirementIds.length) fail('match response must return every displayed requirement exactly once.');
  const displayed = new Set(pair.catalogEvidenceIds); const seen = new Set();
  const normalizedRows = rows.map((row, index) => {
    const requirementId = requireId(row?.requirementId, `match row ${index}`);
    if (!pair.requirementIds.includes(requirementId) || seen.has(requirementId)) fail('match response has duplicate or undisplayed requirement IDs.');
    seen.add(requirementId);
    const candidateEvidenceIds = requireArray(row?.candidateEvidenceIds, `match row ${requirementId}.candidateEvidenceIds`);
    if (new Set(candidateEvidenceIds).size !== candidateEvidenceIds.length || candidateEvidenceIds.some(id => !displayed.has(id))) fail('match response cites evidence outside its displayed catalog page.');
    if (!['matched', 'no-match'].includes(row?.localStatus) || (row.localStatus === 'matched') !== (candidateEvidenceIds.length > 0)) fail('match response localStatus must agree with its local evidence IDs.');
    return { requirementId, candidateEvidenceIds: [...candidateEvidenceIds], localStatus: row.localStatus };
  });
  return withDigest({ version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, kind: 'store-match-receipt', rootDigest: root.digest, pairDigest: pair.digest,
    requirementPageIndex: pair.requirementPageIndex, catalogPageIndex: pair.catalogPageIndex,
    requirementPageDigest: pair.requirementPageDigest, catalogPageDigest: pair.catalogPageDigest,
    rows: normalizedRows, responseDigest: authorityDigest({ version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, rootDigest: root.digest, pairDigest: pair.digest, rows: normalizedRows }) });
}

/** Reduce one requirement receipt page at a time.  It intentionally retains
 * no evidence-ID array: immutable match receipts remain the exhaustive proof,
 * while the reduction is a compact status frontier for drafting/disposition. */
export function createStoreReductionPage({ root, requirementPage, receipts } = {}) {
  assertStoreAuthorityWorkflowRoot(root);
  assertRequirementPageStream(root, requirementPage);
  const requirements = storePageRows(requirementPage, 'requirement');
  if (!requirements.length) fail('store reduction requires a nonempty requirement page.');
  const byRequirement = new Map(requirements.map(row => [row.id, { requirement: row, matchedEvidenceCount: 0, receiptDigest: receiptDigestAccumulator() }]));
  const seenCatalogPages = new Set();
  for (const receipt of requireArray(receipts, 'store match receipts')) {
    if (!receipt || receipt.kind !== 'store-match-receipt' || receipt.rootDigest !== root.digest || receipt.digest !== digestRecord(receipt)
      || receipt.requirementPageIndex !== requirementPage.number || !Number.isSafeInteger(receipt.catalogPageIndex)
      || receipt.catalogPageIndex < 0 || receipt.catalogPageIndex >= root.catalog.count || seenCatalogPages.has(receipt.catalogPageIndex)) fail('store reduction has duplicate, missing, or foreign match receipt.');
    seenCatalogPages.add(receipt.catalogPageIndex);
    for (const row of receipt.rows) {
      const aggregate = byRequirement.get(row.requirementId); if (!aggregate) fail('store reduction receipt contains an undisplayed requirement.');
      aggregate.matchedEvidenceCount += row.candidateEvidenceIds.length; aggregate.receiptDigest.append(receipt.digest);
    }
  }
  if (seenCatalogPages.size !== root.catalog.count) fail('store reduction lacks complete catalog coverage.');
  const rows = requirements.map(requirement => {
    const aggregate = byRequirement.get(requirement.id);
    return { requirementId: requirement.id, priority: requirement.priority, matchedEvidenceCount: aggregate.matchedEvidenceCount,
      finalStatus: aggregate.matchedEvidenceCount ? 'supported' : 'unsupported', matchReceiptDigest: aggregate.receiptDigest.digest() };
  });
  return withDigest({ version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, kind: 'store-reduction-page', rootDigest: root.digest,
    requirementPageIndex: requirementPage.number, requirementPageDigest: requirementPage.digest,
    catalogPageCount: root.catalog.count, catalogStreamDigest: root.catalog.digest, rows });
}

/**
 * Async counterpart for store-backed callers.  A current authority catalog can
 * have arbitrarily many receipt pages, so materialising `receipts` just to
 * compute one small reduction page defeats the point of the ledger.  The
 * callback is deliberately ordinal: it makes omission, duplication, and
 * out-of-order substitution observable while retaining one receipt at a
 * time.
 */
export async function createStoreReductionPageFromReceiptAt({ root, requirementPage, receiptAt } = {}) {
  if (typeof receiptAt !== 'function') fail('store reduction receipt reader must be a function.');
  assertStoreAuthorityWorkflowRoot(root);
  assertRequirementPageStream(root, requirementPage);
  const requirements = storePageRows(requirementPage, 'requirement');
  if (!requirements.length) fail('store reduction requires a nonempty requirement page.');
  const byRequirement = new Map(requirements.map(row => [row.id, { requirement: row, matchedEvidenceCount: 0, receiptDigest: receiptDigestAccumulator() }]));
  for (let catalogPageIndex = 0; catalogPageIndex < root.catalog.count; catalogPageIndex += 1) {
    const receipt = await receiptAt(catalogPageIndex);
    if (!receipt || receipt.kind !== 'store-match-receipt' || receipt.rootDigest !== root.digest || receipt.digest !== digestRecord(receipt)
      || receipt.requirementPageIndex !== requirementPage.number || receipt.catalogPageIndex !== catalogPageIndex) {
      fail('store reduction has a missing, foreign, or out-of-order match receipt.');
    }
    for (const row of receipt.rows) {
      const aggregate = byRequirement.get(row.requirementId);
      if (!aggregate) fail('store reduction receipt contains an undisplayed requirement.');
      aggregate.matchedEvidenceCount += row.candidateEvidenceIds.length;
      aggregate.receiptDigest.append(receipt.digest);
    }
  }
  const rows = requirements.map(requirement => {
    const aggregate = byRequirement.get(requirement.id);
    return { requirementId: requirement.id, priority: requirement.priority, matchedEvidenceCount: aggregate.matchedEvidenceCount,
      finalStatus: aggregate.matchedEvidenceCount ? 'supported' : 'unsupported', matchReceiptDigest: aggregate.receiptDigest.digest() };
  });
  return withDigest({ version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, kind: 'store-reduction-page', rootDigest: root.digest,
    requirementPageIndex: requirementPage.number, requirementPageDigest: requirementPage.digest,
    catalogPageCount: root.catalog.count, catalogStreamDigest: root.catalog.digest, rows });
}

export function createStoreDispositionReceipt({ root, requirementPage, reduction, response, finalReferences } = {}) {
  assertStoreAuthorityWorkflowRoot(root);
  assertRequirementPageStream(root, requirementPage);
  const requirements = storePageRows(requirementPage, 'requirement');
  if (!reduction || reduction.kind !== 'store-reduction-page' || reduction.digest !== digestRecord(reduction)
    || reduction.rootDigest !== root.digest || reduction.requirementPageDigest !== requirementPage.digest) fail('store disposition reduction is invalid.');
  if (!finalReferences || !Array.isArray(finalReferences.documents) || !Array.isArray(finalReferences.evidenceIds)
    || !finalReferences.documentTexts || typeof finalReferences.documentTexts !== 'object' || Array.isArray(finalReferences.documentTexts)) {
    fail('store disposition needs frozen final references and exact final document text.');
  }
  const documentTextFor = document => {
    const text = finalReferences.documentTexts[document];
    if (typeof text !== 'string' || !text.trim()) fail(`store disposition final ${document} text is missing.`);
    return text;
  };
  for (const document of finalReferences.documents) documentTextFor(document);
  if (!response || response.version !== APPLICATION_AUTHORITY_WORKFLOW_VERSION || response.rootDigest !== root.digest
    || response.requirementPageDigest !== requirementPage.digest || response.reductionDigest !== reduction.digest
    || response.finalReferencesDigest !== authorityDigest(finalReferences)) fail('store disposition response has stale bindings.');
  const reduced = new Map(reduction.rows.map(row => [row.requirementId, row])); const allowed = new Set([...finalReferences.documents, ...finalReferences.evidenceIds]);
  const seen = new Set(); const rows = requireArray(response.rows, 'store disposition rows');
  if (rows.length !== requirements.length) fail('store disposition must cover every displayed requirement exactly once.');
  const normalized = rows.map(row => {
    const requirementId = requireId(row?.requirementId, 'store disposition row'); const requirement = requirements.find(item => item.id === requirementId);
    if (!requirement || seen.has(requirementId)) fail('store disposition has duplicate or undisplayed requirement IDs.');
    seen.add(requirementId);
    const documentRefs = requireArray(row.documentRefs, `store disposition ${requirementId}.documentRefs`);
    if (new Set(documentRefs).size !== documentRefs.length || documentRefs.some(id => !allowed.has(id))) fail('store disposition references an unfrozen document or evidence ID.');
    if (row.priority !== requirement.priority || !DISPOSITIONS.has(row.disposition) || typeof row.justification !== 'string' || !row.justification.trim()) fail('store disposition has invalid priority, disposition, or justification.');
    if (row.disposition === 'omitted-no-evidence' && reduced.get(requirementId)?.finalStatus !== 'unsupported') fail('omitted-no-evidence is legal only for an unsupported requirement.');
    const needed = { 'addressed-resume': ['resume'], 'addressed-cover-letter': ['cover-letter'], 'addressed-both': ['resume', 'cover-letter'] }[row.disposition] || [];
    if (needed.some(id => !documentRefs.includes(id))) fail('store disposition lacks a claimed final document reference.');
    const proofs = requireArray(row.proofs, `store disposition ${requirementId}.proofs`);
    if (needed.length && !proofs.length) fail('addressed store disposition requires an exact final-document proof locator.');
    if (!needed.length && proofs.length) fail('an omitted or unclear store disposition cannot claim final-document proof.');
    const proofDocuments = new Set(); const proofKeys = new Set();
    const normalizedProofs = proofs.map((proof, proofIndex) => {
      if (!proof || typeof proof !== 'object' || Array.isArray(proof)
        || JSON.stringify(Object.keys(proof).sort()) !== JSON.stringify(['document', 'documentDigest', 'offset', 'quote'].sort())) {
        fail(`store disposition ${requirementId} proof ${proofIndex} has an invalid locator shape.`);
      }
      const document = requireId(proof.document, `store disposition ${requirementId} proof document`);
      if (!needed.includes(document)) fail('store disposition proof names a document the disposition does not address.');
      const quote = typeof proof.quote === 'string' ? proof.quote : ''; const offset = proof.offset;
      if (!quote.trim() || !Number.isSafeInteger(offset) || offset < 0) fail('store disposition proof needs a nonempty exact quote and nonnegative offset.');
      const text = documentTextFor(document); const documentDigest = authorityDigest(text);
      if (proof.documentDigest !== documentDigest || text.slice(offset, offset + quote.length) !== quote) {
        fail('store disposition proof quote is not an exact substring at its digest-bound final-document locator.');
      }
      const key = `${document}:${offset}:${quote}`; if (proofKeys.has(key)) fail('store disposition repeats an exact final-document proof locator.');
      proofKeys.add(key); proofDocuments.add(document);
      return { document, documentDigest, offset, quote };
    });
    if (needed.some(document => !proofDocuments.has(document))) fail('addressed store disposition lacks exact proof for every document it claims.');
    return { requirementId, priority: row.priority, disposition: row.disposition, justification: row.justification.trim(), documentRefs: [...documentRefs], proofs: normalizedProofs };
  });
  return withDigest({ version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, kind: 'store-disposition-receipt', rootDigest: root.digest,
    requirementPageIndex: requirementPage.number, requirementPageDigest: requirementPage.digest, reductionDigest: reduction.digest,
    finalReferencesDigest: authorityDigest(finalReferences), rows: normalized,
    responseDigest: authorityDigest({ version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, rootDigest: root.digest, requirementPageDigest: requirementPage.digest, reductionDigest: reduction.digest, finalReferencesDigest: authorityDigest(finalReferences), rows: normalized }) });
}

/** Validate one bounded worker answer. It cannot claim catalog-wide absence. */
export function validateMatchResponse({ root, pair, response } = {}) {
  if (!pair || pair.kind !== 'requirement-catalog-pair' || pair.rootDigest !== root?.digest || pair.digest !== digestRecord(pair)) fail('match response has an invalid pair descriptor.');
  const expected = requirementCatalogPairDescriptor(root, pair.requirementPageIndex, pair.catalogPageIndex);
  if (canonicalAuthorityValue(pair) !== canonicalAuthorityValue(expected)) fail('match response pair is not the exact current root pair.');
  if (!response || response.version !== APPLICATION_AUTHORITY_WORKFLOW_VERSION || response.rootDigest !== root.digest || response.pairDigest !== pair.digest) fail('match response does not bind the current root and pair digests.');
  const rows = requireArray(response.rows, 'match response rows');
  if (rows.length !== pair.requirementIds.length) fail('match response must return every displayed requirement exactly once.');
  const seen = new Set(); const displayedEvidence = new Set(pair.catalogEvidenceIds);
  const normalized = rows.map((row, index) => {
    const requirementId = requireId(row?.requirementId, `match row ${index}`);
    if (!pair.requirementIds.includes(requirementId) || seen.has(requirementId)) fail('match response has duplicate or undisplayed requirement IDs.');
    seen.add(requirementId);
    const candidateEvidenceIds = requireArray(row?.candidateEvidenceIds, `match row ${requirementId}.candidateEvidenceIds`);
    if (new Set(candidateEvidenceIds).size !== candidateEvidenceIds.length || candidateEvidenceIds.some(id => !displayedEvidence.has(id))) fail('match response cites evidence outside its displayed catalog page.');
    if (!['matched', 'no-match'].includes(row?.localStatus)) fail('match response localStatus must be matched or no-match.');
    if ((row.localStatus === 'matched') !== (candidateEvidenceIds.length > 0)) fail('match response localStatus must agree with its local evidence IDs.');
    return { requirementId, candidateEvidenceIds: [...candidateEvidenceIds], localStatus: row.localStatus };
  });
  if (seen.size !== pair.requirementIds.length) fail('match response omitted a displayed requirement.');
  return { version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, kind: 'match-response', rootDigest: root.digest, pairDigest: pair.digest,
    requirementPageIndex: pair.requirementPageIndex, catalogPageIndex: pair.catalogPageIndex, rows: normalized };
}

export function createMatchReceipt({ root, pair, response } = {}) {
  const normalized = validateMatchResponse({ root, pair, response });
  return withDigest({ ...normalized, kind: 'match-receipt', responseDigest: authorityDigest(normalized) });
}

function pairKey(pair) { return `${pair.requirementPageIndex}:${pair.catalogPageIndex}`; }

/** Exact Cartesian coverage; errors rather than silently choosing first/last duplicate. */
export function assertMatchCoverage(root, receipts) {
  const actual = new Map();
  for (const receipt of requireArray(receipts, 'match receipts')) {
    if (!receipt || receipt.kind !== 'match-receipt' || receipt.rootDigest !== root.digest || receipt.digest !== digestRecord(receipt)) fail('match receipt has an invalid digest or root.');
    const pair = requirementCatalogPairDescriptor(root, receipt.requirementPageIndex, receipt.catalogPageIndex);
    if (pair.digest !== receipt.pairDigest) fail('match receipt refers to an unknown pair.');
    const key = pairKey(pair);
    if (actual.has(key)) fail(`duplicate match receipt for pair ${key}.`);
    const normalized = validateMatchResponse({ root, pair, response: receipt });
    if (receipt.responseDigest !== authorityDigest(normalized)) fail('match receipt response digest is invalid.');
    actual.set(key, receipt);
  }
  const expectedCount = root.requirementPages.length * root.catalogPages.length;
  if (actual.size !== expectedCount) {
    for (let requirementPageIndex = 0; requirementPageIndex < root.requirementPages.length; requirementPageIndex += 1) {
      for (let catalogPageIndex = 0; catalogPageIndex < root.catalogPages.length; catalogPageIndex += 1) {
        const key = `${requirementPageIndex}:${catalogPageIndex}`;
        if (!actual.has(key)) fail(`match coverage is incomplete; missing pair ${key}.`);
      }
    }
  }
  return [...actual.values()];
}

/** Reduces only after exact coverage, preserving every positive edge and every local gap. */
export function reduceRequirementMatches(root, receipts) {
  const covered = assertMatchCoverage(root, receipts);
  const requirements = root.requirementPages.flatMap(page => page.ids);
  const aggregateRows = new Map(requirements.map(requirementId => [requirementId, { evidenceIds: new Set(), localGapCatalogPages: [] }]));
  for (const receipt of covered) for (const row of receipt.rows) {
    const aggregate = aggregateRows.get(row.requirementId);
    row.candidateEvidenceIds.forEach(id => aggregate.evidenceIds.add(id));
    if (row.localStatus === 'no-match') aggregate.localGapCatalogPages.push(receipt.catalogPageIndex);
  }
  const coverageDigest = authorityDigest(root.catalogPages.map(page => page.digest));
  const aggregates = requirements.map(requirementId => {
    const aggregate = aggregateRows.get(requirementId);
    return {
      requirementId,
      coveredCatalogPageCount: root.catalogPages.length,
      coveredCatalogPageDigest: coverageDigest,
      matchedEvidenceIds: [...aggregate.evidenceIds].sort(),
      localGapCatalogPages: aggregate.localGapCatalogPages.sort((left, right) => left - right),
      finalStatus: aggregate.evidenceIds.size ? 'supported' : 'unsupported',
    };
  });
  return withDigest({ version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, kind: 'requirement-match-reduction', rootDigest: root.digest, requirementCount: aggregates.length, aggregates });
}

function reductionByRequirement(reduction) {
  if (!reduction || reduction.kind !== 'requirement-match-reduction' || reduction.digest !== digestRecord(reduction)) fail('match reduction is invalid.');
  return new Map(reduction.aggregates.map(row => [row.requirementId, row]));
}

function roleScores({ requirements, catalog, roles, reduction }) {
  const catalogById = new Map(catalog.map(row => [row.id, row]));
  const score = new Map(roles.map((role, index) => [role.id, { role, index, requirementIds: new Set(), evidenceIds: new Set(), score: 0 }]));
  const byRequirement = reductionByRequirement(reduction);
  for (const requirement of requirements) {
    const aggregate = byRequirement.get(requirement.id);
    for (const evidenceId of aggregate?.matchedEvidenceIds || []) {
      const roleId = catalogById.get(evidenceId)?.roleId;
      const row = score.get(roleId);
      if (!row) continue;
      row.requirementIds.add(requirement.id); row.evidenceIds.add(evidenceId);
      row.score += PRIORITY_WEIGHT[requirement.priority];
    }
  }
  return score;
}

/** Deterministic coverage-first role selection with an exhaustive omission trace. */
export function selectDraftRoles({ requirements, catalog, roles, reduction, maxRoles = 32 } = {}) {
  uniqueRows(requireArray(roles, 'roles'), 'roles');
  requirePageSize(maxRoles, 'maxRoles');
  const scores = roleScores({ requirements, catalog, roles, reduction });
  const remaining = new Set(requirements.map(row => row.id)); const selected = [];
  while (selected.length < maxRoles) {
    const candidates = [...scores.values()].filter(row => !selected.includes(row.role.id));
    if (!candidates.length) break;
    candidates.sort((left, right) => {
      const leftNew = [...left.requirementIds].filter(id => remaining.has(id)).reduce((sum, id) => sum + PRIORITY_WEIGHT[requirements.find(row => row.id === id).priority], 0);
      const rightNew = [...right.requirementIds].filter(id => remaining.has(id)).reduce((sum, id) => sum + PRIORITY_WEIGHT[requirements.find(row => row.id === id).priority], 0);
      return rightNew - leftNew || right.score - left.score || left.index - right.index || left.role.id.localeCompare(right.role.id);
    });
    const winner = candidates[0];
    if (!winner.requirementIds.size && selected.length) break;
    selected.push(winner.role.id); winner.requirementIds.forEach(id => remaining.delete(id));
  }
  if (!selected.length && roles.length) selected.push(roles[0].id);
  const selectedSet = new Set(selected);
  const omitted = roles.filter(role => !selectedSet.has(role.id)).map(role => {
    const row = scores.get(role.id);
    return {
      id: role.id,
      reason: row.requirementIds.size ? 'lower deterministic requirement-coverage rank than selected bounded-layout roles' : 'no supported frozen requirement match in the complete career catalog',
      requirementIds: [...row.requirementIds].sort(),
    };
  });
  return withDigest({ version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, kind: 'role-selection', rootDigest: reduction.rootDigest, maxRoles, selectedRoleIds: selected, omitted });
}

function skillScore(skill, matchedIds) {
  const ids = Array.isArray(skill?.evidenceIds) ? skill.evidenceIds : [];
  return ids.filter(id => matchedIds.has(id)).length;
}

export function selectDraftSkills({ skills, reduction, maxSkills = 10, omissionPageSize = 24 } = {}) {
  uniqueRows(requireArray(skills, 'skills'), 'skills'); requirePageSize(maxSkills, 'maxSkills'); requirePageSize(omissionPageSize, 'omissionPageSize');
  const matchedIds = new Set(reductionByRequirement(reduction).values().flatMap(row => row.matchedEvidenceIds));
  const ranked = skills.map((skill, index) => ({ skill, index, score: skillScore(skill, matchedIds) }))
    .sort((left, right) => right.score - left.score || left.index - right.index || left.skill.id.localeCompare(right.skill.id));
  // A short inventory is not evidence. The former `skills.length <= maxSkills`
  // exception filled otherwise empty layout slots in source order, turning
  // unmatching profile vocabulary into an ATS claim. A current-authority
  // skill is selectable only from positive frozen requirement evidence.
  const selectedSkillIds = ranked.filter(row => row.score > 0).slice(0, maxSkills).map(row => row.skill.id);
  const selected = new Set(selectedSkillIds);
  const omitted = skills.filter(skill => !selected.has(skill.id)).map(skill => ({ id: skill.id,
    reason: (Array.isArray(skill.evidenceIds) ? skill.evidenceIds : []).some(id => matchedIds.has(id))
      ? 'not selected for the bounded final résumé skills layout' : 'no selected frozen evidence supports this skill for the job' }));
  const omissionPages = pageDescriptors(omitted, omissionPageSize, 'skill-omission');
  return withDigest({ version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, kind: 'skill-selection', rootDigest: reduction.rootDigest, maxSkills, selectedSkillIds, omitted, omissionPages });
}

function evidenceTarget(item) {
  if (typeof item?.roleId === 'string' && item.roleId) return { type: 'role', id: item.roleId };
  if (typeof item?.projectId === 'string' && item.projectId) return { type: 'project', id: item.projectId };
  if (typeof item?.skillId === 'string' && item.skillId) return { type: 'skill', id: item.skillId };
  if (item?.owner && typeof item.owner.type === 'string' && typeof item.owner.id === 'string') return { type: item.owner.type, id: item.owner.id };
  return { type: 'standalone', id: item?.id };
}

export function selectDraftEvidence({ catalog, requirements, reduction, selectedRoleIds = [], selectedProjectIds = [], selectedSkillIds = [], includeStandaloneEvidence = true, maxEvidence, omissionPageSize = 24 } = {}) {
  uniqueRows(requireArray(catalog, 'catalog'), 'catalog'); requirePageSize(maxEvidence, 'maxEvidence'); requirePageSize(omissionPageSize, 'omissionPageSize');
  const selectedTargets = { role: new Set(selectedRoleIds), project: new Set(selectedProjectIds), skill: new Set(selectedSkillIds) }; const matched = reductionByRequirement(reduction);
  const selectedTarget = item => {
    const target = evidenceTarget(item);
    return target.type === 'standalone' || target.type === 'education' ? includeStandaloneEvidence : selectedTargets[target.type]?.has(target.id) === true;
  };
  const score = new Map(catalog.map((item, index) => [item.id, { item, index, score: 0, requirementIds: [] }]));
  for (const requirement of requirements) for (const id of matched.get(requirement.id)?.matchedEvidenceIds || []) {
    const row = score.get(id); if (!row) continue;
    row.score += PRIORITY_WEIGHT[requirement.priority] + (selectedTarget(row.item) ? 10 : 0);
    row.requirementIds.push(requirement.id);
  }
  const ranked = [...score.values()].filter(row => selectedTarget(row.item) && row.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index || left.item.id.localeCompare(right.item.id));
  const selectedEvidenceIds = ranked.slice(0, maxEvidence).map(row => row.item.id); const selected = new Set(selectedEvidenceIds);
  const selectedByTarget = Object.fromEntries([...new Set(catalog.map(item => `${evidenceTarget(item).type}:${evidenceTarget(item).id}`))].map(key => [key, []]));
  catalog.filter(item => selected.has(item.id)).forEach(item => selectedByTarget[`${evidenceTarget(item).type}:${evidenceTarget(item).id}`].push(item.id));
  const omitted = catalog.filter(item => !selected.has(item.id)).map(item => {
    const target = evidenceTarget(item);
    return { id: item.id, target, reason: selectedTarget(item) ? 'not selected within the finite document evidence layout' : `belongs to an omitted ${target.type} target` };
  });
  const omissionPages = pageDescriptors(omitted, omissionPageSize, 'evidence-omission');
  return withDigest({ version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, kind: 'evidence-selection', rootDigest: reduction.rootDigest, maxEvidence, selectedEvidenceIds, selectedByTarget, omitted, omissionPages });
}

export function createDispositionPlan(requirements, pageSize = APPLICATION_AUTHORITY_MATCH_PAGE_REQUIREMENTS) {
  uniqueRows(requireArray(requirements, 'requirements'), 'requirements'); requirePageSize(pageSize, 'dispositionPageSize');
  return withDigest({ version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, kind: 'requirement-disposition-plan', requirementsDigest: authorityDigest(requirements), pages: pageDescriptors(requirements, pageSize, 'disposition-requirement') });
}

export function validateDispositionResponse({ plan, requirements, pageIndex, response, reduction, finalReferences } = {}) {
  if (!plan || plan.kind !== 'requirement-disposition-plan' || plan.digest !== digestRecord(plan) || plan.requirementsDigest !== authorityDigest(requirements)) fail('disposition plan is invalid.');
  const reduced = reductionByRequirement(reduction);
  if (!finalReferences || !Array.isArray(finalReferences.documents) || !Array.isArray(finalReferences.evidenceIds)) fail('disposition validation requires exact final document and evidence references.');
  const finalReferencesDigest = authorityDigest(finalReferences);
  const allowedReferences = new Set([...finalReferences.documents, ...finalReferences.evidenceIds]);
  const page = plan.pages[pageIndex]; if (!page) fail('disposition page does not exist.');
  if (!response || response.version !== APPLICATION_AUTHORITY_WORKFLOW_VERSION || response.planDigest !== plan.digest || response.pageDigest !== page.digest
    || response.reductionDigest !== reduction.digest || response.finalReferencesDigest !== finalReferencesDigest) fail('disposition response has stale page, reduction, final-reference, or plan digests.');
  const byId = new Map(requirements.map(row => [row.id, row])); const rows = requireArray(response.rows, 'disposition response rows');
  if (rows.length !== page.ids.length) fail('disposition response must cover every displayed requirement exactly once.');
  const seen = new Set();
  const normalized = rows.map(row => {
    const requirementId = requireId(row?.requirementId, 'disposition row'); const requirement = byId.get(requirementId);
    if (!requirement || !page.ids.includes(requirementId) || seen.has(requirementId)) fail('disposition response has duplicate or undisplayed requirement IDs.');
    seen.add(requirementId);
    const documentRefs = requireArray(row.documentRefs, `disposition row ${requirementId}.documentRefs`);
    if (new Set(documentRefs).size !== documentRefs.length || documentRefs.some(ref => !allowedReferences.has(ref))) fail('disposition row references a document or evidence ID outside the final frozen artifact.');
    if (row.priority !== requirement.priority || !DISPOSITIONS.has(row.disposition) || typeof row.justification !== 'string' || !row.justification.trim()) fail('disposition row has invalid priority, disposition, or justification.');
    if (row.disposition === 'omitted-no-evidence' && reduced.get(requirementId)?.finalStatus !== 'unsupported') fail('omitted-no-evidence is legal only for a requirement the exhaustive reduction marked unsupported.');
    const requiredDocuments = { 'addressed-resume': ['resume'], 'addressed-cover-letter': ['cover-letter'], 'addressed-both': ['resume', 'cover-letter'] }[row.disposition] || [];
    if (requiredDocuments.some(document => !documentRefs.includes(document))) fail('addressed disposition must reference each final document it claims addresses the requirement.');
    return { requirementId, priority: row.priority, disposition: row.disposition, justification: row.justification.trim(), documentRefs: [...documentRefs] };
  });
  return { version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, kind: 'disposition-response', planDigest: plan.digest, pageDigest: page.digest,
    reductionDigest: reduction.digest, finalReferencesDigest, rows: normalized };
}

export function createDispositionReceipt(args) { const normalized = validateDispositionResponse(args); return withDigest({ ...normalized, kind: 'disposition-receipt', responseDigest: authorityDigest(normalized) }); }

export function assertDispositionCoverage(plan, requirements, receipts, { reduction, finalReferences } = {}) {
  const expected = new Map(plan.pages.map(page => [page.digest, page])); const actual = new Map();
  for (const receipt of requireArray(receipts, 'disposition receipts')) {
    const page = expected.get(receipt?.pageDigest); if (!page || actual.has(page.digest)) fail('disposition receipts have a missing, unknown, or duplicate page.');
    const normalized = validateDispositionResponse({ plan, requirements, pageIndex: page.index, response: receipt, reduction, finalReferences });
    if (receipt.kind !== 'disposition-receipt' || receipt.digest !== digestRecord(receipt) || receipt.responseDigest !== authorityDigest(normalized)) fail('disposition receipt digest is invalid.');
    actual.set(page.digest, receipt);
  }
  if (actual.size !== expected.size) fail('disposition coverage is incomplete.');
  return plan.pages.flatMap(page => actual.get(page.digest).rows);
}

/** Descriptors intentionally list the only host context a blind reviewer may receive. */
export function createBlindReviewerScopes({ resumeDigest, coverLetterDigest, requirementPlan = null, citationPageDigests = ['bundle'] } = {}) {
  if (typeof resumeDigest !== 'string' || typeof coverLetterDigest !== 'string') fail('review scopes require document digests.');
  const scopes = [];
  const add = (track, scopeKind, scopeId, input) => scopes.push(withDigest({ version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, kind: 'blind-review-scope', track, scopeKind, scopeId, inputDigest: authorityDigest(input), allowedContext: input.allowedContext }));
  citationPageDigests.forEach((digest, index) => add('fact-fidelity', 'citation-page', String(index), { resumeDigest, coverLetterDigest, citationDigest: digest, allowedContext: ['documents', 'cited-evidence-page'] }));
  add('resume-hiring-quality', 'resume', 'resume', { resumeDigest, allowedContext: ['resume'] });
  add('letter-argument-editorial', 'cover-letter', 'cover-letter', { coverLetterDigest, allowedContext: ['cover-letter'] });
  const pages = requirementPlan?.pages || [];
  pages.forEach(page => add('tailoring-ats', 'requirement-page', String(page.index), { resumeDigest, coverLetterDigest, requirementPageDigest: page.digest, allowedContext: ['documents', 'requirement-page'] }));
  add('cross-document-coherence', 'bundle', 'bundle', { resumeDigest, coverLetterDigest, allowedContext: ['resume', 'cover-letter'] });
  return scopes;
}

export function validateBlindReviewerResponse({ scope, response, previousReceipt = null, maxFindings = 32 } = {}) {
  if (!scope || scope.kind !== 'blind-review-scope' || scope.digest !== digestRecord(scope)) fail('review response scope is invalid.'); requirePageSize(maxFindings, 'maxFindings');
  if (!response || response.version !== APPLICATION_AUTHORITY_WORKFLOW_VERSION || response.scopeDigest !== scope.digest || !['pass', 'issues'].includes(response.decision)
    || !Number.isSafeInteger(response.pageIndex) || response.pageIndex < 0 || typeof response.complete !== 'boolean') fail('review response has stale scope or invalid page envelope.');
  if (response.pageIndex === 0 && response.previousPageDigest != null) fail('first review finding page must not name a predecessor.');
  if (response.pageIndex > 0 && (!previousReceipt || response.previousPageDigest !== previousReceipt.digest)) fail('review finding continuation does not bind its immediate predecessor.');
  const findings = requireArray(response.findings, 'review response findings');
  if (findings.length > maxFindings || (response.decision === 'pass') !== (findings.length === 0) || (response.decision === 'pass' && (!response.complete || response.pageIndex !== 0))) fail('review response decision and bounded findings disagree.');
  // A full page cannot honestly certify that no further findings exist.  The
  // reviewer must request its next bounded continuation; this is a paging
  // rule, never an aggregate review or call limit.
  if (response.complete && findings.length === maxFindings) fail('a full bounded finding page must continue; it cannot certify exhaustive review.');
  if (response.decision === 'issues' && !findings.length) fail('reviewer continuation made no progress; use pass only for a clean single-page scope.');
  const ids = new Set();
  const normalized = findings.map((finding, index) => {
    const id = requireId(finding?.id, `finding ${index}`); if (ids.has(id)) fail('review response repeats a finding ID.'); ids.add(id);
    if (typeof finding.ruleId !== 'string' || !finding.ruleId.trim() || typeof finding.issue !== 'string' || !finding.issue.trim()) fail('review finding needs a ruleId and issue.');
    return { id, ruleId: finding.ruleId.trim(), document: typeof finding.document === 'string' ? finding.document : 'bundle', targetId: typeof finding.targetId === 'string' ? finding.targetId : '', issue: finding.issue.trim(), fix: typeof finding.fix === 'string' ? finding.fix.trim() : '' };
  });
  const findingDigest = authorityDigest(normalized);
  if (response.pageIndex > 0 && previousReceipt) {
    const priorIds = new Set(previousReceipt.findings.map(finding => finding.id));
    if (normalized.some(finding => priorIds.has(finding.id))) fail('reviewer continuation repeats a finding ID from its authenticated exclusion page.');
  }
  if (response.pageIndex > 0 && previousReceipt?.findingDigest === findingDigest && !response.complete) fail('reviewer continuation repeats its prior findings without progress.');
  return { version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, kind: 'blind-review-response', scopeDigest: scope.digest, pageIndex: response.pageIndex,
    previousPageDigest: response.previousPageDigest ?? null, complete: response.complete, decision: response.decision, findingDigest, findings: normalized };
}

export function createBlindReviewerReceipt(args) { const normalized = validateBlindReviewerResponse(args); return withDigest({ ...normalized, kind: 'blind-review-receipt', responseDigest: authorityDigest(normalized) }); }

export function validateBlindReviewCoverage(scopes, receipts) {
  const expected = new Map(requireArray(scopes, 'review scopes').map(scope => [scope.digest, scope])); const actual = new Map();
  for (const receipt of requireArray(receipts, 'review receipts')) {
    const scope = expected.get(receipt?.scopeDigest); if (!scope) fail('review receipt coverage has an unknown scope.');
    const pages = actual.get(scope.digest) || [];
    if (pages.some(page => page.pageIndex === receipt.pageIndex)) fail('review receipt coverage repeats a finding page.');
    pages.push(receipt); actual.set(scope.digest, pages);
  }
  if (actual.size !== expected.size) fail('blind reviewer coverage is incomplete.');
  const completeReceipts = [];
  for (const [scopeDigest, scope] of expected) {
    const pages = (actual.get(scopeDigest) || []).sort((left, right) => left.pageIndex - right.pageIndex);
    let previousReceipt = null;
    pages.forEach((receipt, index) => {
      if (receipt.pageIndex !== index) fail('review finding pages must be contiguous from zero.');
      const normalized = validateBlindReviewerResponse({ scope, response: receipt, previousReceipt });
      if (receipt.kind !== 'blind-review-receipt' || receipt.digest !== digestRecord(receipt) || receipt.responseDigest !== authorityDigest(normalized)) fail('review receipt digest is invalid.');
      previousReceipt = receipt;
    });
    if (!previousReceipt?.complete) fail('reviewer finding pages have no explicit completion receipt.');
    const ids = new Set();
    for (const receipt of pages) for (const finding of receipt.findings) {
      if (ids.has(finding.id)) fail('reviewer finding pages repeat a finding ID without progress.');
      ids.add(finding.id);
    }
    completeReceipts.push(...pages);
  }
  return { complete: true, clean: completeReceipts.every(receipt => receipt.decision === 'pass'), receipts: completeReceipts };
}

export function invalidateBlindReviewerReceipts(scopes, receipts) {
  const expected = new Set(requireArray(scopes, 'review scopes').map(scope => scope.digest));
  const grouped = new Map();
  requireArray(receipts, 'review receipts').filter(receipt => expected.has(receipt?.scopeDigest)).forEach(receipt => {
    const pages = grouped.get(receipt.scopeDigest) || []; pages.push(receipt); grouped.set(receipt.scopeDigest, pages);
  });
  return [...grouped.values()].flatMap(pages => pages.some(receipt => receipt.complete) ? pages : []);
}

export function aggregateBlindFindings(receipts) {
  const rows = requireArray(receipts, 'review receipts').flatMap(receipt => receipt.findings.map(finding => ({ ...finding, scopeDigest: receipt.scopeDigest })));
  const unique = new Map();
  for (const row of rows) {
    const key = [row.scopeDigest, row.document, row.targetId, row.ruleId, row.issue, row.fix].join('\u0000');
    if (!unique.has(key)) unique.set(key, row);
  }
  const findings = [...unique.values()].sort((left, right) => canonicalAuthorityValue(left).localeCompare(canonicalAuthorityValue(right)));
  return withDigest({ version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, kind: 'blind-finding-aggregate', findingCount: findings.length, findings });
}

export function reviewConvergenceState({ resumeDigest, coverLetterDigest, unresolvedFindingDigest, selectionDigest, dispositionDigest }) {
  if (![resumeDigest, coverLetterDigest, unresolvedFindingDigest, selectionDigest, dispositionDigest].every(value => typeof value === 'string' && value)) fail('review convergence state needs all digest bindings.');
  return withDigest({ version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, kind: 'review-convergence-state', resumeDigest, coverLetterDigest, unresolvedFindingDigest, selectionDigest, dispositionDigest });
}

export function assertReviewConverges(history, nextState) {
  if (!nextState || nextState.kind !== 'review-convergence-state' || nextState.digest !== digestRecord(nextState)) fail('next review convergence state is invalid.');
  const prior = requireArray(history, 'review convergence history');
  if (prior.some(state => state?.digest === nextState.digest)) fail(`CAREER_APPLICATION_NONCONVERGENT: repeated review state ${nextState.digest} still has unresolved findings.`);
  const immediatelyPrior = prior.at(-1);
  if (immediatelyPrior && immediatelyPrior.resumeDigest === nextState.resumeDigest && immediatelyPrior.coverLetterDigest === nextState.coverLetterDigest
    && immediatelyPrior.unresolvedFindingDigest !== authorityDigest([])) fail('CAREER_APPLICATION_NONCONVERGENT: revision left both documents unchanged while findings remained unresolved.');
  return nextState;
}
