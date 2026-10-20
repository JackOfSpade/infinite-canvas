import { assert } from './testHelpers.js';
import { pasteRejectionCheckIds } from '../../electron/ipc/localAiApplication.js';
import {
  CHECK_CLASSES, CHECK_DISPOSITIONS, CHECK_DISPOSITION_VALUES,
  checkDisposition, checkEvidenceGrounding, checkMappingNarrativeStructure,
  checkParagraphArgumentLinks, checkRoleThesis, evaluateCoverLetterChecks,
  partitionCheckResults,
} from '../../electron/ipc/coverLetterChecks.js';

const careers = [
  { work: 'maintained orchard routes for seasonal deliveries', need: 'seasonal deliveries', other: 'warehouse staffing' },
  { work: 'evaluated archive storage for fragile collections', need: 'fragile collections', other: 'ticket refunds' },
  { work: 'supported coastal surveys for harbour planning', need: 'harbour planning', other: 'restaurant inventory' },
];

const deadIds = new Set([
  'need-grounding', 'plan-mappings', 'plan-need-references', 'plan-redundancy',
  'all-needs-disposition', 'top-need-disposition', 'eligibility-need-disposition',
  'needs-portfolio', 'work-sample-link',
]);

export default [
  {
    name: 'Letter disposition table covers every emitted id, has no stray active key, and fails closed',
    run() {
      assert(JSON.stringify(CHECK_DISPOSITION_VALUES) === JSON.stringify(['gate', 'advisory', 'off']), 'the disposition vocabulary stays closed');
      const emitted = new Set([
        ...evaluateCoverLetterChecks().map(row => row.id),
        checkRoleThesis({}).id,
        checkMappingNarrativeStructure({}).id,
        checkEvidenceGrounding({}, {}).id,
        checkParagraphArgumentLinks({}).id,
        'role-thesis-shape', 'figure-count', 'letter-paragraph-ceiling',
        'paragraph-argument-shape', 'paragraph-argument-span-gaps', 'unsupported-experience-span',
      ]);
      for (const row of evaluateCoverLetterChecks()) {
        for (const part of row.parts || [row]) emitted.add(part.id);
      }
      for (const id of emitted) assert(Object.hasOwn(CHECK_DISPOSITIONS, id), `${id}: emitted but unclassified`);
      for (const [id, disposition] of Object.entries(CHECK_DISPOSITIONS)) {
        assert(emitted.has(id) || deadIds.has(id), `${id}: classified but never emitted`);
        assert(CHECK_DISPOSITION_VALUES.includes(disposition), `${id}: invalid disposition`);
        if (CHECK_CLASSES[id] === 'TRUTH') assert(disposition === 'gate', `${id}: truth remains a gate`);
        if (CHECK_CLASSES[id] === 'TASTE') assert(disposition !== 'gate', `${id}: taste never rejects`);
      }
      assert(checkDisposition('unclassified-new-check') === 'gate', 'unknown checks fail closed');
      assert(checkDisposition('figure-discipline', { 'figure-discipline': 'bogus' }) === 'gate', 'invalid entries fail closed');
    },
  },
  {
    name: 'Argument-mapping provenance blocks while optional shape only advises across three unrelated careers',
    run() {
      for (const career of careers) {
        const paragraph = `I ${career.work}.`;
        const posting = `We need ${career.need}.`;
        const mapped = mapping => checkParagraphArgumentLinks({
          plan: { paragraphs: [{ argumentMapping: mapping }] },
          paragraphs: [paragraph], postingQuoteText: posting, postingQuoteLabel: 'posting',
        });
        const faithful = partitionCheckResults([mapped({ proof: paragraph, jobNeedQuote: career.need })]);
        assert(faithful.blocking.length === 0 && faithful.advisory.some(item => item.id === 'paragraph-argument-shape'),
          `${career.work}: absent optional claim and relevance are advisory only`);
        const falseProof = partitionCheckResults([mapped({ proof: `I built ${career.need}`, jobNeedQuote: career.need })]);
        assert(falseProof.blocking.some(item => item.id === 'paragraph-argument-links'), `${career.work}: invented proof span blocks`);
        const falsePosting = partitionCheckResults([mapped({ proof: paragraph, jobNeedQuote: career.other })]);
        assert(falsePosting.blocking.some(item => item.id === 'paragraph-argument-links'), `${career.work}: invented posting span blocks`);
        const restored = partitionCheckResults([mapped({ proof: paragraph, jobNeedQuote: career.need })]);
        assert(restored.blocking.length === 0, `${career.work}: restoring source evidence flips the verdict`);
        const demoted = partitionCheckResults([mapped({ proof: `I built ${career.need}`, jobNeedQuote: career.need })],
          { ...CHECK_DISPOSITIONS, 'paragraph-argument-links': 'advisory' });
        assert(demoted.blocking.length === 0 && demoted.advisory.some(item => item.id === 'paragraph-argument-links'),
          `${career.work}: the injected disposition is what decides the verdict`);
      }
    },
  },
  {
    name: 'Production letter evaluation skips off checks while the full audit still enumerates them',
    run() {
      for (const career of careers) {
        const paragraph = `I ${career.work}.`;
        const input = { paragraphs: [paragraph], jobText: `We need ${career.need}.` };
        const full = evaluateCoverLetterChecks(input);
        const active = evaluateCoverLetterChecks({ ...input, activeOnly: true });
        assert(full.length > active.length, `${career.work}: audit enumerates more checks than production`);
        assert(active.every(row => checkDisposition(row.id) !== 'off'), `${career.work}: no off result was executed`);
        assert(active.every(row => full.some(other => other.id === row.id)), `${career.work}: active rows are a subset`);
      }
    },
  },
  {
    name: 'Paste rejection receipts attribute schema, grounding, equality, span, punctuation and duration errors without retaining career text',
    run() {
      for (const career of careers) {
        const source = career.work;
        const cases = [
          [`Cover-letter paragraph cites a career-data quote unrelated to ${source}.`, 'unit-source-grounding'],
          [`Resume role company does not equal context.trustedIdentity for ${source}.`, 'host-owned-field-equality'],
          [`argumentMapping.jobNeedQuote is not a span of the posting for ${source}.`, 'paragraph-argument-links'],
          [`Candidate copy has an em dash beside ${source}.`, 'candidate-dash-punctuation'],
          [`Résumé copy contains a semicolon beside ${source}.`, 'candidate-dash-punctuation'],
          [`Cover-letter copy contains a colon used as sentence punctuation beside ${source}.`, 'candidate-dash-punctuation'],
          [`Resume bullet claims an unsupported experience span for ${source}.`, 'unsupported-experience-span'],
          [`Resume roles contain a malformed bullet for ${source}.`, 'structured-resume'],
          [`Unrecognised envelope field for ${source}.`, 'schema-invalid'],
        ];
        for (const [message, expected] of cases) {
          const receipt = pasteRejectionCheckIds([message]);
          assert(receipt.uncodedErrors === 0 && receipt.checkIds.includes(expected), `${source}: ${expected} is attributed`);
          assert(!JSON.stringify(receipt).includes(source), `${source}: the receipt contains no career prose`);
          const changed = pasteRejectionCheckIds([message.replace(/experience span|em dash|semicolon|colon used as sentence punctuation|jobNeedQuote|career-data quote|trustedIdentity|Resume roles/iu, 'ordinary field')]);
          if (expected === 'unsupported-experience-span' || expected === 'candidate-dash-punctuation') {
            assert(!changed.checkIds.includes(expected), `${source}: changing the triggering words changes the attribution`);
          }
        }
      }
    },
  },
];
