/**
 * Pure foundation for the field-level career-profile audit protocol.
 *
 * Auditors and repair workers return checkable edits (CAREER_PROFILE_EDIT_SCHEMA)
 * instead of prose or whole-page rewrites.  Edits are applied all-or-nothing
 * to one page shard, and a decision ledger remembers what was settled for each
 * edit target so a later finding cannot silently flip it back.
 *
 * Termination property: once a target has a decision, a finding touching it is
 * admitted only as a challenge that names the current decision and cites at
 * least one evidence segment not yet considered for that target; admitting it
 * adds those segments to the target's considered set, which only ever grows.
 * Segments are finite, so the number of decision changes per target is bounded
 * by the number of distinct evidence segments — by construction, with no
 * counters or round caps.
 *
 * No I/O; every function returns new values and never mutates its inputs
 * except the ledger helpers, which mutate the ledger they are given.
 */

import { createHash } from 'node:crypto';
import { CAREER_PROFILE_PAGE_SCHEMA, CAREER_PROFILE_EDIT_SCHEMA } from './aiSchemas.js';
import { validateResponseSchema } from './schemaValidation.js';

const PAGE_PROPERTIES = CAREER_PROFILE_PAGE_SCHEMA.properties;
const ENTITY_GROUPS = ['roles', 'achievements', 'projects', 'skills', 'education', 'certifications', 'otherEvidence'];
const PATCH_GROUPS = ['rolePatches', 'projectPatches'];
const COVERAGE_DISPOSITIONS = PAGE_PROPERTIES.segmentCoverage.items.properties.disposition.enum;
const DECISION_ORIGINS = new Set(['audit', 'repair', 'adjudication']);

function canonicalJson(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function itemSchemaFor(group) {
  if (group === 'identity') return PAGE_PROPERTIES.identity;
  return PAGE_PROPERTIES[group]?.items || null;
}

function idFieldFor(group) {
  if (PATCH_GROUPS.includes(group)) return 'targetId';
  if (group === 'segmentCoverage') return 'segmentId';
  return 'id';
}

function fieldSchemaFor(group, field) {
  return itemSchemaFor(group)?.properties?.[field] || null;
}

function deriveEditableFields() {
  const fields = {
    identity: Object.freeze(Object.keys(PAGE_PROPERTIES.identity.properties)),
  };
  for (const group of ENTITY_GROUPS) {
    fields[group] = Object.freeze(Object.keys(PAGE_PROPERTIES[group].items.properties).filter(key => key !== 'id'));
  }
  fields.segmentCoverage = Object.freeze(['disposition']);
  for (const group of PATCH_GROUPS) {
    fields[group] = Object.freeze(Object.keys(PAGE_PROPERTIES[group].items.properties).filter(key => key !== 'targetId'));
  }
  return Object.freeze(fields);
}

export const CAREER_PROFILE_EDITABLE_FIELDS = deriveEditableFields();

export function editTargetKey(edit) {
  let field = edit?.field || '*';
  if (edit?.op === 'add' || edit?.op === 'remove') field = '*';
  if (edit?.op === 'set-coverage') field = 'disposition';
  return `${edit?.group}\u0000${edit?.entityId}\u0000${field}`;
}

export function parseEditValue(edit) {
  const text = edit?.valueJson;
  if (typeof text !== 'string') return { ok: false, error: 'valueJson must be a string' };
  if (edit.op === 'remove') {
    return text === '' ? { ok: true, value: undefined } : { ok: false, error: "valueJson must be '' for remove" };
  }
  if (text === '') return { ok: false, error: `valueJson must not be empty for ${edit.op}` };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: `valueJson is not valid JSON (${error.message})` };
  }
}

function describeEdit(edit, index) {
  return `edit ${index} (${edit?.op} ${edit?.group}/${edit?.entityId}/${edit?.field || '*'})`;
}

function schemaErrorText(errors) {
  return errors.slice(0, 5).map(({ path, message }) => `${path} ${message}`).join('; ');
}

function locate(shard, group, entityId) {
  const list = Array.isArray(shard[group]) ? shard[group] : [];
  const idField = idFieldFor(group);
  const indexes = [];
  list.forEach((item, index) => { if (item && item[idField] === entityId) indexes.push(index); });
  return indexes;
}

/**
 * Apply edits to a copy of `shard`.  Any error returns the original shard
 * (the same reference, untouched) together with every error found.
 */
export function applyProfileEdits(shard, edits, { entityIdPrefix = '' } = {}) {
  const working = structuredClone(shard);
  const applied = [];
  const errors = [];
  const seenValues = new Map();

  (Array.isArray(edits) ? edits : []).forEach((edit, index) => {
    const label = describeEdit(edit, index);
    const shapeErrors = validateResponseSchema(edit, CAREER_PROFILE_EDIT_SCHEMA);
    if (shapeErrors.length) {
      errors.push(`${label}: does not match the edit schema: ${schemaErrorText(shapeErrors)}`);
      return;
    }
    const parsed = parseEditValue(edit);
    if (!parsed.ok) {
      errors.push(`${label}: ${parsed.error}`);
      return;
    }
    const targetKey = editTargetKey(edit);
    const canonicalValue = edit.op === 'remove' ? '<remove>' : canonicalJson(parsed.value);
    if (seenValues.has(targetKey)) {
      if (seenValues.get(targetKey) !== canonicalValue) {
        errors.push(`${label}: conflicts with an earlier edit to ${edit.group}/${edit.entityId}/${targetKey.split('\u0000')[2]} that proposes a different value`);
      }
      // An identical duplicate is the same proposal; apply it only once.
      return;
    }
    seenValues.set(targetKey, canonicalValue);
    const { group, entityId, op } = edit;
    const value = parsed.value;

    if (op === 'set' || op === 'set-coverage') {
      const field = op === 'set-coverage' ? 'disposition' : edit.field;
      if (op === 'set-coverage' && group !== 'segmentCoverage') {
        errors.push(`${label}: set-coverage is only valid for group segmentCoverage`);
        return;
      }
      if (op === 'set-coverage' && edit.field !== '' && edit.field !== 'disposition') {
        errors.push(`${label}: set-coverage field must be '' or 'disposition'`);
        return;
      }
      if (!CAREER_PROFILE_EDITABLE_FIELDS[group].includes(field)) {
        errors.push(`${label}: field '${field}' is not editable for ${group}; editable fields: ${CAREER_PROFILE_EDITABLE_FIELDS[group].join(', ')}`);
        return;
      }
      let entity;
      if (group === 'identity') {
        if (entityId !== 'identity') {
          errors.push(`${label}: identity edits must use entityId 'identity'`);
          return;
        }
        if (!working.identity || typeof working.identity !== 'object') working.identity = { name: '', contacts: [], evidenceSegmentIds: [] };
        entity = working.identity;
      } else {
        const indexes = locate(working, group, entityId);
        if (indexes.length === 0) {
          errors.push(group === 'segmentCoverage'
            ? `${label}: segment ${entityId} has no segmentCoverage record`
            : `${label}: ${group} has no entity with ${idFieldFor(group)} '${entityId}'`);
          return;
        }
        if (indexes.length > 1) {
          errors.push(`${label}: ${group} has ${indexes.length} records with ${idFieldFor(group)} '${entityId}'; the target is ambiguous`);
          return;
        }
        entity = working[group][indexes[0]];
      }
      const fieldErrors = validateResponseSchema(value, fieldSchemaFor(group, field));
      if (fieldErrors.length) {
        errors.push(`${label}: value for ${group}/${entityId}/${field} is invalid: ${schemaErrorText(fieldErrors)}`);
        return;
      }
      const before = entity[field] === undefined ? undefined : structuredClone(entity[field]);
      if (canonicalJson(before) === canonicalJson(value)) {
        errors.push(`${label}: edit to ${group}/${entityId}/${field} proposes no change`);
        return;
      }
      entity[field] = structuredClone(value);
      applied.push({ edit, targetKey, before, after: structuredClone(value) });
      return;
    }

    if (group === 'identity') {
      errors.push(`${label}: identity cannot be added or removed; use set on its fields`);
      return;
    }
    const idField = idFieldFor(group);
    const indexes = locate(working, group, entityId);

    if (op === 'add') {
      const entityErrors = validateResponseSchema(value, itemSchemaFor(group));
      if (entityErrors.length) {
        errors.push(`${label}: entity for ${group}/${entityId} is invalid: ${schemaErrorText(entityErrors)}`);
        return;
      }
      if (value[idField] !== entityId) {
        errors.push(`${label}: entity ${idField} '${value[idField]}' does not match entityId '${entityId}'`);
        return;
      }
      if (ENTITY_GROUPS.includes(group) && !String(entityId).startsWith(entityIdPrefix)) {
        errors.push(`${label}: new ${group} id '${entityId}' must start with page prefix '${entityIdPrefix}'`);
        return;
      }
      if (indexes.length > 0) {
        errors.push(`${label}: ${group} already has a record with ${idField} '${entityId}'`);
        return;
      }
      if (!Array.isArray(working[group])) working[group] = [];
      working[group].push(structuredClone(value));
      applied.push({ edit, targetKey, before: null, after: structuredClone(value) });
      return;
    }

    // remove
    if (indexes.length === 0) {
      errors.push(`${label}: ${group} has no entity with ${idField} '${entityId}' to remove`);
      return;
    }
    if (indexes.length > 1) {
      errors.push(`${label}: ${group} has ${indexes.length} records with ${idField} '${entityId}'; the target is ambiguous`);
      return;
    }
    const [removed] = working[group].splice(indexes[0], 1);
    applied.push({ edit, targetKey, before: removed, after: null });
  });

  if (errors.length) return { shard, applied: [], errors };
  return { shard: working, applied, errors };
}

export function normalizeQuoteText(text) {
  return String(text ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
}

export function verifySourceQuote(quote, segmentIds, segmentsById) {
  const normalizedQuote = normalizeQuoteText(quote);
  if (!normalizedQuote || !Array.isArray(segmentIds) || segmentIds.length === 0) return false;
  const lookup = id => (segmentsById instanceof Map ? segmentsById.get(id) : segmentsById?.[id]);
  const texts = [];
  for (const id of segmentIds) {
    const segment = lookup(id);
    if (!segment || typeof segment.text !== 'string') return false;
    texts.push(segment.text);
  }
  return normalizeQuoteText(texts.join(' ')).includes(normalizedQuote);
}

// ── Decision ledger ───────────────────────────────────────────────────────

function ledgerKey(pageIndex, targetKey) {
  return `${pageIndex}\u0000${targetKey}`;
}

function sortedUnion(existing, additions) {
  return [...new Set([...(existing || []), ...(additions || [])])].sort();
}

function targetRecord(ledger, pageIndex, targetKey) {
  const key = ledgerKey(pageIndex, targetKey);
  let record = ledger.targets.get(key);
  if (!record) {
    record = { pageIndex, targetKey, current: null, supersededDecisionIds: [], consideredEvidenceSegmentIds: [] };
    ledger.targets.set(key, record);
  }
  return record;
}

export function createDecisionLedger() {
  return { version: 1, targets: new Map() };
}

export function recordDecision(ledger, {
  pageIndex, targetKey, value, sourceQuote, evidenceSegmentIds, category, round, origin, findingDetail, groupId,
}) {
  if (!DECISION_ORIGINS.has(origin)) throw new TypeError(`Unknown decision origin '${origin}'`);
  if (groupId !== undefined && (typeof groupId !== 'string' || groupId === '')) {
    throw new TypeError('Decision groupId must be a non-empty string when given');
  }
  const valueJson = canonicalJson(value);
  const evidence = sortedUnion([], evidenceSegmentIds);
  const id = `decision-${sha256(canonicalJson({ pageIndex, targetKey, round, valueJson })).slice(0, 16)}`;
  const decision = {
    id, groupId: groupId ?? id, pageIndex, targetKey, value: structuredClone(value), valueJson,
    sourceQuote: sourceQuote ?? '', evidenceSegmentIds: evidence,
    category: category ?? '', round, origin, findingDetail: findingDetail ?? '',
  };
  const record = targetRecord(ledger, pageIndex, targetKey);
  if (record.current && record.current.id !== id) record.supersededDecisionIds.push(record.current.id);
  record.current = decision;
  record.consideredEvidenceSegmentIds = sortedUnion(record.consideredEvidenceSegmentIds, evidence);
  return decision;
}

export function decisionForTarget(ledger, pageIndex, targetKey) {
  return ledger.targets.get(ledgerKey(pageIndex, targetKey))?.current || null;
}

export function recordChallengeEvidence(ledger, pageIndex, targetKey, evidenceSegmentIds) {
  const record = targetRecord(ledger, pageIndex, targetKey);
  record.consideredEvidenceSegmentIds = sortedUnion(record.consideredEvidenceSegmentIds, evidenceSegmentIds);
  return [...record.consideredEvidenceSegmentIds];
}

function settledRecordsForEdit(ledger, pageIndex, edit) {
  if (edit?.op === 'add' || edit?.op === 'remove') {
    const prefix = `${edit.group}\u0000${edit.entityId}\u0000`;
    return [...ledger.targets.values()]
      .filter(record => record.pageIndex === pageIndex && record.current && record.targetKey.startsWith(prefix))
      .sort((left, right) => (left.targetKey < right.targetKey ? -1 : left.targetKey > right.targetKey ? 1 : 0));
  }
  const record = ledger.targets.get(ledgerKey(pageIndex, editTargetKey(edit)));
  return record?.current ? [record] : [];
}

// A decision recorded before group support has no groupId; it is its own group.
function decisionGroupId(decision) {
  return typeof decision?.groupId === 'string' && decision.groupId ? decision.groupId : decision?.id;
}

/**
 * A settled target may be challenged by naming its decision id or the groupId
 * shared by a coordinated set of decisions; either way every challenged target
 * still needs at least one challenge evidence segment not yet considered.
 */
export function checkFindingAgainstLedger(ledger, pageIndex, finding, edits = finding?.edits) {
  const errors = [];
  const challengedDecisions = [];
  const challenge = finding?.challenge || { decisionId: '', evidenceSegmentIds: [] };
  const challengeId = typeof challenge.decisionId === 'string' ? challenge.decisionId : '';
  const challengeEvidence = Array.isArray(challenge.evidenceSegmentIds) ? challenge.evidenceSegmentIds : [];
  const checked = new Set();

  for (const edit of Array.isArray(edits) ? edits : []) {
    for (const record of settledRecordsForEdit(ledger, pageIndex, edit)) {
      const decision = record.current;
      if (checked.has(decision.id)) continue;
      checked.add(decision.id);
      const where = record.targetKey.split('\u0000').map(part => part || "''").join('/');
      const evidenceText = decision.evidenceSegmentIds.join(', ') || 'none';
      const groupId = decisionGroupId(decision);
      const groupText = groupId === decision.id ? '' : ` in group ${groupId}`;
      if (challengeId === '') {
        errors.push(`${where} is settled by ${decision.id}${groupText} (value ${decision.valueJson}; evidence ${evidenceText}). Drop this finding, or challenge ${decision.id}${groupId === decision.id ? '' : ` or ${groupId}`} with evidence segments not yet considered.`);
        continue;
      }
      if (challengeId !== decision.id && challengeId !== groupId) {
        errors.push(`challenge names ${challengeId} but ${where} is currently settled by ${decision.id}${groupText} (value ${decision.valueJson}; evidence ${evidenceText}).`);
        continue;
      }
      const considered = new Set(record.consideredEvidenceSegmentIds);
      if (!challengeEvidence.some(id => !considered.has(id))) {
        errors.push(`challenge of ${decision.id} on ${where} cites no new evidence; already considered: ${record.consideredEvidenceSegmentIds.join(', ') || 'none'}.`);
        continue;
      }
      challengedDecisions.push(decision);
    }
  }
  return { ok: errors.length === 0, errors, challengedDecisions };
}

function canonicalEditValue(edit) {
  if (edit?.op === 'remove') return '<remove>';
  const parsed = parseEditValue(edit);
  return parsed.ok ? canonicalJson(parsed.value) : `<raw>${edit?.valueJson}`;
}

export function findConflictingEdits(entries) {
  const groups = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const targetKey = editTargetKey(entry.edit);
    const key = ledgerKey(entry.pageIndex, targetKey);
    if (!groups.has(key)) groups.set(key, { pageIndex: entry.pageIndex, targetKey, entries: [] });
    groups.get(key).entries.push(entry);
  }
  return [...groups.values()]
    .filter(group => new Set(group.entries.map(entry => canonicalEditValue(entry.edit))).size > 1)
    .sort((left, right) => (left.pageIndex - right.pageIndex)
      || (left.targetKey < right.targetKey ? -1 : left.targetKey > right.targetKey ? 1 : 0));
}

export function decisionsForPage(ledger, pageIndex) {
  return [...ledger.targets.values()]
    .filter(record => record.pageIndex === pageIndex && record.current)
    .sort((left, right) => (left.targetKey < right.targetKey ? -1 : left.targetKey > right.targetKey ? 1 : 0))
    .map(({ current }) => ({
      id: current.id,
      groupId: decisionGroupId(current),
      targetKey: current.targetKey,
      valueJson: current.valueJson,
      evidenceSegmentIds: [...current.evidenceSegmentIds],
      origin: current.origin,
      round: current.round,
    }));
}

export function serializeDecisionLedger(ledger) {
  const targets = [...ledger.targets.values()]
    .sort((left, right) => (left.pageIndex - right.pageIndex)
      || (left.targetKey < right.targetKey ? -1 : left.targetKey > right.targetKey ? 1 : 0));
  return canonicalJson({ version: 1, targets });
}

export function deserializeDecisionLedger(json) {
  const parsed = typeof json === 'string' ? JSON.parse(json) : json;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.targets)) {
    throw new TypeError('Not a version 1 career-profile decision ledger.');
  }
  const ledger = createDecisionLedger();
  for (const record of parsed.targets) {
    if (!Number.isInteger(record?.pageIndex) || typeof record?.targetKey !== 'string') {
      throw new TypeError('Decision ledger target is missing pageIndex or targetKey.');
    }
    ledger.targets.set(ledgerKey(record.pageIndex, record.targetKey), {
      pageIndex: record.pageIndex,
      targetKey: record.targetKey,
      current: record.current || null,
      supersededDecisionIds: Array.isArray(record.supersededDecisionIds) ? [...record.supersededDecisionIds] : [],
      consideredEvidenceSegmentIds: sortedUnion([], record.consideredEvidenceSegmentIds),
    });
  }
  return ledger;
}
