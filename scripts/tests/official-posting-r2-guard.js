import assert from 'node:assert/strict';
import {
  assertSourceQuoteLinksFinalText, __pasteUnitGroundingErrorsForTests,
  hasCandidateNonIntentClause, targetEmploymentFrames, targetEmploymentIntentClause,
} from '../../electron/ipc/localAiApplication.js';

const EMPLOYER = 'Northwind Labs';
const WORK = 'dispatch rosters for freight routes';
const PROOF = `I built ${WORK}.`;
const QUOTE = `I built and rebuilt ${WORK}. I now run ${WORK}. My work on dispatch rosters cut triage time. I maintained dispatch rosters for freight routes and coordinated updates with the team during regular operations.`;
const OPTIONS = { identityTokens: [], targetTitle: 'Freight Systems Engineer', targetCompany: EMPLOYER,
  postingText: `${EMPLOYER} needs dispatch rosters for freight routes across four sites using ZephyrConsole.` };

function gates(text, options = {}, quote = QUOTE) {
  let completion = [];
  try { assertSourceQuoteLinksFinalText(text, [quote], 'coverLetterParagraphs', 0, { ...OPTIONS, ...options }); }
  catch (error) { completion = error.validationFailures || [error.message]; }
  const drafting = __pasteUnitGroundingErrorsForTests({ unitLabel: 'Cover-letter paragraph', unitId: 'p1',
    finalText: text, evidenceIds: ['career-one'], acceptedEvidence: [{ id: 'career-one', sourceId: 'career-data', quote }],
    label: 'coverLetterParagraphs', sourceRoles: [{ title: 'Dispatch Engineer', company: 'Cedar Works' }], ...OPTIONS, ...options });
  return { completion, drafting };
}

function expectVerdict(text, accepted, options = {}, quote = QUOTE) {
  for (const [gate, errors] of Object.entries(gates(text, options, quote))) {
    if (accepted) assert.deepEqual(errors, [], `${gate} accepts ${text}`);
    else assert.ok(errors.length > 0, `${gate} rejects ${text}`);
  }
}

export default [
  {
    name: 'R2 A3 preserves plain intent while unquoted names counts and years receive both ordinary claim gates',
    run() {
      for (const text of [
        'I am eager to bring Kubernetes, Terraform and Airflow expertise to your team.',
        'I am eager to bring ten years of Kubernetes and Terraform expertise to your team.',
        'I am excited to bring Kubernetes expertise to your team.',
        `I am ready to lead a team of twelve engineers at ${EMPLOYER}.`,
        'I am ready to lead a 12-person team.',
      ]) expectVerdict(`${PROOF} ${text}`, false);
      for (const text of [
        `I am excited to join ${EMPLOYER}.`, `I am eager to join ${EMPLOYER}.`,
        `I'm ready to help ${EMPLOYER}.`, `I look forward to joining ${EMPLOYER}.`,
        `I would love to contribute to ${EMPLOYER}.`,
      ]) expectVerdict(text, true);
      assert.equal(targetEmploymentIntentClause(`I am eager to join ${EMPLOYER}.`, EMPLOYER), true);
      for (const remainder of ['lead twelve engineers', 'lead 12 engineers', 'bring Kubernetes expertise']) {
        assert.equal(targetEmploymentIntentClause(`I am ready to ${remainder}.`, EMPLOYER), false);
      }
    },
  },
  {
    name: 'R2 target employment guard covers articles affiliations locating nouns and implicit past subjects',
    run() {
      const frames = [
        ...['for', 'at', 'with'].flatMap(prep => ['team', 'office'].map(noun => `I rebuilt ${WORK} ${prep} the ${EMPLOYER} ${noun}.`)),
        `As a ${EMPLOYER} engineer, I run ${WORK}.`,
        `As an ${EMPLOYER} analyst, I run ${WORK}.`,
        `As an engineer at ${EMPLOYER}, I run ${WORK}.`,
        `Dispatch rosters for ${EMPLOYER} are what I run.`,
        `Dispatch rosters for freight routes at ${EMPLOYER} run on my design.`,
        `My ${EMPLOYER} team and I run ${WORK}.`,
        ...['team', 'colleagues', 'manager'].map(noun => `My ${noun} at ${EMPLOYER} run ${WORK}.`),
        `I run ${WORK} in a role at ${EMPLOYER}.`,
        `Rebuilt ${WORK} at ${EMPLOYER}.`,
        ...['across', 'in', 'by', 'via', 'using', 'alongside', 'within', 'as part of', 'on behalf of'].map(prep => `I rebuilt ${WORK} ${prep} ${EMPLOYER}.`),
        `My work at ${EMPLOYER} aligns with the mission.`,
      ];
      for (const text of frames) expectVerdict(text, false);
      assert.ok(targetEmploymentFrames(`Rebuilt ${WORK} at ${EMPLOYER}.`, EMPLOYER).length,
        'the guard itself recognizes an implicit candidate before another classifier can hide it');
    },
  },
  {
    name: 'R2 target-owned counts and names are never free in a first-person non-intent clause regardless of its work verb',
    run() {
      for (const verb of ['rebuilt', 'cut', 'run']) {
        for (const object of ['your four sites', 'your ZephyrConsole dashboards']) {
          const text = `I ${verb} ${WORK} across ${object} to meet the need.`;
          assert.equal(hasCandidateNonIntentClause(text, EMPLOYER), true);
          expectVerdict(text, false);
        }
      }
      for (const text of [`I would join ${EMPLOYER}.`, `I am eager to join ${EMPLOYER}.`]) {
        assert.equal(hasCandidateNonIntentClause(text, EMPLOYER), false);
      }
      assert.equal(hasCandidateNonIntentClause('I would lead twelve engineers.', EMPLOYER), true,
        'the new conservative helper does not call a count-bearing modal plain intent');
    },
  },
  {
    name: 'R2 application heads never hide relative subordinate participial comma or implicit coordinated candidate claims',
    run() {
      const claims = [
        ...['that', 'which', 'where', 'who', 'when', 'as', 'after', 'since', 'once', 'while', 'if', 'because'].map(connector => `${connector} I led forty Initech sites`),
        'with ten years of Initech leadership', 'with 12 years of Initech leadership',
        'with a Kubernetes certification', 'as a ten-year Initech veteran',
        'I led forty Initech sites', 'and I led forty Initech sites', 'and have led forty Initech sites',
        'and lead forty Initech sites today', ', having led forty Initech sites', ', I led forty Initech sites',
      ];
      for (const claim of claims) expectVerdict(`${PROOF} I am applying for the role ${claim}.`, false);
      for (const head of ['I am applying for', 'I am writing to apply for', "I'm applying for", 'We are applying for']) {
        for (const noun of ['role', 'position', 'job']) expectVerdict(`${head} the Freight Systems Engineer ${noun} at ${EMPLOYER}.`, true);
      }
    },
  },
  {
    name: 'R2 closed fit gerund-subject thanks and on-site references preserve legitimate candidate-facing controls',
    run() {
      const controls = [
        `My background aligns with ${EMPLOYER}' mission.`,
        `My dispatch rosters work aligns well with ${EMPLOYER}'s needs.`,
        `My approach to dispatch rosters resonates with ${EMPLOYER}'s roadmap.`,
        `My values align with ${EMPLOYER}.`,
        `I am particularly interested in ${EMPLOYER} because I built ${WORK}.`,
        `I can see how my work applies to the needs at ${EMPLOYER}.`,
        `Building ${WORK} for ${EMPLOYER} would let me apply the same work.`,
        `Building ${WORK} for teams like ${EMPLOYER}'s is relevant to my work.`,
        `Thank you for considering my application to ${EMPLOYER}.`,
        `Thank you for considering my application for ${EMPLOYER}.`,
        ...['blog', 'site', 'careers page', 'posting', 'website'].map(noun => `On ${EMPLOYER}'s ${noun}, I read that dispatch rosters matter.`),
        `On ${EMPLOYER}' blog, I read that dispatch rosters matter.`,
        `I found the posting on the ${EMPLOYER} careers page.`,
        `At ${EMPLOYER}, dispatch rosters for freight routes matter, and I would help.`,
      ];
      for (const text of controls) expectVerdict(`${PROOF} ${text}`, true);
      for (const text of [
        `I rebuilt ${WORK} at ${EMPLOYER}'s blog.`,
        `I run ${EMPLOYER}'s platform, which aligns with dispatch rosters for freight routes.`,
        `My dispatch rosters at ${EMPLOYER} align with the mission.`,
        `My background aligns with ${EMPLOYER}'s platform I rebuilt for freight routes.`,
        `Building ${WORK} for ${EMPLOYER} is what I built.`,
        `Thank you for considering my application for ${EMPLOYER}, where I rebuilt ${WORK}.`,
        `I am particularly interested in ${EMPLOYER} because I rebuilt ${WORK} at ${EMPLOYER}.`,
        `I am particularly interested in ${EMPLOYER} because I led forty Initech sites.`,
        `I can see how my work applies to the needs at ${EMPLOYER}, where I run ${WORK}.`,
        `I run ${WORK} at ${EMPLOYER}, and I can see how my work applies to the needs.`,
      ]) expectVerdict(text, false);
    },
  },
  {
    name: 'R2 shared company variants license normalized target references while every separator and suffix keeps work frames guarded',
    run() {
      const companies = [
        ...[' - ', ' – ', ' — ', ' | '].map(separator => `${EMPLOYER}${separator}Freight Division`),
        `${EMPLOYER}, Inc.`, `${EMPLOYER}, LLC`, `${EMPLOYER} (NWL)`,
      ];
      for (const targetCompany of companies) {
        const options = { targetCompany, postingText: `${targetCompany} needs dispatch rosters for freight routes.` };
        for (const text of [
          `At ${EMPLOYER}, I rebuilt ${WORK}.`, `I now run ${WORK} at ${EMPLOYER}.`,
          `My work at ${EMPLOYER} on dispatch rosters cut triage time.`,
        ]) expectVerdict(text, false, options);
        for (const text of [
          `I am eager to join ${EMPLOYER}.`, `${PROOF} ${EMPLOYER}'s mission is clear.`,
          `I built ${WORK}, which meets ${EMPLOYER}'s need for reliable dispatch.`,
        ]) expectVerdict(text, true, options);
      }
    },
  },
  {
    name: 'R2 plain application opener passes for the frozen company and title forms its matcher used to miss and nothing else',
    run() {
      const companies = ['The Alder Yard', 'The Lakeview Trading Desk', 'The Willow Mutual', 'The Birch Company', 'The Orchard Consulting Group',
        '4Birch', 'Two Willows', '14andLinden', '9-Cedar', 'One Alder', 'Maple One', 'L4Elm'];
      for (const targetCompany of companies) {
        const options = { targetCompany, postingText: `${targetCompany} needs dispatch rosters for freight routes.` };
        for (const text of [
          `I am applying for the Freight Systems Engineer role at ${targetCompany}.`,
          `${PROOF} I am applying for the Freight Systems Engineer position with ${targetCompany}.`,
          `I am writing to apply for the Freight Systems Engineer job at ${targetCompany}.`,
          `I am applying for the role of Freight Systems Engineer at ${targetCompany}.`,
        ]) expectVerdict(text, true, options);
        // The leading article of the frozen name is optional on the writer's side only.
        if (/^The /u.test(targetCompany)) expectVerdict(`I am applying for the Freight Systems Engineer role at ${targetCompany.slice(4)}.`, true, options);
        // The name earns the skip only as the whole employer: no other organization, no clause after it.
        for (const text of [
          'I am applying for the Freight Systems Engineer role at Initech.',
          `I am applying for the Freight Systems Engineer role at ${targetCompany}, where I rebuilt ${WORK}.`,
          `${PROOF} I am applying for the Freight Systems Engineer role at ${targetCompany} and I led forty Initech sites.`,
          `${PROOF} I am applying for the role of Freight Systems Engineer at ${targetCompany}, where I led forty Initech sites.`,
          `${PROOF} I am applying for the 40 site Freight Systems Engineer role at ${targetCompany}.`,
          `${PROOF} I am applying for the role of Freight Systems Engineer that I led across forty Initech sites at ${targetCompany}.`,
        ]) expectVerdict(text, false, options);
      }
      const titles = ['C++ Developer', '.NET Developer', 'Data & Analytics Engineer', 'UI/UX Designer', 'Engineer (Remote)',
        'Software Engineer 3', 'Freight Systems Engineer, Backend', 'Freight/Systems Engineer', 'Staff Engineer - Platform #2'];
      for (const targetTitle of titles) {
        for (const text of [
          `I am applying for the ${targetTitle} role at ${EMPLOYER}.`,
          `I am applying for the role of ${targetTitle} at ${EMPLOYER}.`,
          `I am applying for the ${targetTitle} position.`,
        ]) expectVerdict(text, true, { targetTitle });
        // Only the host's own title may carry punctuation or digits into the skip.
        expectVerdict(`${PROOF} I am applying for the ${targetTitle} role at ${EMPLOYER}, where I led forty Initech sites.`, false, { targetTitle });
        expectVerdict(`I am applying for the ${targetTitle} role at Initech.`, false, { targetTitle });
      }
      // "role of" names the host title or a shortening of its own words, never a new phrase, organization or place.
      for (const text of [
        `${PROOF} I am applying for the role of Engineer in Initech's Boston office.`, `${PROOF} I am applying for the role of Freight Systems Engineer in Initech's Boston office.`,
        `${PROOF} I am applying for the role of Staff Engineer at ${EMPLOYER}.`, `${PROOF} I am applying for the role of Freight Systems Engineer at Initech.`,
      ]) expectVerdict(text, false);
      expectVerdict(`I am applying for the role of Systems Engineer at ${EMPLOYER}.`, true);
      // A legal suffix leaves a period after the name; a relative clause after it is still the employment frame.
      const suffixed = { targetCompany: `${EMPLOYER}, Inc.`, postingText: `${EMPLOYER}, Inc. needs dispatch rosters for freight routes.` };
      expectVerdict(`I am applying for the Freight Systems Engineer role at ${EMPLOYER}, Inc.`, true, suffixed);
      expectVerdict(`${PROOF} I am applying for the Freight Systems Engineer role at ${EMPLOYER}, Inc., where I rebuilt ${WORK}.`, false, suffixed);
      assert.ok(targetEmploymentFrames(`I run ${WORK} at ${EMPLOYER}, Inc., where I rebuilt ${WORK}.`, `${EMPLOYER}, Inc.`).length);
      expectVerdict(`${PROOF} I am applying for the Software Engineer 4 role at ${EMPLOYER}.`, false, { targetTitle: 'Software Engineer 3' });
      expectVerdict(`${PROOF} I am applying for the Software Engineer 3 role at ${EMPLOYER}.`, false, { targetTitle: 'Software Engineer' });
      expectVerdict(`${PROOF} I am applying for the Data & Analytics Engineer role at ${EMPLOYER}.`, false, { targetTitle: 'Freight Systems Engineer' });
      // The guard itself and the title-less callers keep the plain-word window.
      const sentence = `I am applying for the role of Software Engineer 3 at ${EMPLOYER}.`;
      assert.deepEqual(targetEmploymentFrames(sentence, EMPLOYER, { targetTitle: 'Software Engineer 3' }), []);
      assert.ok(targetEmploymentFrames(sentence, EMPLOYER).length, 'a digit-bearing title is the host title or it is a count');
    },
  },
  {
    name: 'R2 alignment thanks and gerund exemptions cover only the whole closed clause and never an employment frame beside it',
    run() {
      const closed = [
        `My background aligns with ${EMPLOYER}' mission.`, `My background aligns with ${EMPLOYER}’s mission.`,
        `My values align with ${EMPLOYER}'s focus on freight.`, `My work resonates with ${EMPLOYER}.`,
        `My dispatch roster work suits ${EMPLOYER}'s roadmap.`, `My experience fits ${EMPLOYER}'s needs.`,
        `My approach to dispatch rosters is relevant to ${EMPLOYER}'s roadmap.`,
        `I agree with ${EMPLOYER}'s focus on freight.`, `I admire ${EMPLOYER}'s approach to dispatch rosters.`,
        `Thank you for considering my application to ${EMPLOYER}.`, `Thanks for reviewing my application at ${EMPLOYER}.`,
        `Thank you very much for considering my application for ${EMPLOYER}.`,
        `Building ${WORK} for ${EMPLOYER} would let me apply the same work.`,
      ];
      for (const text of closed) expectVerdict(`${PROOF} ${text}`, true);
      const open = [
        `My work resonates with ${EMPLOYER}, having rebuilt ${WORK} at ${EMPLOYER}.`,
        `My dispatch roster work suits ${EMPLOYER}, having already run ${WORK} at ${EMPLOYER}.`,
        `My experience aligns with having rebuilt dispatch rosters at ${EMPLOYER}.`,
        `My work aligns with ${EMPLOYER}, running dispatch rosters there today.`,
        `I agree with ${EMPLOYER}'s focus, having rebuilt rosters there.`,
        `My background aligns with ${EMPLOYER}'s mission, having run its dispatch rosters for freight routes.`,
        `My experience aligns well with this role, having rebuilt dispatch rosters at ${EMPLOYER}.`,
        `My experience aligns well with this role, having run dispatch rosters at ${EMPLOYER}.`,
        `My experience aligns well with this role, having written dispatch rosters at ${EMPLOYER}.`,
        `My experience aligns well with this role, having overseen dispatch rosters at ${EMPLOYER}.`,
        `My experience aligns well with this role, after rebuilding dispatch rosters at ${EMPLOYER}.`,
        `My work suits this role, having rebuilt dispatch rosters at ${EMPLOYER}.`,
        `My experience matches this role, drawing on dispatch rosters rebuilt at ${EMPLOYER}.`,
        `My experience matches dispatch rosters rebuilt at ${EMPLOYER}.`,
        `My experience matches dispatch rosters run at ${EMPLOYER}.`,
        `My dispatch roster work is relevant to this role, having rebuilt rosters for ${EMPLOYER}.`,
        `My work aligns with ${EMPLOYER} (where I rebuilt dispatch rosters at ${EMPLOYER}).`,
        `Thank you for considering my application, having rebuilt dispatch rosters at ${EMPLOYER}.`,
        `Thank you for considering my application to ${EMPLOYER}, where I rebuilt dispatch rosters.`,
        `Thank you for considering my application to ${EMPLOYER}, having rebuilt dispatch rosters at ${EMPLOYER}.`,
        `Thank you for considering my application to ${EMPLOYER} after rebuilding dispatch rosters at ${EMPLOYER}.`,
        `Thank you for considering my application at ${EMPLOYER}, where I run ${WORK}.`,
        `Rebuilding dispatch rosters at ${EMPLOYER}, having run them for freight routes, would let me apply the same work.`,
        `Rebuilding dispatch rosters at ${EMPLOYER} sharpens me.`,
        `Rebuilding dispatch rosters at ${EMPLOYER} would let me apply what I rebuilt there at ${EMPLOYER}.`,
        `Building ${WORK} for ${EMPLOYER} would let me apply the work I did at ${EMPLOYER}.`,
      ];
      for (const text of open) expectVerdict(`${PROOF} ${text}`, false);
      // The object of an alignment is the employer itself or one need-like noun before it; a work noun, a tenure word or a continuity word makes it a workplace.
      for (const text of [
        `My background aligns with years of work at ${EMPLOYER}.`, `My work aligns with dispatch rosters at ${EMPLOYER}.`, `My work aligns with rosters rebuilt at ${EMPLOYER}.`,
        `My work aligns with ${EMPLOYER}'s former rosters.`, `My work aligns with ${EMPLOYER}'s current employees.`,
        `Building ${WORK} during years at ${EMPLOYER} would let me apply the same work.`, `Building ${WORK} as an engineer at ${EMPLOYER} would let me apply the same work.`,
        `Joining ${EMPLOYER} again would let me apply the same work.`, `Joining ${EMPLOYER} in 2019 would let me apply the same work.`,
        `Joining ${EMPLOYER} sharpens me.`, `Joining ${EMPLOYER} is what sharpens me.`,
        `Thank you for considering my application from inside ${EMPLOYER}.`,
      ]) expectVerdict(`${PROOF} ${text}`, false);
      // The employer after a need-like noun, with its sentence-final or relative tail, stays a plain reference.
      for (const text of [
        `My work fits the needs at ${EMPLOYER}.`, `I admire how ${EMPLOYER}'s platform handles ${WORK}.`, `My dispatch roster work would fit well at ${EMPLOYER}.`,
        `My experience in dispatch rosters makes me a strong fit for ${EMPLOYER}.`, `Joining ${EMPLOYER} would let me apply the same rosters.`,
        `Joining ${EMPLOYER} would be an exciting next step for me.`, `Being part of ${EMPLOYER} would let me build dispatch rosters.`,
        `Thank you for considering my application for the ${EMPLOYER} team.`, `Thank you for considering my application to ${EMPLOYER} and for your time.`,
      ]) expectVerdict(`${PROOF} ${text}`, true);
    },
  },
  {
    name: 'R2 reading about the employer materials passes while work on or for those materials stays an employment frame',
    run() {
      for (const text of [
        `I read about the platform in the ${EMPLOYER} engineering blog.`, `I saw the posting on the ${EMPLOYER} website.`,
        `I read the post by the ${EMPLOYER} engineering team.`, `I saw the description on the ${EMPLOYER} page.`,
        `I read the posting in the ${EMPLOYER} job listing.`, `I found this role on the ${EMPLOYER} job board.`,
        `I found the posting on the ${EMPLOYER} careers page.`,
      ]) expectVerdict(`${PROOF} ${text}`, true);
      for (const text of [
        `I rebuilt ${WORK} on the ${EMPLOYER} website.`, `I rebuilt ${WORK} in the ${EMPLOYER} engineering blog.`,
        `I wrote the post for the ${EMPLOYER} engineering team.`, `I led the post by the ${EMPLOYER} engineering team.`,
        `I saw the posting on the ${EMPLOYER} website, where I rebuilt ${WORK}.`,
        `I saw the posting on the ${EMPLOYER} website and rebuilt ${WORK} on the ${EMPLOYER} website.`,
        `I saw the posting on the ${EMPLOYER} website while I rebuilt ${WORK} in the ${EMPLOYER} office.`,
        `I read the post by the ${EMPLOYER} engineering team, having rebuilt ${WORK} for the ${EMPLOYER} team.`,
        `I read about the platform I rebuilt in the ${EMPLOYER} engineering blog.`,
        `I saw the posting on the ${EMPLOYER} website I rebuilt.`,
        `I built ${WORK} on the ${EMPLOYER} platform.`,
      ]) expectVerdict(`${PROOF} ${text}`, false);
    },
  },
  {
    name: 'R2 Amendment 4 sibling employment clauses cannot borrow a closed alignment thanks gerund or reading exemption',
    run() {
      const rejected = [
        `My work aligns with ${EMPLOYER}, which is my current employer.`,
        `My work aligns with ${EMPLOYER}, which employs me.`,
        `My work aligns with ${EMPLOYER} — my current employer.`,
        `My work aligns with ${EMPLOYER}; where I currently work.`,
        `I identify with ${EMPLOYER}: the company I work for.`,
        `My work aligns with ${EMPLOYER}'s mission, and I rebuilt ${WORK} there.`,
        `Joining ${EMPLOYER} would be a natural step, so I rebuilt ${WORK} at the company.`,
        ...['which', 'who', 'that'].map(relative => `My work aligns with ${EMPLOYER}, ${relative} employs me.`),
        `My work aligns with ${EMPLOYER}, that pays me.`,
        `My work aligns with ${EMPLOYER}, and the company employs me.`,
        `My work aligns with ${EMPLOYER}, and ${WORK} are my work there.`,
        `Thank you for considering my application to ${EMPLOYER}, which employs me.`,
        `Thank you for considering my application to ${EMPLOYER}, and I rebuilt ${WORK} for the company.`,
        `I read the post by the ${EMPLOYER} team, which employs me.`,
        `I read the post by the ${EMPLOYER} team, and I rebuilt ${WORK} there.`,
        `Joining ${EMPLOYER} would be exciting, and I rebuilt ${WORK} during my tenure.`,
        `My work aligns with ${EMPLOYER}, and I rebuilt ${WORK} as a member of their team.`,
        `My work aligns with ${EMPLOYER}, and I would help there because the company employs me.`,
        `My work aligns with ${EMPLOYER}, which would let me contribute because the company pays me.`,
        `My work aligns with ${EMPLOYER}, and work there.`,
        `I read the post by the ${EMPLOYER} team and rebuild ${WORK} there.`,
        `I identify with ${EMPLOYER} and run ${WORK} there.`,
        `My work aligns with ${EMPLOYER}, and have a job there.`,
        `I read the post by the ${EMPLOYER} team and get paid there.`,
        `I would join ${EMPLOYER}, because it employs me.`,
        `${EMPLOYER} employs me.`, `${EMPLOYER} is my current employer.`,
      ];
      for (const text of rejected) expectVerdict(`${PROOF} ${text}`, false);
      for (const text of [
        `My work aligns with ${EMPLOYER}.`, `I identify with ${EMPLOYER}.`,
        `My work aligns with ${EMPLOYER}'s mission.`, `Joining ${EMPLOYER} would be a natural step.`,
        `My work aligns with ${EMPLOYER}'s mission, and I rebuilt ${WORK}.`,
        `My work aligns with ${EMPLOYER}'s mission, and I would rebuild ${WORK} there.`,
        `For ${EMPLOYER}, rosters for freight routes are central, and I know them well.`,
        `For ${EMPLOYER}, dispatch rosters for freight routes matter, and I know them well.`,
      ]) expectVerdict(`${PROOF} ${text}`, true);
    },
  },
  {
    name: 'R2 Amendment 4 title fallback and plain opener window reject trailing participle claims',
    run() {
      for (const text of [
        `I am applying for the role of engineer having led payment ledgers at ${EMPLOYER}.`,
        `I am applying for the role of engineer having rebuilt dispatch rosters at ${EMPLOYER}.`,
        `I am applying for the engineer having migrated payment ledgers role at ${EMPLOYER}.`,
      ]) expectVerdict(text, false, { targetTitle: '' });
      expectVerdict(`I am applying for the engineer having migrated payment ledgers role at ${EMPLOYER}.`, false);
      expectVerdict(`I am applying for the role of Freight Systems Engineer at ${EMPLOYER}.`, true, { targetTitle: '' });
    },
  },
  {
    name: 'R2 Amendment 4 gerund and reading clauses reject continuity and paid employment while preserving plain source references',
    run() {
      for (const text of [
        `Working at ${EMPLOYER} is a pleasure for me.`, `Leading dispatch rosters at ${EMPLOYER} is a privilege for me.`,
        `Working at ${EMPLOYER} feels rewarding for me.`, `Leading ${WORK} at ${EMPLOYER} feels rewarding for me.`,
        ...['seems', 'sounds', 'looks'].map(copula => `Working at ${EMPLOYER} ${copula} rewarding for me.`),
        `Staying at ${EMPLOYER} would be great for me.`, `Remaining at ${EMPLOYER} would be great for me.`,
        `Continuing at ${EMPLOYER} would be great for me.`, `Resuming at ${EMPLOYER} would be great for me.`,
        `Building ${WORK} for ${EMPLOYER} is a job that pays me.`,
        `I learned ${WORK} from ${EMPLOYER} docs on the job.`,
      ]) expectVerdict(`${PROOF} ${text}`, false);
      for (const text of [
        `I came across ${EMPLOYER} while researching dispatch rosters.`,
        `I read a post from the ${EMPLOYER} team.`, `My work fits the team at ${EMPLOYER}.`,
        `Joining the team at ${EMPLOYER} would be exciting.`,
      ]) expectVerdict(`${PROOF} ${text}`, true);
    },
  },
  {
    name: 'R2 Amendment 4 distinctive frozen brand prefixes license only closed intent and opener frames',
    run() {
      const options = { targetCompany: 'Zorvex Group', postingText: 'Zorvex Group needs dispatch rosters for freight routes.' };
      for (const text of ['I am excited to join Zorvex.', 'I am applying for the Freight Systems Engineer role at Zorvex.',
        'I am applying for the role of Freight Systems Engineer at Zorvex.']) expectVerdict(text, true, options);
      for (const text of [`I rebuilt ${WORK} at Zorvex.`, `I rebuilt ${WORK} at zorvex.`, `I am excited to join Zorvex, where I rebuilt ${WORK}.`,
        `I am applying for the Freight Systems Engineer role at Zorvex, where I rebuilt ${WORK}.`,
        'I am excited to join Zorvex because the company employs me.', 'I would help Zorvex because it pays me.',
        'Working at Zorvex is a pleasure for me.', 'Working at zorvex is a pleasure for me.',
        'Working at Zorvex feels rewarding for me.']) expectVerdict(`${PROOF} ${text}`, false, options);
      for (const targetCompany of ['Target Group', 'Blue Group', 'The Group', 'Abc Group', 'Sage Group', 'Bright Group', 'Stone Group', 'Bramble Group']) {
        const brand = targetCompany.split(' ')[0];
        expectVerdict(`I am excited to join ${brand}.`, false, { targetCompany, postingText: `${targetCompany} needs dispatch rosters.` });
      }
    },
  },
  {
    name: 'R2 inherited first-person sibling predicates are structural and do not depend on a work-verb dictionary',
    run() {
      for (const text of [
        `My work aligns with ${EMPLOYER} and operates there.`,
        `My dispatch rosters work aligns with ${EMPLOYER} and runs there.`,
        `Our work aligns with ${EMPLOYER} and supports ${WORK} there.`,
      ]) expectVerdict(`${PROOF} ${text}`, false);
      for (const verb of ['code', 'calculate', 'consult', 'debug', 'excel']) {
        for (const head of [`I identify with ${EMPLOYER}`, `We identify with ${EMPLOYER}`, `I read the post by the ${EMPLOYER} team`,
          `Also I read the post by the ${EMPLOYER} team`, `And I read the post by the ${EMPLOYER} team`]) {
          for (const separator of [' and ', '; ', ', so ']) expectVerdict(`${PROOF} ${head}${separator}${verb} ${WORK} there.`, false);
        }
      }
      for (const text of [
        `I identify with ${EMPLOYER} and would code ${WORK} there.`,
        `I identify with ${EMPLOYER} and could debug ${WORK} at the company.`,
        `I identify with ${EMPLOYER} and code ${WORK}.`,
        `I identify with ${EMPLOYER} and they debug ${WORK} there.`,
        `I identify with ${EMPLOYER} and the team codes ${WORK} there.`,
        `I identify with ${EMPLOYER} and ${EMPLOYER} engineers debug ${WORK} there.`,
        `I identify with ${EMPLOYER} and they debug ${WORK} there and calculate ${WORK} there.`,
      ]) expectVerdict(`${PROOF} ${text}`, true);
      const scopedQuote = `I built and rebuilt ${WORK}. I code ${WORK}. I previously managed ${WORK}. I worked on ${WORK}.`;
      const scopedOptions = { postingText: `${EMPLOYER} needs ${WORK}.` };
      for (const text of [
        `I am excited to join ${EMPLOYER} and already code ${WORK} there.`,
        `I would join ${EMPLOYER} and previously managed ${WORK} there.`,
        `I would join ${EMPLOYER} and previously worked on ${WORK} there.`,
        `I would join ${EMPLOYER} and continue to code ${WORK} there.`,
        `I would join ${EMPLOYER} and would continue to code ${WORK} there.`,
        ...['currently', 'now', 'still', 'always', 'again'].map(marker => `I would join ${EMPLOYER} and ${marker} code ${WORK} there.`),
      ]) expectVerdict(`${PROOF} ${text}`, false, scopedOptions, scopedQuote);
      for (const text of [
        `I am excited to join ${EMPLOYER} and code ${WORK} there.`,
        `I would join ${EMPLOYER} and code ${WORK} there.`,
        `I would join ${EMPLOYER} and would now code ${WORK} there.`,
        `I would join ${EMPLOYER} and would always code ${WORK} there.`,
      ]) expectVerdict(`${PROOF} ${text}`, true, scopedOptions, scopedQuote);
    },
  },
  {
    name: 'R2 Amendment 4 sibling guard bounds repeated employer mentions without a target-referring sibling',
    run() {
      const text = `My work aligns with ${EMPLOYER}${`, and ${EMPLOYER}`.repeat(600)}.`;
      const started = performance.now();
      targetEmploymentFrames(text, EMPLOYER);
      assert.ok(performance.now() - started < 1000, '600 target mentions without a sibling claim take less than one second');
    },
  },
  {
    name: 'R2 a company name stripped of its legal suffix needs its own capitalization when it is an ordinary word',
    run() {
      const options = { targetCompany: 'Anchor Corporation', postingText: 'Anchor Corporation needs dispatch rosters for freight routes.' };
      for (const text of [
        'I built dispatch rosters for the anchor customers of freight routes.', 'I built dispatch rosters with anchor dates for freight routes.',
        'I built dispatch rosters in an anchor state for freight routes.',
      ]) expectVerdict(text, true, options);
      for (const text of [
        `${PROOF} I rebuilt rosters at Anchor.`, `At Anchor, I rebuilt ${WORK}.`, `${PROOF} I rebuilt rosters at Anchor Corporation.`,
        `${PROOF} I run ${WORK} for ANCHOR.`, `${PROOF} My work at Anchor on ${WORK} cut triage time.`,
      ]) expectVerdict(text, false, options);
    },
  },
];
