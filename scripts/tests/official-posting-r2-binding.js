import assert from 'node:assert/strict';
import { authorCoverLetterEnvelope, checkTargetCompanyBinding, targetCompanyNames } from '../../electron/ipc/coverLetterChecks.js';
import { describeClaimFinding } from '../../electron/ipc/applicationClaimGrounding.js';
import { assertSourceQuoteLinksFinalText, __pasteUnitGroundingErrorsForTests } from '../../electron/ipc/localAiApplication.js';

const COMPANY = 'Northwind Labs';
const QUOTE = 'I built dispatch rosters for freight routes. I maintained route reporting for dispatch teams.';
const binding = (sentence, company = COMPANY, prior = [], forbiddenNames = []) =>
  checkTargetCompanyBinding([sentence], company, prior, { forbiddenNames });
function gateErrors(text, company) {
  const options = { identityTokens: [], targetTitle: 'Platform Engineer', targetCompany: company,
    postingText: `${COMPANY} needs dispatch rosters for freight routes.` };
  let assembly = [];
  try { assertSourceQuoteLinksFinalText(text, [QUOTE], 'coverLetterParagraphs', 0, options); }
  catch (error) { assembly = error.validationFailures || [error.message]; }
  const drafting = __pasteUnitGroundingErrorsForTests({ unitLabel: 'Cover-letter paragraph', unitId: 'letter-one',
    finalText: text, evidenceIds: ['career-one'], acceptedEvidence: [{ id: 'career-one', sourceId: 'career-data', quote: QUOTE }],
    label: 'coverLetterParagraphs', ...options });
  return { assembly, drafting };
}

export default [
  {
    name: 'R2 target company variants share legal and parenthetical normalization while preserving raw full and separator-prefix names',
    run() {
      for (const value of [`${COMPANY}, Inc.`, `${COMPANY} (NWL)`, `${COMPANY} LLC (NWL)`]) {
        assert.ok(targetCompanyNames(value).includes(value));
        assert.ok(targetCompanyNames(value).includes(COMPANY), value);
      }
      for (const separator of [' - ', ' – ', ' — ', ' | ']) {
        const value = `${COMPANY}, Inc.${separator}Freight Division`;
        const names = targetCompanyNames(value);
        assert.ok(names.includes(value), 'the raw full employer spelling remains available');
        assert.ok(names.includes(`${COMPANY}, Inc.`));
        assert.ok(names.includes(COMPANY));
        assert.equal(names.length, new Set(names).size);
      }
      assert.deepEqual(targetCompanyNames(''), []);
      assert.deepEqual(targetCompanyNames(null), []);
      assert.deepEqual(targetCompanyNames('The Elm Company'), ['The Elm Company']);
      assert.deepEqual(targetCompanyNames('Northwind Labs (Canada)'), ['Northwind Labs (Canada)']);
      assert.deepEqual(targetCompanyNames('Northwind Labs (2024)'), ['Northwind Labs (2024)']);
    },
  },
  {
    name: 'R2 body-name normalization leaves salutation punctuation refusal and descriptive qualifiers unchanged',
    run() {
      for (const [company, display] of [[`${COMPANY}, Inc.`, COMPANY], [`${COMPANY} LLC (NWL)`, COMPANY],
        ['The Elm Company', 'The Elm Company'], [`${COMPANY} (Canada)`, `${COMPANY} (Canada)`],
        [`${COMPANY} (2024)`, `${COMPANY} (2024)`]]) {
        const job = { company };
        assert.equal(authorCoverLetterEnvelope({ job }).salutation, `Dear ${display} Hiring Team,`);
        assert.equal(job.company, company);
      }
      for (const company of ['Northwind; Freight Division', 'Northwind - Freight Division', 'Northwind – Freight Division', 'Northwind — Freight Division']) {
        assert.equal(authorCoverLetterEnvelope({ job: { company } }).salutation, 'Dear Hiring Team,');
      }
    },
  },
  {
    name: 'R2 target alias spans protect the full employer from shorter prior and poster aliases without exempting standalone aliases',
    run() {
      for (const [target, alias] of [[COMPANY, 'Northwind'], ['Cedar Works Labs', 'Cedar Works'], ['Northwind Labs Canada', COMPANY]]) {
        for (const text of [`I would join ${target}.`, `I look forward to joining ${target}.`,
          `I would support ${target}'s mission.`, `I would help ${target} ship freight tools.`,
          `At ${target}, I would support your team.`]) {
          assert.equal(binding(text, target, [alias]).passed, true, text);
          assert.equal(binding(text, target, [], [alias]).passed, true, text);
        }
        assert.equal(binding(`I would join ${target}. I would support ${alias}.`, target, [alias]).passed, false);
        assert.equal(binding(`I would join ${target}. I would support ${alias}.`, target, [], [alias]).passed, false);
      }
      assert.equal(binding(`I would join ${COMPANY} Europe.`, COMPANY, [`${COMPANY} Europe`]).passed, false,
        'a longer other-employer name is not contained in the shorter target span');
      assert.equal(binding(`I built dispatch rosters at Cedar Works, and I would support ${COMPANY}.`, COMPANY, ['Cedar Works']).passed, true);
    },
  },
  {
    name: 'R2 ordinary-word and explicit short aliases require original case while real prior and poster targets still reject',
    run() {
      const ordinary = [
        ['Target', 'I would help your team to target freight routes.'], ['Block', 'I would help block fraud on your team.'],
        ['Apple', 'I would help your team to apple-test releases.'], ['Square', 'I would support square dispatch rosters on your team.'],
        ['Box', 'I would help box dispatch reports for your team.'], ['Indeed', 'I would indeed bring discipline to your team.'],
        ['Hired', 'I would help your team get hired.'], ['Remote', 'I would help your remote team.'],
        ['Talent', 'I would help your team grow talent.'],
      ];
      for (const [alias, text] of ordinary) {
        assert.equal(binding(text, COMPANY, [alias]).passed, true, text);
        assert.equal(binding(text, COMPANY, [], [alias]).passed, true, text);
        assert.equal(binding(`I would join ${alias}.`, COMPANY, [alias]).passed, false, alias);
        assert.equal(binding(`I would join ${alias}.`, COMPANY, [], [alias]).passed, false, alias);
      }
      assert.equal(binding('I would join NW.', COMPANY, [], ['NW']).passed, false);
      assert.equal(binding('I would help nw reporting for your team.', COMPANY, [], ['NW']).passed, true);
      assert.equal(binding('I would help WE scale.', COMPANY, [], ['World Enterprise']).passed, true,
        'the approved generated two-letter-initialism control remains unchanged');
      assert.equal(binding('I would join cedar works.', COMPANY, ['Cedar Works']).passed, false);
      assert.equal(binding('I would support Cedar Works.', '', ['Cedar Works']).passed, false);
    },
  },
  {
    name: 'R2 legal-suffix and parenthetical references retain the measured pre-feature name verdicts',
    run() {
      for (const company of [`${COMPANY}, Inc.`, `${COMPANY} (NWL)`, `${COMPANY} LLC (NWL)`,
        `${COMPANY}, Inc. – Freight Division`, `${COMPANY}, Inc. — Freight Division`, `${COMPANY}, Inc. | Freight Division`]) {
        for (const text of [`I built dispatch rosters for freight routes. ${COMPANY}'s mission is clear.`]) {
          for (const [gate, errors] of Object.entries(gateErrors(text, company))) assert.deepEqual(errors, [], `${gate}: ${company}: ${text}`);
        }
        for (const text of [`I am excited to join ${COMPANY}.`,
          `I built dispatch rosters for freight routes, which meets ${COMPANY}'s mission.`,
          `At ${COMPANY}, I rebuilt dispatch rosters for freight routes.`,
          `I now run dispatch rosters for freight routes at ${COMPANY}.`]) {
          for (const [gate, errors] of Object.entries(gateErrors(text, company))) assert.ok(errors.length, `${gate}: ${company}: ${text}`);
        }
      }
    },
  },
  {
    name: 'R2 employer name corrections retain pre-feature wording distinct from the narrow employment guard',
    run() {
      const expected = `Paragraph p1 names “${COMPANY}”, which none of its bound career-data quotes states. Every capitalized or acronym term (a tool, product, organization, title, program, or place) must occur in one of the quotes the unit cites, so quote the passage that names it or leave the name out.`;
      for (const targetCompany of [`${COMPANY}, Inc.`, `${COMPANY} (NWL)`, `${COMPANY} – Freight Division`, `${COMPANY} — Freight Division`, `${COMPANY} | Freight Division`]) {
        assert.equal(describeClaimFinding('Paragraph p1', { code: 'name', term: COMPANY }, { targetCompany }), expected);
      }
      const employment = describeClaimFinding('Paragraph p1', { code: 'target-employment-frame', term: COMPANY });
      assert.notEqual(employment, expected);
      assert.match(employment, /states work at/u);
      assert.match(describeClaimFinding('Paragraph p1', { code: 'name', term: 'ZephyrMesh' }, { targetCompany: COMPANY }), /none of its bound career-data quotes/u);
    },
  },
];
