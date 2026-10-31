import { assert } from './testHelpers.js';
import { matchInterviewAnswerCard } from '../../src/utils/interviewAnswerMatching.js';
import { buildInterviewPlan } from '../../src/utils/interviewHelper.js';
import { createInterviewWindowE2EFixture } from '../fixtures/interview-window-e2e.mjs';
import { INTERVIEW_ANSWER_QUESTION_CATALOG } from '../../src/utils/interviewAnswerQuestions.js';

export default [
  {
    name: 'interview matching regressions: discarded catalog questions and variants always use exact cue fallback',
    run() {
      for (const intent of INTERVIEW_ANSWER_QUESTION_CATALOG) {
        for (const question of [intent.question, ...intent.variants]) {
          // A retained card with accidental matching wording cannot override
          // an explicit discard. This also covers unique exact-match priority.
          const retained = { id: 'collision', question, variants: [] };
          assert(matchInterviewAnswerCard(question, { cards: [retained] }) === retained, 'fixture must be matchable before applying the discard');
          const bank = { cards: [retained], droppedQuestions: [intent.question] };
          assert(matchInterviewAnswerCard(question, bank) === null, `discarded intent must fall back: ${question}`);
          assert(matchInterviewAnswerCard(`Please briefly ${question[0].toLowerCase()}${question.slice(1)}`, bank) === null, 'ordinary delivery words cannot bypass a discarded intent');
        }
      }
    },
  },
  {
    name: 'interview matching regressions: discarded intents retain typo and lexical exclusion without blocking other cards',
    run() {
      const { bank } = createInterviewWindowE2EFixture();
      const dropped = { ...bank, droppedQuestions: ['Describe your approach to leadership.'] };
      for (const question of ['Tell me about leadng a team.', 'Tell me about leaidng a team.', 'Please briefly tell me about leading a team.']) {
        assert(matchInterviewAnswerCard(question, bank)?.id === 'leadership', 'control question must normally find the retained card');
        assert(matchInterviewAnswerCard(question, dropped) === null, 'discarded variants and typos must use exact cues');
      }
      assert(matchInterviewAnswerCard('How do you prioritize your work?', dropped)?.id === 'priorities', 'unrelated retained intent remains available');
      const priorities = { ...bank, droppedQuestions: ['How do you prioritize your work?'] };
      assert(matchInterviewAnswerCard('How do you prioritise your work?', priorities) === null, 'controlled spelling equivalence must honor discard');
      const latest = 'Describe your approach to leadership. How do you prioritize your work?';
      assert(matchInterviewAnswerCard(latest, dropped)?.id === 'priorities', 'a discarded earlier question must not block the current independent retained question');
    },
  },
  {
    name: 'interview matching regressions: polite delivery, spelling and single prompt typos preserve prepared intent',
    run() {
      const { bank } = createInterviewWindowE2EFixture();
      for (const [question, id] of [
        ['Tell me about leadng a team.', 'leadership'],
        ['Tell me about leaidng a team.', 'leadership'],
        ['How do you prioritise your work?', 'priorities'],
        ['How do you handle working under pressure?', 'pressure'],
        ['Could you briefly walk me through your background?', 'intro'],
        ['Please briefly describe a process improvement.', 'process'],
      ]) assert(matchInterviewAnswerCard(question, bank)?.id === id, `same prepared intent should match: ${question}`);
    },
  },
  {
    name: 'interview matching regressions: prompt correction cannot dispose of factual anchors or change real actions',
    run() {
      const { bank } = createInterviewWindowE2EFixture();
      for (const question of [
        'Tell me about leaving a team.',
        'Tell me about leadng a team at RivalCo.',
        'How do you prioritise your work for RivalCo?',
        'How do you not prioritize your work?',
        'How do you prioritize your work 40%?',
        'Could you briefly walk me through your salary expectations?',
        'How do you handle working under water?',
      ]) assert(matchInterviewAnswerCard(question, bank) === null, `changed topic/anchor must abstain: ${question}`);
      const custom = { cards: [{ id: 'custom', question: 'How did you improve conversion at RivalCompany?', variants: [] }] };
      assert(matchInterviewAnswerCard('How did you improve conversion at RivalCompny?', custom) === null, 'company names must never receive typo correction');
      assert(matchInterviewAnswerCard('How did you improve conversion at rivalcompny?', custom) === null, 'case changes must not make employer corrections permissible');
    },
  },
  {
    name: 'interview matching regressions: typo and normalized exact ambiguities abstain',
    run() {
      const { bank } = createInterviewWindowE2EFixture();
      const leadership = bank.cards.find(card => card.id === 'leadership');
      const duplicateBank = { cards: [...bank.cards, { ...leadership, id: 'duplicate' }] };
      assert(matchInterviewAnswerCard('Tell me about leadng a team.', duplicateBank) === null, 'a typo cannot choose between competing cards');
      const priorities = bank.cards.find(card => card.id === 'priorities');
      const spellingBank = { cards: [...bank.cards, { ...priorities, id: 'uk', question: 'How do you prioritise your work?' }] };
      assert(matchInterviewAnswerCard('How do you prioritize your work?', spellingBank) === null, 'normalization must not break a tie by source order');
    },
  },
  {
    name: 'interview matching regressions: explicit employer scopes cues to that saved role and unknown names abstain',
    run() {
      const { snapshot } = createInterviewWindowE2EFixture();
      const known = buildInterviewPlan({ question: 'How did you handle disagreement at Maple Market?', profile: snapshot });
      assert(known.status === 'supported' && known.steps.every(step => step.provenance.roleId === 'maple'), 'a known employer must preserve only its exact role path');
      for (const question of [
        'How did you handle disagreement at RivalCo?',
        'How did you handle disagreement at rivalco?',
        'How did you handle disagreement at Workday?',
        'How did you handle disagreement at Scale Corp?',
        'How did you handle disagreement at Northstar Cloud?',
        'How did you handle disagreement at Maple Market and Northstar Cloud?',
        'How did you handle disagreement at Maple Market and increase conversion by 99%?',
      ]) assert(buildInterviewPlan({ question, profile: snapshot }).status === 'unsupported', `an unknown employer or a different role's story must abstain: ${question}`);
      assert(buildInterviewPlan({ question: 'What did you do at Northstar Cloud?', profile: snapshot }).status === 'supported', 'exact employer lookup remains available');
      assert(buildInterviewPlan({ question: 'How did you handle disagreement at work?', profile: snapshot }).status === 'supported', 'ordinary context must not be mistaken for an employer');
    },
  },
  {
    name: 'interview matching regressions: cue fallback cannot ignore numeric or negative question anchors',
    run() {
      const { snapshot } = createInterviewWindowE2EFixture();
      for (const question of [
        'How did you raise onboarding activation to 99%?',
        'How did you reduce Kafka consumer lag to 30 seconds?',
        'Tell me about never leading a team.',
        'How did you reduce Kafka consumer lag without partitioned workers?',
      ]) assert(buildInterviewPlan({ question, profile: snapshot }).status === 'unsupported', `literal cues must retain the requested constraint: ${question}`);
      const exact = buildInterviewPlan({ question: 'How did you reduce Kafka consumer lag to 40 seconds?', profile: snapshot });
      assert(exact.status === 'supported' && exact.steps.some(step => step.cue.includes('40 seconds')), 'an exactly documented metric remains useful');
    },
  },
];
