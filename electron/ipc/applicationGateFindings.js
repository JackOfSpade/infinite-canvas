import { applicationUnitRegistry, argumentBindings, argumentEvidenceMatchesBullet, openUnits, structuredDocumentDigest, unitDigest } from './applicationUnitPatches.js';
import { CHECK_DISPOSITIONS } from './coverLetterChecks.js';
import { RESUME_CHECK_DISPOSITIONS } from './resumeCheckDispositions.js';
import { dashPunctuationProblems } from './resumeHtml.js';

export const PASTE_RESUME_REPLACEMENT_PREFIX = 'Résumé replacement — ';
export const PASTE_COVER_REPLACEMENT_PREFIX = 'Cover-letter replacement — ';
export const PASTE_RESUME_REBIND_PREFIX = 'Résumé replacement versus the accepted cover letter — ';
export const PASTE_RESUME_PROSE_FAILURE_PREFIX = 'Local AI résumé failed editorial checks: ';
export const PASTE_COVER_CHECK_FAILURE_PREFIX = 'Local AI cover letter failed required checks: ';
export const PASTE_DOCUMENT_PREFIX_STAGES = Object.freeze([
  [PASTE_RESUME_REPLACEMENT_PREFIX, 'resume'],
  [PASTE_RESUME_PROSE_FAILURE_PREFIX, 'resume'],
  [PASTE_COVER_REPLACEMENT_PREFIX, 'cover-letter'],
  [PASTE_COVER_CHECK_FAILURE_PREFIX, 'cover-letter'],
]);

export const PASTE_VALIDATION_ERROR_ID_SET = new Set([
  'fact-findings-shape', 'fact-finding-shape', 'fact-finding-unit', 'fact-finding-claim', 'fact-finding-span', 'fact-finding-reason', 'judge-ranking-shape', 'judge-ranking-set', 'judge-ranking-reason', 'fact-check-unchanged',
  'unit-patch', 'document-repeat',
  'unsupported-experience-span', 'unit-source-grounding',
  'host-owned-field-equality', 'candidate-dash-punctuation',
  'structured-resume', 'paragraph-argument-links', 'measured-one-page-fit', 'schema-invalid',
  'handoff-echo-protocol', 'handoff-echo-job-id', 'handoff-echo-stage',
  'handoff-echo-code', 'handoff-echo-base-hashes',
]);
export const PASTE_VALIDATION_ERROR_PROSE_UNITS = Object.freeze({
  'unit-patch': 'field', 'document-repeat': 'field',
  'fact-findings-shape': 'field',
  'fact-finding-shape': 'field',
  'fact-finding-unit': 'field',
  'fact-finding-claim': 'field',
  'fact-finding-span': 'field',
  'fact-finding-reason': 'field',
  'judge-ranking-shape': 'field',
  'judge-ranking-set': 'field',
  'judge-ranking-reason': 'field',
  'fact-check-unchanged': 'field',

  'unsupported-experience-span': 'prose-unit',
  'unit-source-grounding': 'prose-unit',
  'candidate-dash-punctuation': 'prose-unit',
  'paragraph-argument-links': 'prose-unit',
  'host-owned-field-equality': 'field',
  'structured-resume': 'field',
  'measured-one-page-fit': 'field',
  'schema-invalid': 'field',
  'handoff-echo-protocol': 'field', 'handoff-echo-job-id': 'field',
  'handoff-echo-stage': 'field', 'handoff-echo-code': 'field',
  'handoff-echo-base-hashes': 'field',
});
export function inferredPasteValidationErrorId(message) {
  const value = String(message || '');
  const echoField = /^Application v2 response must echo the current (protocol|jobId|stage|handoffCode|baseHashes) exactly\.$/u.exec(value)?.[1];
  if (echoField) return { protocol: 'handoff-echo-protocol', jobId: 'handoff-echo-job-id',
    stage: 'handoff-echo-stage', handoffCode: 'handoff-echo-code', baseHashes: 'handoff-echo-base-hashes' }[echoField];
  if (/Continue the Local AI routine with measured revision \d+ using fit-feedback\.json/iu.test(value)) return 'measured-one-page-fit';
  if (/experience span|span of years|unsupported-experience-span/iu.test(value)) return 'unsupported-experience-span';
  if (/source.?grounding|source quote|career-data quote|cited evidence|career-data evidence|attribution scope/iu.test(value)) return 'unit-source-grounding';
  if (/trustedIdentity|host-owned|approved (?:role|project|identity|credential)|source role.*(?:title|company|dates|location)/iu.test(value)) return 'host-owned-field-equality';
  if (/dash punctuation|em dash|en dash|spaced hyphen|semicolon|colon used as sentence punctuation/iu.test(value)) return 'candidate-dash-punctuation';
  if (/argumentMapping|jobNeedQuote|argument span/iu.test(value)) return 'paragraph-argument-links';
  if (/structured r[ée]sum[ée]|resume (?:roles|bullets|projects|skills)|r[ée]sum[ée] (?:role|bullet|project|skill)/iu.test(value)) return 'structured-resume';
  return 'schema-invalid';
}

const row = (scope, strategy, extra = {}) => Object.freeze({ tier: 'content', scope, strategy, ...extra });
const unitRules = [
  'evidence-id-is-verified', 'evidence-includes-career-data', 'approved-skill-spelling', 'prose-names-approved-skill-its-evidence-does-not-state',
  'bullet-cites-own-role-career-section', 'project-field-occurs-in-cited-career-evidence', 'project-description-shares-career-evidence-terms',
  'skill-item-occurs-in-cited-career-evidence', 'skill-item-is-a-filterable-name', 'skill-group-label-claims-a-level',
  'education-field-occurs-in-cited-career-evidence', 'certification-field-occurs-in-cited-career-evidence',
  'education-dates-state-one-end-of-a-range', 'certification-dates-state-one-end-of-a-range',
];
export const GATE_FINDING_SCOPES = Object.freeze({
  ...Object.fromEntries([...PASTE_VALIDATION_ERROR_ID_SET].map(id => [id, row('field', 'control')])),
  ...Object.fromEntries(unitRules.map(id => [id, row('unit', 'suffix')])),
  'unit-source-grounding': row('unit', 'labels'),
  'unsupported-experience-span': row('unit', 'labels'),
  'candidate-dash-punctuation': row('unit', 'dash'),
  'structured-resume': row('structure', 'structured'),
  'schema-invalid': row('structure', 'structure'),
  'host-owned-field-equality': row('structure', 'structured'),
  shape: row('structure', 'structure'),
  'figure-discipline': row('unit-context', 'paragraph'),
  'target-company-binding': row('unit-context', 'paragraph'),
  'target-claim-scope': row('unit-context', 'paragraph-thesis'),
  'transfer-benefit-support': row('unit', 'paragraph'),
  'logistics-exclusion': row('unit', 'paragraph'),
  'containerization-technology-roles': row('unit-context', 'paragraph'),
  'ended-role-current-employment': row('unit-context', 'paragraph'),
  'role-thesis': row('field', 'thesis'),
  'evidence-grounding': row('field', 'argument'),
  'paragraph-argument-links': row('field', 'argument', { unreachable: 'write-verify v2 has no generationAudit' }),
  'measured-one-page-fit': row('cross', 'fit', { tier: 'fit' }),
  pasteResumeUnderfillErrors: row('cross', 'underfill', { openKinds: 'all-resume' }),
  pasteCoverLetterUnderfillErrors: row('cross', 'underfill', { openKinds: 'all-letter' }),
  currentAuthorityRoleProjectDuplicateErrors: row('cross', 'pair', { openKinds: 'pair' }),
  validateAuthorityResumeArtifacts: row('unit', 'labels'),
  validateLocalApplicationResult: row('document', 'completion'),
});
const namedSources = ['pasteResumeUnderfillErrors', 'pasteCoverLetterUnderfillErrors', 'currentAuthorityRoleProjectDuplicateErrors', 'validateAuthorityResumeArtifacts', 'validateLocalApplicationResult'];
export function gateFindingInventoryErrors({ letter = CHECK_DISPOSITIONS, resume = RESUME_CHECK_DISPOSITIONS, inventory = GATE_FINDING_SCOPES } = {}) {
  const errors = [], real = new Set([...Object.keys(letter), ...Object.keys(resume), ...PASTE_VALIDATION_ERROR_ID_SET, ...namedSources]);
  for (const [id, disposition] of [...Object.entries(letter), ...Object.entries(resume)]) if (disposition === 'gate' && !inventory[id]) errors.push(`Missing gate finding scope for ${id}.`);
  for (const id of [...PASTE_VALIDATION_ERROR_ID_SET, ...namedSources]) if (!inventory[id]) errors.push(`Missing validation source scope for ${id}.`);
  for (const id of Object.keys(inventory)) if (!real.has(id)) errors.push(`Unknown gate finding source ${id}.`);
  if (!inventory['paragraph-argument-links']?.unreachable) errors.push('paragraph-argument-links needs its v2 unreachable reason.');
  return errors;
}
const unique = values => [...new Set(values)];
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const withoutQuotedSpans = text => text.replace(new RegExp(`${String.fromCharCode(8220)}[^${String.fromCharCode(8221)}]*${String.fromCharCode(8221)}`, 'gu'), '');
const prefixed = /^([a-z][a-z0-9-]*):\s/u;

function labels(text, registry) {
  const found = [];
  for (const match of text.matchAll(/(?:R[ée]sum[ée] bullet|Resume bullet|Cover-letter paragraph)\s+("(?:[^"\\]|\\.)*")/gu)) {
    try { const id = JSON.parse(match[1]); if (registry.rows.some(row => row.id === id)) found.push(id); } catch { /* malformed own label remains unlocated */ }
  }
  for (const match of text.matchAll(/Resume (?:bullet|project|education|credential|skill group) ([^:]+):/gu)) if (registry.rows.some(row => row.id === match[1])) found.push(match[1]);
  for (const item of [...registry.rows].sort((a, b) => b.id.length - a.id.length)) {
    if (new RegExp(`(?:R[ée]sum[ée] bullet|Resume bullet|Cover-letter paragraph)\\s+${escape(item.id)}(?=\\s|:|$)`, 'u').test(text)) found.push(item.id);
  }
  return unique(found);
}
function suffix(text, registry) {
  const list = /\bUnits:\s*(.+)\.\s*$/u.exec(text)?.[1];
  return list ? list.split(', ').filter(id => registry.rows.some(row => row.id === id)) : [];
}
function pair(text, registry) {
  const match = /Resume role \S+ bullet (\S+) duplicates project (\S+)/u.exec(text);
  return match ? [match[1], match[2].replace(/[.;]$/u, '')].filter(id => registry.rows.some(row => row.id === id)) : [];
}
function authoredUnits(text, registry) {
  const slots = [...text.matchAll(/(?:coverLetterArgument\.)?(primary|secondary)Evidence\b/gu)].map(match => match[1]);
  for (const match of text.matchAll(/coverLetterArgument (?:evidenceRole|evidence) ([12])\b/gu)) slots.push(match[1] === '1' ? 'primary' : 'secondary');
  const ids = slots.map(slot => `@argument.${slot}`);
  if (/\broleThesis\b/u.test(text)) ids.push('@roleThesis');
  return unique(ids.filter(id => registry.rows.some(row => row.id === id)));
}
function paragraphUnits(text, documents, registry) {
  const paragraphs = Array.isArray(documents?.coverLetter?.paragraphs) ? documents.coverLetter.paragraphs : [];
  return unique([...text.matchAll(/paragraph\s+(\d+)\b/giu)].map(match => paragraphs[Number(match[1]) - 1]?.id).filter(id => registry.rows.some(row => row.kind === 'paragraph' && row.id === id)));
}

export function locateGateFindings({ errors = [], documents, registry, meta = {} }) {
  const findings = [];
  for (const raw of Array.isArray(errors) ? errors : []) {
    const original = String(raw || '');
    let message = original;
    for (const [prefix] of PASTE_DOCUMENT_PREFIX_STAGES) if (message.startsWith(prefix)) { message = message.slice(prefix.length); break; }
    for (const segment of message.split(' | ')) {
      const checkId = prefixed.exec(segment)?.[1] || inferredPasteValidationErrorId(segment);
      let descriptor = GATE_FINDING_SCOPES[checkId], scope = descriptor?.scope || 'document', tier = descriptor?.tier || 'content', units = [], openKinds = descriptor?.openKinds;
      const text = withoutQuotedSpans(segment);
      const repairs = meta[original]?.repairs || meta[segment]?.repairs || [];
      const ordinal = /sourceGrounding\.(resumeBullets|coverLetterParagraphs)\[(\d+)\]/u.exec(text);
      // Completion records name their consumer rather than a source check.
      // Their explicit repair targets/ordinals take precedence within this ID.
      if (ordinal) {
        const kind = ordinal[1] === 'resumeBullets' ? 'bullet' : 'paragraph';
        const item = registry.rows.filter(row => row.kind === kind)[Number(ordinal[2])];
        units = item ? [item.id] : []; scope = 'unit';
      } else if (repairs.length) {
        units = registry.rows.filter(row => repairs.includes(`${row.doc}:rendered`) ? !row.id.startsWith('@') : repairs.includes(`${row.doc}:authored`) && row.id.startsWith('@')).map(row => row.id);
        scope = 'cross';
      } else {
        // Dispatch by check ID, never by competing paragraph/path regexes.
        switch (descriptor?.strategy) {
          case 'suffix': units = unique([...suffix(text, registry), ...labels(text, registry)]); break;
          case 'labels': units = labels(text, registry); if (checkId === 'unit-source-grounding' && units.some(id => registry.rows.find(row => row.id === id)?.kind === 'paragraph')) scope = 'unit-context'; break;
          case 'structured': {
            const paired = pair(text, registry);
            units = unique([...paired, ...suffix(text, registry), ...labels(text, registry)]);
            if (paired.length) { scope = 'cross'; openKinds = 'pair'; } else if (units.length) scope = 'unit';
            break;
          }
          case 'pair': units = pair(text, registry); break;
          case 'paragraph': units = paragraphUnits(text, documents, registry); break;
          case 'paragraph-thesis':
            units = paragraphUnits(text, documents, registry);
            if (/\broleThesis\b/u.test(text) && registry.rows.some(row => row.id === '@roleThesis')) { units.push('@roleThesis'); if (units.length === 1) scope = 'field'; }
            break;
          case 'thesis': units = registry.rows.some(row => row.id === '@roleThesis') ? ['@roleThesis'] : []; break;
          case 'argument': units = authoredUnits(text, registry); break;
          case 'dash':
            units = registry.rows.filter(row => !row.id.startsWith('@') && Object.entries(row.fields).some(([field, value]) => field !== 'evidenceIds' && dashPunctuationProblems(Array.isArray(value) ? value.join(' ') : String(value || ''), '').length)).map(row => row.id);
            break;
          case 'fit': {
            if (/(?:render failed|could not render|fonts (?:did not|not)|render-failed|fonts-not-loaded)/iu.test(text)) { tier = 'environment'; scope = 'environment'; }
            else {
              const doc = /cover.?letter|\bletter\b/iu.test(text) ? 'coverLetter' : /r[ée]sum[ée]/iu.test(text) ? 'resume' : null;
              units = registry.rows.filter(row => !doc || row.doc === doc).map(row => row.id);
            }
            break;
          }
          default: break;
        }
        // Known aggregate sources do not always carry a check-id prefix.
        if (checkId === 'schema-invalid' || checkId === 'structured-resume') {
          const paired = pair(text, registry), authored = authoredUnits(text, registry), labelled = labels(text, registry);
          if (authored.length) { units = authored; scope = 'field'; }
          else if (labelled.length) { units = labelled; scope = 'unit'; }
          else if (paired.length) { units = paired; scope = 'cross'; openKinds = 'pair'; }
          else if (/underfill|too short|not enough (?:prose|paragraphs|bullets)/iu.test(text)) {
            const doc = /cover.?letter|\bletter\b/iu.test(text) ? 'coverLetter' : 'resume';
            units = registry.rows.filter(row => row.doc === doc).map(row => row.id); scope = 'cross';
          }
        }
      }
      if (!units.length && !['structure', 'environment', 'document'].includes(scope)) scope = 'document';
      findings.push({ checkId, tier, scope, units: unique(units), implicated: [], ...(openKinds ? { openKinds } : {}) });
    }
  }
  return findings;
}
export function roundMode(findings = [], registry = null) {
  if (findings.some(finding => finding.tier === 'environment')) return 'environment';
  return registry?.errors?.length || findings.some(finding => ['structure', 'document'].includes(finding.scope)) ? 'document' : 'patch';
}

export function bootstrapApplicationUnitState({ documents, corrections = [], status = 'correcting', tier = null, factFindings = [], previousOpen = [], argumentMatches = argumentEvidenceMatchesBullet }) {
  const registry = applicationUnitRegistry(documents), bindings = argumentBindings(documents, argumentMatches);
  let findings = tier === 'fact' ? factFindings.map(finding => ({ checkId: 'fact-check', tier: 'content', scope: 'unit', units: [finding.id], implicated: [] }))
    : locateGateFindings({ errors: corrections, documents, registry });
  if (!findings.length && tier !== 'fact' && status !== 'accepted') findings = [{ checkId: 'schema-invalid', tier: 'content', scope: 'document', units: [], implicated: [] }];
  const selectedTier = tier || (findings.some(finding => finding.tier === 'environment') ? 'environment'
    : status === 'fit-correcting' || findings.some(finding => finding.tier === 'fit') ? 'fit' : 'content');
  return { version: 1, round: 0, tier: selectedTier, mode: roundMode(findings, registry), digests: [structuredDocumentDigest(documents)], findings,
    open: openUnits({ tier: selectedTier, findings, registry, factFindings, previousOpen, argumentBindings: bindings }),
    argumentBindings: bindings, fitMeasurement: null, flagged: {} };
}
export function advanceApplicationUnitState({ previous = null, documents, gate, factFindings = [], argumentMatches = argumentEvidenceMatchesBullet }) {
  const registry = applicationUnitRegistry(documents), bindings = argumentBindings(documents, argumentMatches), findings = gate.errors.length ? gate.findings : [];
  const tier = findings.some(finding => finding.tier === 'environment') ? 'environment' : gate.fitErrors.length ? 'fit' : factFindings.length ? 'fact' : 'content';
  const round = previous ? previous.round + 1 : 0, flags = new Map(Object.entries(previous?.flagged || {}).filter(([, values]) => Array.isArray(values)).map(([id, values]) => [id, [...values]]));
  for (const finding of findings) if (finding.scope === 'unit') for (const id of finding.units) {
    const unit = registry.rows.find(row => row.id === id); if (!unit) continue;
    const entry = { checkId: finding.checkId, digest12: unitDigest(unit).slice(0, 12), round }, old = flags.get(id) || [];
    if (!old.some(item => item.checkId === entry.checkId && item.digest12 === entry.digest12)) flags.set(id, [...old, entry]);
  }
  return { version: 1, round, tier, mode: roundMode(findings, registry), digests: [...(previous?.digests || []), structuredDocumentDigest(documents)], findings,
    open: gate.errors.length ? openUnits({ tier, findings, registry, fitMeasurement: gate.fitMeasurement, factFindings, previousOpen: tier === 'fact' ? previous?.open || [] : [], argumentBindings: bindings }) : [],
    argumentBindings: bindings, fitMeasurement: gate.fitMeasurement || null, flagged: Object.fromEntries(flags) };
}

/** Source-free summary shared by live polling and stopped-card diagnostics. */
export function applicationUnitDiagnostics(work) {
  if (!work) return {};
  const modes = Object.fromEntries(['patch', 'document', 'environment'].map(mode => [mode,
    Number.isSafeInteger(work.unitModeCounts?.[mode]) && work.unitModeCounts[mode] >= 0 ? work.unitModeCounts[mode] : 0]));
  const stops = Object.fromEntries(['document-repeat', 'fit-no-progress'].map(kind => [kind,
    (work.candidates || []).filter(row => row.stopReason?.kind === kind).length]));
  return { unitPatchDiagnostics: { modes, stops } };
}
