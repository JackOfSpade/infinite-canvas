import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describeClaimFinding } from '../../electron/ipc/applicationClaimGrounding.js';
import { __reportsNoPastWorkForTests, __clauseOnlyAddressesTargetForTests, __sanitizeSourceGroundingForTests, __pasteUnitGroundingErrorsForTests, assertSourceQuoteLinksFinalText } from '../../electron/ipc/localAiApplication.js';
import { targetCompanyNameForms } from '../../electron/ipc/coverLetterChecks.js';
import { targetIdentityNameLicensed } from '../../electron/ipc/applicationTruthGates.js';

export default [
  {
    name: 'Amendment 6 restores the baseline regular past-word reading without non-past exclusions',
    run() {
      for (const word of ['need', 'speed', 'seed', 'feed', 'indeed', 'exceed', 'proceed', 'succeed', 'deed', 'heed', 'breed', 'bleed', 'greed', 'creed', 'weed', 'embed', 'hundred', 'sacred', 'kindred', 'agreed', 'freed', 'guaranteed', 'needed', 'built', 'led']) {
        assert.equal(__reportsNoPastWorkForTests(word), false, word);
      }
      assert.equal(__reportsNoPastWorkForTests('your mission is clear'), true);
    },
  },
  {
    name: 'Amendment 6 target-only clause exemption retains baseline past-word behavior',
    run() {
      const grounding = { meaningful: text => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [], trustedNames: [], exemptTokens: [] };
      for (const part of ['your team has a need', 'your team embedded the same care', 'your team seeded the same care']) assert.equal(__clauseOnlyAddressesTargetForTests(part, `I built dispatch rosters; ${part}`, grounding, 'Northwind Labs', []), false, part);
      const part = 'your mission is clear';
      assert.equal(__clauseOnlyAddressesTargetForTests(part, `I built dispatch rosters; ${part}`, grounding, 'Northwind Labs', []), true);
    },
  },
  {
    name: 'Amendment 6 name rule restores pre-feature licensing without a new brand prefix',
    run() {
      const deps = { reportsNoPastWork: __reportsNoPastWorkForTests, attributionTerms: text => String(text).match(/[\p{L}\p{N}]+/gu) || [], sentenceAddressesTarget: () => true };
      const ctx = { targetCompany: 'Northwind Labs', targetTitle: 'Freight Engineer' };
      for (const text of ['Northwind Labs builds dispatch tools.', 'I would bring dispatch tools to Northwind Labs.']) assert.equal(targetIdentityNameLicensed(text, { code: 'name', term: 'Northwind Labs' }, ctx, deps), true, text);
      assert.equal(targetIdentityNameLicensed('I am excited to join Northwind.', { code: 'name', term: 'Northwind' }, ctx, deps), false);
      assert.equal(targetIdentityNameLicensed('I reviewed Northwind Labs.', { code: 'name', term: 'Northwind Labs' }, ctx, deps), false);
    },
  },
  {
    name: 'Amendment 6 ordinary name wording and static work-at message quote only the offending value',
    run() {
      const unit = 'Letter paragraph p1';
      const finding = { code: 'name', term: 'Northwind Labs', postingText: 'private posting prose', careerText: 'private career prose' };
      const message = describeClaimFinding(unit, finding, { targetCompany: 'Northwind Labs' });
      assert.ok(message.endsWith('or leave the name out.'));
      assert.equal(message.includes('private'), false);
      assert.equal(message.includes('own sentence'), false);
      const employment = describeClaimFinding(unit, { ...finding, code: 'target-employment-frame' });
      assert.equal(employment, `${unit} states work at “Northwind Labs”, which your cited career data does not say. Do not describe your own work as happening at the employer you are applying to.`);
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
  },  {
    name: 'Amendment 8 completion and draft grounding mask the same approved organization names',
    run() {
      const quote = 'I worked at Cedar Works Holdings rebuilding dispatch rosters for freight routes using Python, then maintained nightly reconciliation tooling for the operations group.';
      const roles = [{ title: 'Operations Engineer', company: 'Cedar Works Holdings', dates: '2019 - 2022', location: 'Lakeview' }];
      const texts = [
        'I worked at Cedar Works Holdings rebuilding dispatch rosters for freight routes using Python.',
        'At Cedar Works Holdings, I rebuilt dispatch rosters for freight routes using Python.',
        'My time at Cedar Works Holdings taught me to rebuild dispatch rosters for freight routes using Python.',
        'I joined Cedar Works Holdings and rebuilt dispatch rosters for freight routes using Python.',
        'While at Cedar Works Holdings I rebuilt dispatch rosters for freight routes using Python.',
      ];
      for (const targetCompany of ['Cedar', 'Cedar Works']) {
        for (const paragraph of texts) {
          const draft = __pasteUnitGroundingErrorsForTests({ unitLabel: 'Cover-letter paragraph', unitId: 'approved-name', finalText: paragraph,
            evidenceIds: ['career-one'], acceptedEvidence: [{ id: 'career-one', sourceId: 'career-data', quote }], label: 'coverLetterParagraphs',
            identityTokens: [], sourceRoles: roles, careerData: quote, targetCompany, postingText: '' });
          if (!paragraph.startsWith('While ')) assert.deepEqual(draft, [], paragraph);
          // The full drafting gate also runs attribution; this while-clause is
          // a grounding twin control, as in the completion-mask probe.
          assert.doesNotThrow(() => assertSourceQuoteLinksFinalText(paragraph, [quote], 'coverLetterParagraphs', 0,
            { identityTokens: [], trustedNames: roles.flatMap(role => [role.title, role.company]), approvedCareerEmployers: roles.map(role => role.company),
              approvedOrganizations: roles.map(role => role.company), postingText: '', targetCompany }), paragraph);
          assert.doesNotThrow(() => __sanitizeSourceGroundingForTests({ resumeBullets: [], coverLetterParagraphs: [{ paragraph, careerDataQuotes: [quote] }] },
            { careerData: quote, resumeEvidence: { roles, projects: [] }, coverLetter: { paragraphs: [paragraph] }, coverLetterArgument: null, postingText: '', postingCompany: targetCompany }), paragraph);
        }
        const paragraph = `At ${targetCompany}, I rebuilt dispatch rosters for freight routes using Python.`;
        assert.throws(() => __sanitizeSourceGroundingForTests({ resumeBullets: [], coverLetterParagraphs: [{ paragraph, careerDataQuotes: [quote] }] },
          { careerData: quote, resumeEvidence: { roles, projects: [] }, coverLetter: { paragraphs: [paragraph] }, coverLetterArgument: null, postingText: '', postingCompany: targetCompany }), /states work at/u);
      }
    },
  },
  {
    name: 'Amendment 8 reverted predicates receive no dead target arguments and name forms have no derived flag',
    run() {
      const source = fs.readFileSync(new URL('../../electron/ipc/localAiApplication.js', import.meta.url), 'utf8');
      for (const name of ['speaksOnlyOfApplicationIntent', 'isCandidateCareerSentence', 'isCandidateCareerFigureSentence', 'isCandidateClaimSentence', 'describeClaimFinding']) {
        for (const call of source.matchAll(new RegExp(`\\b${name}\\(([^;\\n]*)`, 'gu'))) {
          assert.doesNotMatch(call[1].split(')')[0], /targetCompany|targetTitle|, company|, jobTitle/u, `${name}: ${call[1]}`);
        }
      }
      for (const form of targetCompanyNameForms('Northwind Labs, Inc.')) assert.deepEqual(Object.keys(form), ['name']);
      const closing = fs.readFileSync(new URL('../../electron/ipc/applicationListingClosing.js', import.meta.url), 'utf8');
      assert.equal(closing.includes('same one anchored A3 lead-in as the employment'), false);
    },
  },
  {
    name: 'Amendment 8 session notes describe the retained name rule without the reverted uncommitted entry',
    run() {
      const doc = fs.readFileSync(new URL('../../docs/application-improvement-sessions.md', import.meta.url), 'utf8');
      assert.equal(doc.includes('official-posting comparative two-run match; user-directed; counter not reset'), false);
      assert.match(doc, /Amendment 8/u);
      assert.match(doc, /work-at/u);
      assert.match(doc, /employment inflation/u);
    },
  },
  {
    name: 'Amendment 9 closing and no-quote guard calls omit unread target title while quoted grounding retains it',
    run() {
      const source = fs.readFileSync(new URL('../../electron/ipc/localAiApplication.js', import.meta.url), 'utf8');
      const closing = source.slice(source.indexOf('export function createApplicationListingClosingValidator('), source.indexOf('export function __finalParagraphListingGroundingForTests('));
      assert.equal(/\bjobTitle\b/u.test(closing), false, 'closing closure has no dead jobTitle constant');
      const guardCall = closing.slice(closing.indexOf('targetEmployerSentenceFailures:'), closing.indexOf('speaksOnlyOfApplicationIntent:'));
      assert.equal(/\btargetTitle\s*:/u.test(guardCall), false, 'employment guard does not read a title');
      assert.match(closing, /targetTitle: input\.job\?\.title/u);
      const unit = source.slice(source.indexOf('function pasteUnitGroundingErrors('), source.indexOf('// Test seam: the per-unit grounding twin'));
      const noQuote = unit.slice(unit.indexOf('if (!normalized.length)'), unit.indexOf('if (citationCount >'));
      assert.doesNotMatch(noQuote, /\btargetTitle\b/u);
      assert.match(unit.slice(unit.indexOf('assertSourceQuoteLinksFinalText(')), /\btargetTitle,/u);
    },
  },
];
