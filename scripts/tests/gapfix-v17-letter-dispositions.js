import { assert } from './testHelpers.js';
import { __localizedCoverLetterCorrectiveGuidanceForTests, PASTE_CHECK_PROSE_UNITS, pasteRejectionCheckIds, pasteReportableCheckIds } from '../../electron/ipc/localAiApplication.js';
import { locateGateFindings } from '../../electron/ipc/applicationGateFindings.js';
import { cleanRuleTally, summarizeRuleTally } from '../../electron/ipc/applicationRuleTally.js';
import {
  CHECK_CLASSES, CHECK_DISPOSITIONS, CHECK_DISPOSITION_VALUES,
  checkDisposition, checkEvidenceGrounding,
  checkParagraphArgumentLinks, checkRoleThesis, evaluateCoverLetterChecks,
  partitionCheckResults,
} from '../../electron/ipc/coverLetterChecks.js';

const careers = [
  { work: 'maintained orchard routes for seasonal deliveries', need: 'seasonal deliveries', other: 'warehouse staffing' },
  { work: 'evaluated archive storage for fragile collections', need: 'fragile collections', other: 'ticket refunds' },
  { work: 'supported coastal surveys for harbour planning', need: 'harbour planning', other: 'restaurant inventory' },
];

export default [
  {
    name: 'Letter disposition table covers every emitted id, has no stray active key, and fails closed',
    run() {
      assert(JSON.stringify(CHECK_DISPOSITION_VALUES) === JSON.stringify(['gate', 'advisory']), 'the disposition vocabulary stays closed');
      const emitted = new Set([
        ...evaluateCoverLetterChecks().map(row => row.id),
        checkRoleThesis({}).id,
        checkEvidenceGrounding({}, {}).id,
        checkParagraphArgumentLinks({}).id,
        'role-thesis-shape', 'figure-count', 'letter-paragraph-ceiling',
        'paragraph-argument-shape', 'unsupported-experience-span',
      ]);
      for (const row of evaluateCoverLetterChecks()) {
        for (const part of row.parts || [row]) emitted.add(part.id);
      }
      for (const id of emitted) assert(Object.hasOwn(CHECK_DISPOSITIONS, id), `${id}: emitted but unclassified`);
      for (const [id, disposition] of Object.entries(CHECK_DISPOSITIONS)) {
        assert(emitted.has(id), `${id}: classified but never emitted`);
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
    name: 'Retired cover-letter checks are gone from the table and the battery, and every reader of a stored retired id tolerates it',
    run() {
      // Ids that were once judged 'off' and then deleted. Stored rule tallies, edit logs and archived runs may still name them.
      const retired = ['salient-phrase-echo', 'experience-infinitive-grammar', 'company-specificity', 'vague-domain-work-label', 'migration-object-clarity',
        'detached-relevance-claim', 'additive-seam', 'responsibility-transition', 'tool-calls-garden-path', 'low-information-tool-build',
        'dangling-paragraph-transition', 'plain-register', 'introductory-workplace-comma', 'visual-reference-precision', 'direct-welcome-closing',
        'opening-demonstrative', 'opening-employer-shorthand', 'adjacent-employer-repetition', 'entailed-premise', 'repeated-sentence-shape',
        'repeated-transfer-carrier', 'dangling-demonstrative', 'transfer-carrier-budget', 'mapping-narrative-structure', 'paragraph-argument-span-gaps'];
      const emitted = new Set(pasteReportableCheckIds());
      for (const id of retired) {
        assert(!Object.hasOwn(CHECK_DISPOSITIONS, id) && !emitted.has(id) && !Object.hasOwn(PASTE_CHECK_PROSE_UNITS, id), `${id}: a retired check is in no table and no battery`);
        // A stored id this build no longer knows is read as unknown, never as a throw.
        assert(checkDisposition(id) === 'gate', `${id}: an unlisted id fails closed in the disposition lookup`);
        const receipt = pasteRejectionCheckIds([`${id}: stored detail`]);
        assert(Array.isArray(receipt.checkIds) && receipt.uncodedErrors === 0, `${id}: the rejection receipt reads it without throwing`);
        const guidance = __localizedCoverLetterCorrectiveGuidanceForTests([{ id, passed: false, detail: 'stored' }]);
        assert(typeof guidance === 'string' && guidance.length > 0, `${id}: the correction guidance reads it without throwing`);
        const findings = locateGateFindings({ errors: [`${id}: stored detail`], documents: {}, registry: { rows: [], errors: [] } });
        assert(findings.length === 1 && findings[0].checkId === id && findings[0].scope === 'document', `${id}: the gate-finding locator keeps it as a document-scope finding`);
        const sha = 'a'.repeat(64);
        const tally = cleanRuleTally({ version: 1, steps: [{ family: 'write', subject: 'cover-letter', lastRejectedSha256: sha, runs: { [id]: 2 }, rules: [{ key: id, id, n: 2 }] }] });
        const summary = summarizeRuleTally(tally);
        assert(summary.length === 1 && summary[0].ruleId === id && summary[0].count === 2, `${id}: a stored rule tally still summarizes it`);
      }
      // A retired id in a result row is an unattributable failure, so it blocks rather than being waved through.
      assert(partitionCheckResults([{ id: 'direct-welcome-closing', passed: false, detail: 'x' }]).blocking.length === 1, 'an unlisted failed row still blocks');
      // Production evaluation runs every battery row: nothing is filtered by disposition any more.
      const rows = evaluateCoverLetterChecks({ paragraphs: ['I maintained orchard routes for seasonal deliveries.'], jobText: 'We need seasonal deliveries.' });
      assert(rows.length > 0 && rows.every(row => Object.hasOwn(CHECK_DISPOSITIONS, row.id) || (row.parts || []).every(part => Object.hasOwn(CHECK_DISPOSITIONS, part.id))), 'every evaluated row is classified');
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
