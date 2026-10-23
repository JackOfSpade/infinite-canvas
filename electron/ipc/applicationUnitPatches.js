import { normalizeBoundDocumentText } from './pasteApplicationAssembly.js';
import { isUnsafeControlCharacter } from './structuredResume.js';
/** Pure correction mechanics. The shared kind table remains in applicationWriteVerify. */
import { createHash } from 'node:crypto';
import { WRITE_VERIFY_UNIT_KINDS } from './applicationWriteVerify.js';
import { boundedDetailValue } from './coverLetterChecks.js';

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const canonical = value => Array.isArray(value) ? `[${value.map(item => canonical(item) ?? 'null').join(',')}]`
  : object(value) ? `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a, b) => canonical(a) === canonical(b);
const own = value => JSON.stringify(boundedDetailValue(String(value ?? '')));
// Read the table only inside functions: the prompt module also uses these pure
// helpers, and neither side dereferences its import during module setup.
const metadata = kind => WRITE_VERIFY_UNIT_KINDS.find(([, , , meta]) => meta.kind === kind)?.[3];

// The existing argument-evidence predicate, shared without changing its
// normalization, containment or five-token/60-percent acceptance rules.
function normalizedBindingText(value) {
  const cleaned = Array.from(String(value ?? ''), char => char === '\r' || isUnsafeControlCharacter(char) ? ' ' : char).join('').replace(/\r\n?/g, '\n').slice(0, 1_000_000);
  return normalizeBoundDocumentText(cleaned).toLowerCase();
}
export function argumentEvidenceMatchesBullet(evidence, bullet) {
  const candidate = normalizedBindingText(evidence), finalText = normalizedBindingText(bullet);
  const tokens = value => normalizedBindingText(value).match(/[\p{L}\p{N}]+/gu) || [];
  const expected = [...new Set(tokens(candidate))], available = new Set(tokens(finalText));
  const coverage = expected.length ? expected.filter(token => available.has(token)).length / expected.length : 0;
  return candidate === finalText || candidate.includes(finalText) || finalText.includes(candidate)
    || (tokens(candidate).length >= 5 && coverage >= 0.6);
}

export function applicationUnitRegistry(documents) {
  const rows = [], errors = [], seen = new Set();
  if (Array.isArray(documents?.resume?.roles) && documents.resume.roles.some(role => !object(role))) errors.push('Resume roles contains a non-object context.');
  for (const [label, pick, , meta] of WRITE_VERIFY_UNIT_KINDS) {
    let entries;
    try { entries = pick(documents); } catch { errors.push(`${label} is not an array of units.`); continue; }
    if (!Array.isArray(entries)) { errors.push(`${label} is not an array of units.`); continue; }
    for (const entry of entries) {
      if (!object(entry)) { errors.push(`${label} contains a non-object unit.`); continue; }
      const id = entry.id;
      if (!nonblank(id)) { errors.push(`${label} contains an empty or non-string unit id.`); continue; }
      if ((!meta.pseudo && id.startsWith('@')) || seen.has(id)) errors.push(`Unit ${own(id)} has a reserved or duplicate id.`);
      seen.add(id);
      const fields = Object.fromEntries(meta.fields.filter(field => Object.hasOwn(entry, field)).map(field => [field, structuredClone(entry[field])]));
      const role = meta.kind === 'bullet' ? (Array.isArray(documents?.resume?.roles) ? documents.resume.roles : []).find(role => Array.isArray(role?.bullets) && role.bullets.includes(entry)) : null;
      rows.push({ id, kind: meta.kind, doc: meta.doc, ...(role ? { roleId: role.id } : {}), fields });
    }
  }
  if (!nonblank(documents?.coverLetter?.roleThesis)) errors.push('The letter roleThesis is missing.');
  if (!object(documents?.coverLetter?.coverLetterArgument?.primaryEvidence)) errors.push('The letter primary argument slot is missing.');
  return { rows, errors };
}
export const unitDigest = row => digest(row.fields);
export const structuredDocumentDigest = documents => digest({ resume: documents?.resume, coverLetter: documents?.coverLetter });
export function diffUnits(before, after) {
  const a = new Map(applicationUnitRegistry(before).rows.map(row => [row.id, row]));
  const b = new Map(applicationUnitRegistry(after).rows.map(row => [row.id, row]));
  return { changed: [...a].filter(([id, row]) => b.has(id) && !same(row.fields, b.get(id).fields)).map(([id]) => id),
    removed: [...a.keys()].filter(id => !b.has(id)), added: [...b.keys()].filter(id => !a.has(id)) };
}
export function argumentBindings(documents, argumentMatches = argumentEvidenceMatchesBullet) {
  const bullets = applicationUnitRegistry(documents).rows.filter(row => row.kind === 'bullet');
  return Object.fromEntries(['primary', 'secondary'].map(slot => {
    const evidence = documents?.coverLetter?.coverLetterArgument?.[`${slot}Evidence`]?.evidence;
    return [slot, nonblank(evidence) ? bullets.find(row => argumentMatches(evidence, row.fields.text))?.id || null : null];
  }));
}
export function renderedUnitCharacters(row) {
  if (metadata(row.kind)?.pseudo) return 0;
  return Object.entries(row.fields).reduce((sum, [field, value]) => sum + (field === 'evidenceIds' ? 0 : typeof value === 'string' ? value.length : Array.isArray(value) ? value.reduce((n, text) => n + String(text).length, 0) : 0), 0);
}
function documentCharacters(registry, doc) { return registry.rows.filter(row => row.doc === doc).reduce((sum, row) => sum + renderedUnitCharacters(row), 0); }
function location(documents, row) {
  const meta = metadata(row.kind);
  if (row.kind === 'thesis') return { object: documents.coverLetter, field: 'roleThesis' };
  if (meta.slot) return { object: documents.coverLetter.coverLetterArgument, field: `${meta.slot}Evidence` };
  const array = row.kind === 'bullet' ? documents.resume.roles.find(role => role.id === row.roleId)?.bullets : documents[row.doc]?.[meta.collection];
  const index = array?.findIndex(unit => unit?.id === row.id) ?? -1;
  return { array, index, object: index >= 0 ? array[index] : null };
}
const orderedSubset = (before, after) => {
  let position = 0;
  for (const item of after) { const at = before.indexOf(item, position); if (at < 0) return false; position = at + 1; }
  return true;
};

export function mergeUnitPatches(documents, patches, { open = [], registry = applicationUnitRegistry(documents), shortenOnly = false,
  argumentMatches = argumentEvidenceMatchesBullet, roleLabel = role => `${role?.title || ''}${role?.company ? ` at ${role.company}` : ''}`, knownBad = {} } = {}) {
  const errors = [], next = structuredClone(documents), openSet = new Set(open), byId = new Map(registry.rows.map(row => [row.id, row]));
  const add = (code, unit, index, text) => errors.push({ code, unit, index, text: `unit-patch: ${text}` });
  const refused = () => ({ documents, changed: [], removed: [], errors });
  if (registry.errors.length) { add('registry', null, -1, 'the current documents have no unambiguous unit registry; use a document round.'); return refused(); }
  if (!Array.isArray(patches) || !patches.length || patches.length > 64) { add('shape', null, -1, 'patches is not a non-empty array of at most 64 patches.'); return refused(); }
  const seen = new Map(), explicitBindings = new Map(), removedBullets = [], deferredNoOps = [];
  const bindings = argumentBindings(documents, argumentMatches);
  for (const [i, patch] of patches.entries()) {
    const id = patch?.unit;
    if (!object(patch) || !nonblank(id) || !['set', 'remove'].includes(patch.op)
      || Object.keys(patch).some(key => !['unit', 'op', ...(patch.op === 'set' ? ['fields'] : [])].includes(key))
      || (patch.op === 'set' && (!object(patch.fields) || !Object.keys(patch.fields).length))) {
      add('shape', id, i, `patches[${i}] is not an object with unit, op and (for set) fields.`); continue;
    }
    const row = byId.get(id);
    if (!row) { add('unknown', id, i, `patches[${i}] names unit ${own(id)}, which is not a unit of the current documents.`); continue; }
    if (seen.has(id)) { add('duplicate', id, i, `patches[${seen.get(id)}] and patches[${i}] both name unit ${own(id)}; one patch per unit.`); continue; }
    seen.set(id, i);
    if (!openSet.has(id)) { add('settled', id, i, `patches[${i}] changes unit ${own(id)}, which no check named in the last round; it is settled and stays as it is. Units open this round: ${[...openSet].join(', ')}.`); continue; }
    const meta = metadata(row.kind), at = location(next, row);
    if (patch.op === 'remove') {
      if (row.kind === 'thesis' || meta.slot === 'primary') { add('floor', id, i, `patches[${i}] cannot remove unit ${own(id)}.`); continue; }
      if ((row.kind === 'bullet' || row.kind === 'paragraph') && at.array.length <= 1) {
        add('floor', id, i, `patches[${i}] removes unit ${own(id)}, the last ${row.kind === 'bullet' ? `bullet of role ${own(row.roleId)}` : 'paragraph of the letter'}; a role keeps at least one bullet and the letter at least one paragraph.`); continue;
      }
      if (meta.slot) delete at.object[at.field];
      else at.array.splice(at.index, 1);
      if (row.kind === 'bullet') removedBullets.push({ id, index: i });
      continue;
    }
    const beforeErrors = errors.length;
    let changed = false;
    for (const [field, value] of Object.entries(patch.fields)) {
      if (!meta.editable.includes(field)) { add('field', id, i, `patches[${i}] sets field ${own(field)} on unit ${own(id)}; a ${row.kind} unit takes ${meta.editable.join(', ')}.`); continue; }
      const arrayField = field === 'evidenceIds' || field === 'items';
      if (arrayField ? !Array.isArray(value) || !value.length || value.some(item => !nonblank(item)) || new Set(value).size !== value.length : !nonblank(value)) {
        add('value', id, i, `patches[${i}] field ${own(field)} of unit ${own(id)} must be ${arrayField ? 'a non-empty array of distinct non-empty strings' : 'nonempty text'}.`); continue;
      }
      const previous = field === 'bullet' && meta.slot ? bindings[meta.slot] : row.fields[field];
      if (!same(previous, value)) changed = true;
      if (shortenOnly && !meta.pseudo && field !== 'evidenceIds') {
        if (arrayField && !orderedSubset(Array.isArray(previous) ? previous : [], value)) { add('shorten', id, i, `patches[${i}] adds an element to field ${own(field)} of unit ${own(id)}; a fit correction keeps an ordered subset.`); continue; }
        if (!arrayField && value.length > String(previous || '').length) { add('shorten', id, i, `patches[${i}] lengthens field ${own(field)} of unit ${own(id)} from ${String(previous || '').length} to ${value.length} characters; a fit correction only shortens or removes.`); continue; }
      }
      if (field === 'bullet' && meta.slot) explicitBindings.set(meta.slot, { bullet: value, index: i });
      else if (row.kind === 'thesis') at.object[at.field] = value;
      else if (meta.slot) at.object[at.field][field] = structuredClone(value);
      else at.object[field] = structuredClone(value);
    }
    if (errors.length === beforeErrors && !changed) {
      if (meta.slot && Object.hasOwn(patch.fields, 'bullet')) deferredNoOps.push({ id, index: i });
      else add('no-op', id, i, `patches[${i}] leaves unit ${own(id)} as it is: ${Object.keys(patch.fields).join(', ')} already equal the patch value.`);
    }
  }
  // Resolve only explicit rebindings or a formerly bound bullet that changed.
  // This copies the host-owned current bullet; it never invents argument text.
  for (const slot of ['primary', 'secondary']) {
    const item = next.coverLetter?.coverLetterArgument?.[`${slot}Evidence`];
    if (!item) continue;
    const requested = explicitBindings.get(slot), bulletId = requested?.bullet || bindings[slot];
    if (!bulletId) continue;
    const bullet = applicationUnitRegistry(next).rows.find(row => row.kind === 'bullet' && row.id === bulletId);
    if (!bullet) {
      const removed = removedBullets.find(row => row.id === bulletId);
      if (removed) add('bound', bulletId, removed.index, `patches[${removed.index}] removes bullet ${own(bulletId)}, which @argument.${slot} is bound to; patch ${own(`@argument.${slot}`)} to a different bullet in the same answer.`);
      else if (requested) add('binding', `@argument.${slot}`, requested.index, `patches[${requested.index}] names bullet ${own(bulletId)}, which is not a bullet of the merged resume.`);
      continue;
    }
    if (requested || !argumentMatches(item.evidence, bullet.fields.text)) {
      item.evidence = bullet.fields.text;
      const role = next.resume.roles.find(role => role.id === bullet.roleId);
      item.evidenceRole = roleLabel(role);
    }
  }
  const finalRegistry = applicationUnitRegistry(next);
  // A same-bullet rebind can still repair stale evidence text or evidenceRole.
  // Judge that no-op only after the host has materialized the binding.
  for (const { id, index } of deferredNoOps) {
    const final = finalRegistry.rows.find(row => row.id === id);
    if (!errors.some(error => error.index === index) && final && same(byId.get(id).fields, final.fields))
      add('no-op', id, index, `patches[${index}] leaves unit ${own(id)} as it is: ${Object.keys(patches[index].fields).join(', ')} already equal the patch value.`);
  }
  for (const [id, i] of seen) {
    if (patches[i].op !== 'set') continue;
    const row = finalRegistry.rows.find(row => row.id === id);
    if (!row) continue;
    const previous = (knownBad instanceof Map ? knownBad.get(id) : Object.hasOwn(knownBad, id) ? knownBad[id] : []) || [];
    const repeated = (Array.isArray(previous) ? previous : []).find(entry => entry.digest12 === unitDigest(row).slice(0, 12) || entry.digest === unitDigest(row));
    if (repeated) add('known-bad', id, i, `patches[${i}] sets unit ${own(id)} to a text it already held when check ${own(repeated.checkId)} named it in round ${repeated.round}; that check reads only this unit own text, so the verdict would repeat.`);
  }
  if (shortenOnly && !errors.length) {
    const failing = new Set(registry.rows.filter(row => openSet.has(row.id) && !metadata(row.kind).pseudo).map(row => row.doc));
    for (const doc of failing) {
      const before = documentCharacters(registry, doc), after = documentCharacters(finalRegistry, doc);
      if (after >= before) add('shorten', null, -1, `The patches leave the ${doc} at ${after} unit characters against ${before} before; a fit correction must remove characters.`);
    }
  }
  if (errors.length) return refused();
  const difference = diffUnits(documents, next);
  return { documents: next, changed: difference.changed, removed: difference.removed, errors };
}

export function openUnits({ tier, findings = [], registry, fitMeasurement = null, factFindings = [], previousOpen = [], argumentBindings: bindings = {} }) {
  const ids = new Set(), add = id => { if (registry.rows.some(row => row.id === id)) ids.add(id); };
  const openDoc = doc => registry.rows.filter(row => !doc || row.doc === doc).forEach(row => add(row.id));
  if (tier === 'environment' || registry.errors.length) openDoc(null);
  for (const finding of findings) {
    [...(finding.units || []), ...(finding.implicated || [])].forEach(add);
    if (['structure', 'document'].includes(finding.scope) && !finding.units?.length) openDoc(null);
    if (finding.openKinds === 'all-resume') openDoc('resume');
    if (finding.openKinds === 'all-letter') openDoc('coverLetter');
  }
  if (tier === 'fit' && fitMeasurement) {
    const rows = Array.isArray(fitMeasurement) ? fitMeasurement : Object.entries(fitMeasurement).map(([document, value]) => ({ document, ...value }));
    for (const row of rows) if (row.pageCount > 1 || row.layoutIssues?.length || row.horizontalOverflowCount > 0
      || (Number.isFinite(row.contentHeightPx) && Number.isFinite(row.typeAreaHeightPx) && row.contentHeightPx > row.typeAreaHeightPx)) openDoc(row.document === 'cover-letter' ? 'coverLetter' : row.document);
  }
  if (tier === 'fact') { factFindings.forEach(finding => add(finding.id)); previousOpen.forEach(add); }
  for (const slot of ['primary', 'secondary']) if (ids.has(bindings[slot])) add(`@argument.${slot}`);
  return registry.rows.map(row => row.id).filter(id => ids.has(id));
}

export const UNIT_PATCH_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false,
  required: ['protocol', 'jobId', 'stage', 'handoffCode', 'baseHashes', 'patches'], properties: {
    protocol: { const: 1 }, jobId: { type: 'string' }, stage: { enum: ['verify-correction', 'fit-correction', 'fact-correction'] },
    handoffCode: { type: ['string', 'null'] }, baseHashes: { type: 'object' }, patches: { type: 'array', minItems: 1, maxItems: 64,
      items: { oneOf: [
        { type: 'object', additionalProperties: false, required: ['unit', 'op', 'fields'], properties: { unit: { type: 'string' }, op: { const: 'set' }, fields: { type: 'object', minProperties: 1 } } },
        { type: 'object', additionalProperties: false, required: ['unit', 'op'], properties: { unit: { type: 'string' }, op: { const: 'remove' } } },
      ] } },
  } });
