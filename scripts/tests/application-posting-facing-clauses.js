import strict from 'node:assert/strict';
import { assertSourceQuoteLinksFinalText, __pasteUnitGroundingErrorsForTests, postingFreeClauses } from '../../electron/ipc/localAiApplication.js';

// 2026-11-15: replaying the recorded cover-letter rejections of 24 jobs showed
// that the writer's brief asks every body paragraph to say which of the job's
// needs it meets, and that the grounding gate then read the posting's own words
// in that statement as claims about the candidate. These cases pin what is the
// posting's to state and what stays the candidate's to prove.
const COMPANY = 'Northwind Labs';
const WORK = 'dispatch rosters for freight routes';
const QUOTE = `I built and rebuilt ${WORK}. I now run ${WORK}. My work on ${WORK} cut triage time. I maintained ${WORK} and coordinated updates with the team during regular operations.`;
const POSTING = `${COMPANY} needs reliable dispatch rosters for freight routes. The Routing team runs Kafka pipelines and will improve existing rosters. Freight Systems Engineer II.`;

function verdicts(text) {
  const options = { identityTokens: [], targetTitle: 'Freight Systems Engineer II', targetCompany: COMPANY, postingText: POSTING };
  let assembly = [];
  try { assertSourceQuoteLinksFinalText(text, [QUOTE], 'coverLetterParagraphs', 0, options); }
  catch (error) { assembly = error.validationFailures || [error.message]; }
  const drafting = __pasteUnitGroundingErrorsForTests({ unitLabel: 'Cover-letter paragraph', unitId: 'p1',
    finalText: text, evidenceIds: ['career-one'], acceptedEvidence: [{ id: 'career-one', sourceId: 'career-data', quote: QUOTE }],
    label: 'coverLetterParagraphs', ...options });
  return { assembly, drafting };
}

function accepts(text) {
  const { assembly, drafting } = verdicts(text);
  strict.deepEqual(assembly, [], `assembly should accept: ${text}`);
  strict.deepEqual(drafting, [], `drafting should accept: ${text}`);
}

function rejects(text, pattern) {
  const { assembly, drafting } = verdicts(text);
  strict.ok(assembly.some(message => pattern.test(message)), `assembly should reject (${pattern}): ${text} -> ${JSON.stringify(assembly)}`);
  strict.ok(drafting.some(message => pattern.test(message)), `drafting should reject (${pattern}): ${text} -> ${JSON.stringify(drafting)}`);
}

export default [
  {
    name: 'posting-facing clauses: a sentence that only reads the posting back may use the names the posting states',
    run() {
      accepts(`As I read the Freight Systems Engineer II posting, the Routing team mostly needs reliable ${WORK}. I built ${WORK}.`);
      // The reading frame frees nothing once the sentence also speaks as the candidate.
      rejects(`As I read the posting, the Routing team needs the Kafka pipelines I built. I built ${WORK}.`, /Kafka/u);
    },
  },
  {
    name: 'posting-facing clauses: a relative tail addressed to the reader is graded against the posting, not the career quotes',
    run() {
      accepts(`I built ${WORK}, which meets your need for an engineer who runs Kafka pipelines.`);
      accepts(`I built ${WORK}, which answers your call to improve existing rosters.`);
      const split = postingFreeClauses(`I built ${WORK}, which meets your need for an engineer who runs Kafka pipelines.`, COMPANY);
      strict.deepEqual(split.free, [false, true], 'only the tail is the posting’s');
      // A name the posting does not state is still the candidate's to prove.
      rejects(`I built ${WORK}, which meets your need for an engineer who runs Hadoop pipelines.`, /Hadoop/u);
      // The same name written in the candidate's own clause is a claim about the candidate.
      rejects(`I built Kafka ${WORK}, which meets your need for Kafka pipelines.`, /Kafka/u);
      // A qualifier the posting does not state is not the posting's to lend.
      rejects(`I built ${WORK}, which answers your call to accelerate existing rosters.`, /accelerat/u);
      // A tail that reports a result of the candidate's work stays with that work.
      rejects(`I built ${WORK}, which improved your Kafka pipelines.`, /Kafka|improve/u);
      // A tail with a past verb reports more of the candidate's work.
      rejects(`I built ${WORK}, which fed your Kafka pipelines.`, /Kafka/u);
      // So does a clause that drops its subject, or one that carries the candidate's predicate on.
      rejects(`Built ${WORK} in Kafka for your team.`, /Kafka/u);
      rejects(`I built ${WORK} and feed the rotation in Kafka, the way your team works.`, /Kafka/u);
      // Naming the employer does not make a tail the reader's (pinned on 2026-11-08).
      rejects(`I built ${WORK}, which meets ${COMPANY}'s need for dispatch rosters.`, /Northwind/u);
    },
  },
  {
    name: 'posting-facing clauses: a denial of experience is not a claim of it, and a boast in the negative still is',
    run() {
      accepts(`I maintained ${WORK}, but I have not yet built Kafka pipelines.`);
      accepts(`I maintained ${WORK}. I have not yet worked on Kafka pipelines.`);
      const denial = postingFreeClauses(`I maintained ${WORK}, but I have not yet built Kafka pipelines.`, COMPANY);
      strict.deepEqual(denial.denial, [false, true], 'the denial is its own clause');
      // What the candidate lacks still has to be something the posting names.
      rejects(`I maintained ${WORK}, but I have not yet built Hadoop pipelines.`, /Hadoop/u);
      // "never" and a verb of failing are boasts about the work, not denials of it.
      strict.equal(postingFreeClauses('I have never missed a Kafka release.', COMPANY).denial[0], false);
      strict.equal(postingFreeClauses('I have not missed a Kafka release.', COMPANY).denial[0], false);
      rejects(`I maintained ${WORK}. I have never missed a Kafka release.`, /Kafka|unrelated/u);
    },
  },
  {
    name: 'closing lesson: what the work taught the candidate owes the quotes no shared term, and still proves every name, count and ownership word',
    run() {
      accepts('This experience taught me that software only counts once people can rely on it. I would bring that habit to your team.');
      accepts(`I maintained ${WORK}. I also learned that a system is only finished when the people depending on it can keep going.`);
      // Only the shared-term floor is waived.
      rejects('This experience taught me to run Hadoop clusters for people who rely on them.', /Hadoop/u);
      rejects('This experience taught me that 40 engineers can rely on one system.', /40/u);
      rejects('This experience taught me that I led every release people could rely on.', /led|leadership/iu);
      // A sentence that is not a lesson still has to restate the cited work.
      rejects(`I maintained ${WORK}. I enjoyed mentoring volunteers through quiet valleys.`, /unrelated/u);
    },
  },
  {
    name: 'posting-facing clauses: a trailing statement of intent owes the career quotes no shared term',
    run() {
      accepts(`I maintained ${WORK}, and I would like to learn the rest from your team.`);
      // An intent clause that brings a possession of the candidate's is a claim again.
      rejects(`I maintained ${WORK}, and I would bring my Hadoop certification to your team.`, /Hadoop|certif/u);
    },
  },
];
