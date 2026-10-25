import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describeClaimFinding } from '../../electron/ipc/applicationClaimGrounding.js';
import {
  NON_PAST_ED_WORDS, isPastEdWord, __reportsNoPastWorkForTests, __clauseOnlyAddressesTargetForTests,
  assertSourceQuoteLinksFinalText, __pasteUnitGroundingErrorsForTests, targetEmploymentFrames,
} from '../../electron/ipc/localAiApplication.js';

const EMPLOYER = 'Northwind Labs';
const WORK = 'dispatch rosters for freight routes';
const QUOTE = `I built and rebuilt ${WORK}. I now run ${WORK}. My work on ${WORK} cut triage time. I maintained ${WORK} and coordinated updates with the team during regular operations.`;
const OPTIONS = { identityTokens: [], targetTitle: 'Freight Systems Engineer', targetCompany: EMPLOYER, postingText: `${EMPLOYER} needs dispatch rosters for freight routes.` };

function gateErrors(text, options = {}) {
  let assembly = [];
  try { assertSourceQuoteLinksFinalText(text, [QUOTE], 'coverLetterParagraphs', 0, { ...OPTIONS, ...options }); }
  catch (error) { assembly = error.validationFailures || [error.message]; }
  const drafting = __pasteUnitGroundingErrorsForTests({
    unitLabel: 'Cover-letter paragraph', unitId: 'p1', finalText: text,
    evidenceIds: ['career-one'], acceptedEvidence: [{ id: 'career-one', sourceId: 'career-data', quote: QUOTE }],
    label: 'coverLetterParagraphs', ...OPTIONS, ...options,
  });
  return { assembly, drafting };
}

export default [
  {
    name: 'official-posting structural guard closes C plus every non-past-word C+ variant at both gates',
    run() {
      const holes = [
        `At ${EMPLOYER}, I rebuilt ${WORK}`,
        `I now run ${WORK} at ${EMPLOYER}`,
        `My work at ${EMPLOYER} on ${WORK} cut triage time`,
      ];
      const rows = [
        ...holes.map(text => `${text}.`),
        ...holes.flatMap(text => [...NON_PAST_ED_WORDS].map(word => `${text}, so the ${word} is clear.`)),
        `At ${EMPLOYER}, I rebuilt triage rosters to meet the need.`,
        `My work at ${EMPLOYER} on triage rosters cut the need for dispatch delays.`,
        `At ${EMPLOYER}, I rebuilt triage rosters.`,
        `I now run triage rosters at ${EMPLOYER}.`,
        `My work at ${EMPLOYER} on triage rosters cut triage time.`,
        `I am applying for the role that I rebuilt at ${EMPLOYER}.`,
        `I built ${WORK}. I helped ${EMPLOYER}.`,
        `I run the company at ${EMPLOYER}.`,
        `I work with the staff at ${EMPLOYER}.`,
        `I rebuilt ${WORK} at ${EMPLOYER}'s website.`,
        `I rebuilt ${WORK} at ${EMPLOYER}'s mission.`,
        `I would keep doing ${WORK} at ${EMPLOYER}.`,
        `I would be using ${EMPLOYER}'s platform.`,
        `My extensive professional engineering leadership role at ${EMPLOYER} spans ${WORK}.`,
        `My work in a long engineering leadership role at ${EMPLOYER} spans ${WORK}.`,
      ];
      for (const text of rows) {
        for (const [gate, errors] of Object.entries(gateErrors(text))) {
          assert.ok(errors.length, `${gate} rejects ${text}`);
          assert.ok(errors.some(error => error.includes('the employer this letter is addressed to')), `${gate} reports the structural guard before any floor: ${text}`);
        }
      }
      // The structural check must not depend on a populated target title.
      for (const errors of Object.values(gateErrors(holes[0], { targetTitle: '' }))) assert.ok(errors.length);
    },
  },
  {
    name: 'official-posting closed intent heads and clause-window employer needs are accepted without licensing prior work',
    run() {
      for (const text of [
        `I am excited to join ${EMPLOYER}.`, `I am eager to join ${EMPLOYER}.`,
        `I'm ready to help ${EMPLOYER}.`, `I look forward to joining ${EMPLOYER}.`,
        `I would love to contribute to ${EMPLOYER}.`,
        `I built ${WORK}. I am ready to bring ${WORK} to ${EMPLOYER}.`,
        `I built ${WORK}, which meets ${EMPLOYER}'s need for dispatch rosters.`,
        `I built ${WORK}, and ${EMPLOYER} needs dispatch rosters for freight routes.`,
        `I am applying for the Freight Systems Engineer role at ${EMPLOYER}.`,
      ]) for (const [gate, errors] of Object.entries(gateErrors(text))) assert.deepEqual(errors, [], `${gate}: ${text}`);
      for (const text of [
        `I built ${WORK}. I was excited to join ${EMPLOYER}.`,
        `I built ${WORK} to help ${EMPLOYER}.`, `I rebuilt ${WORK} to help ${EMPLOYER}.`,
        `I helped ${EMPLOYER} with ${WORK}.`,
        `I built ${WORK}. I am applying for the role that I led across forty Initech sites.`,
      ]) for (const [gate, errors] of Object.entries(gateErrors(text))) assert.ok(errors.length, `${gate}: ${text}`);
    },
  },
  {
    name: 'official-posting guard exempts approved organizations while retaining former-employer attribution checks',
    run() {
      const text = `At ${EMPLOYER}, I rebuilt triage rosters.`;
      assert.equal(targetEmploymentFrames(text, EMPLOYER).length, 1);
      for (const approved of [EMPLOYER, `${EMPLOYER}, Inc.`]) {
        assert.deepEqual(targetEmploymentFrames(text, EMPLOYER, { approvedOrganizations: [approved] }), []);
      }
      assert.ok(targetEmploymentFrames(text, EMPLOYER, { approvedOrganizations: ['Cedar Works'] }).length);
      assert.deepEqual(targetEmploymentFrames(`I am ready to join ${EMPLOYER}.`, EMPLOYER), []);
      assert.deepEqual(targetEmploymentFrames(`I am applying for the role at ${EMPLOYER}.`, EMPLOYER), []);
      const correction = describeClaimFinding('Paragraph p1', { code: 'target-employment-frame', term: EMPLOYER });
      assert.equal(correction, describeClaimFinding('Paragraph p1', { code: 'name', term: EMPLOYER }, { targetCompany: EMPLOYER }));
    },
  },
  {
    name: 'official-posting clause exemption keeps true past verbs and target-owned claims grounded beside need',
    run() {
      const grounding = { meaningful: text => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [], trustedNames: [], exemptTokens: [] };
      for (const verb of ['embedded', 'seeded', 'exceeded', 'proceeded']) {
        const part = `your team ${verb} the same care`;
        assert.equal(__clauseOnlyAddressesTargetForTests(part, `I built dispatch rosters; ${part}`, grounding, EMPLOYER, []), false);
      }
      const part = 'your team can embed the same care';
      assert.equal(__clauseOnlyAddressesTargetForTests(part, `I built dispatch rosters; ${part}`, grounding, EMPLOYER, []), true);
      for (const [gate, errors] of Object.entries(gateErrors('I built your Orion Console to meet the need for dispatch rosters.'))) {
        assert.ok(errors.some(error => /Orion/u.test(error)), `${gate} does not free an unsupported target-owned name after built plus need`);
      }
    },
  },
  {
    name: 'official-posting poster binding reaches each production evaluator through postedBy and forbiddenNames',
    run() {
      const source = fs.readFileSync(new URL('../../electron/ipc/localAiApplication.js', import.meta.url), 'utf8');
      for (const [start, end, expected] of [
        ['function pasteAcceptedAdvisories(', 'function pasteCoverLetterChecks(', /postedBy: input\.job\?\.postedBy \|\| ''/u],
        ['function pasteCoverLetterCompletionTwinErrors(', 'function ', /postedBy: input\.job\?\.postedBy \|\| ''/u],
        ['export function validateLocalApplicationResult(', 'function ', /postedBy: job\?\.postedBy \|\| ''/u],
      ]) {
        const at = source.indexOf(start);
        assert.ok(at >= 0, start);
        const next = end ? source.indexOf(end, at + start.length) : source.length;
        assert.match(source.slice(at, next > at ? next : source.length), expected);
      }
      assert.match(source, /evaluateCoverLetterChecks\(\{[^\n]*forbiddenNames: postedBy \? \[postedBy\] : \[\]/u);
      const checks = fs.readFileSync(new URL('../../electron/ipc/coverLetterChecks.js', import.meta.url), 'utf8');
      assert.match(checks, /checkTargetCompanyBinding\(paragraphs, companyName, priorEmployers, \{ evidence, jobText, forbiddenNames \}\)/u);
    },
  },
  {
    name: 'official-posting past-work filter excludes only the closed nineteen non-past ed words',
    run() {
      const exclusions = ['need', 'speed', 'seed', 'feed', 'indeed', 'exceed', 'proceed', 'succeed', 'deed', 'heed', 'breed', 'bleed', 'greed', 'creed', 'weed', 'embed', 'hundred', 'sacred', 'kindred'];
      assert.deepEqual([...NON_PAST_ED_WORDS].sort(), [...exclusions].sort());
      assert.equal(NON_PAST_ED_WORDS.size, 19);
      for (const word of exclusions) {
        assert.equal(isPastEdWord(word), false, `${word} is excluded from regular past forms`);
        assert.equal(isPastEdWord(word.toUpperCase()), false, `${word} is excluded without case sensitivity`);
        assert.equal(__reportsNoPastWorkForTests(word), true, `${word} alone reports no past work`);
        assert.equal(__reportsNoPastWorkForTests(`Northwind Labs has a ${word}.`), true, `${word} stays non-past inside a target clause`);
      }
      for (const word of ['shed', 'red', 'bed']) {
        assert.equal(NON_PAST_ED_WORDS.has(word), false, `${word} is outside the approved exclusion set`);
        assert.equal(isPastEdWord(word), true, `${word} is not an extra helper exception`);
      }
    },
  },
  {
    name: 'official-posting past-work filter retains real regular and irregular past verbs beside need',
    run() {
      for (const word of ['agreed', 'freed', 'guaranteed', 'needed', 'seeded', 'proceeded', 'built', 'led']) {
        assert.equal(__reportsNoPastWorkForTests(word), false, `${word} remains past work`);
        assert.equal(__reportsNoPastWorkForTests(`Northwind Labs has a need, and I ${word} the routing service.`), false, `${word} is not hidden by need`);
      }
      for (const word of ['agreed', 'freed', 'guaranteed', 'needed', 'seeded', 'proceeded']) {
        assert.equal(isPastEdWord(word), true, `${word} stays a regular past form`);
      }
    },
  },
  {
    name: 'official-posting employer corrections recognize contiguous tokens and possessives without source examples',
    run() {
      const unit = 'Letter paragraph "cl-p2"';
      const targetCompany = 'Northwind Labs - Research Division';
      const postingText = 'Northwind Labs develops the lighthouse coordination platform.';
      const careerText = 'I rewrote the dispatch queue for the orchard project.';
      for (const term of ['Northwind Labs', 'northwind', 'Labs', "Northwind Labs's", 'Northwind Labs’s', 'Research Division']) {
        const message = describeClaimFinding(unit, { code: 'name', term, postingText, careerText }, { targetCompany });
        assert.equal(message, `${unit} names “${term}”, the employer this letter is addressed to. Name it only as the owner of a need your work meets, or as a place you would join, never as a place your work happened; do not say you worked, built or helped at, for or on it.`);
        assert.equal(message.includes(postingText), false);
        assert.equal(message.includes(careerText), false);
        assert.equal(message.includes('for example'), false);
      }
      for (const term of ['Northwind Research', 'Northwind Laboratories', 'Wind', 'Orchard Tools']) {
        const message = describeClaimFinding(unit, { code: 'name', term }, { targetCompany });
        assert.ok(message.includes('which none of its bound career-data quotes states'), term);
        assert.equal(message.includes('the employer this letter is addressed to'), false, term);
      }
      assert.ok(describeClaimFinding(unit, { code: 'name', term: 'Northwind Labs' }).includes('which none of its bound career-data quotes states'), 'the old two-argument behavior remains available');
      assert.ok(describeClaimFinding(unit, { code: 'quantity', term: 'seven' }, { targetCompany }).includes('states the count'), 'the employer-specific wording applies only to name findings');
    },
  },
];
