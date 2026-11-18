import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { assert } from './testHelpers.js';
import { matchInterviewAnswerCard } from '../../src/utils/interviewAnswerMatching.js';
import { extractLatestInterviewQuestion } from '../../src/utils/interviewHelper.js';
import { createInterviewWindowController, projectInterviewDisplay } from '../../electron/interviewWindow.js';
import { interviewPreparedBriefRecordId } from '../../electron/ipc/interviewPreparation.js';
import { buildInterviewAnswerEvidence, INTERVIEW_ANSWER_QUESTION_CATALOG } from '../../electron/ipc/interviewAnswerBank.js';

const SNAPSHOT = 'a'.repeat(64);
const JOB_URL = 'https://jobs.example.test/product';
const ONBOARDING_SOURCE = 'Led a team to improve onboarding conversion through a simpler setup flow. Reviewed setup changes with the team to validate onboarding conversion. I wrote setup instructions for staff before the team review. I documented conversion checks in the onboarding guide.';
const REVIEW_TOPICS = ['documentation', 'research', 'scheduling', 'access', 'validation', 'reporting', 'delivery', 'testing', 'integration', 'migration', 'product'];
const TRAILING_QUESTIONS = [
  ['Why are you interested in this role? Also what is your salary expectation.', 'what is your salary expectation'],
  ['Why are you interested in this role? and what salary', 'what salary'],
  ['Why are you interested in this role? Please answer in two minutes. What is your notice period', 'What is your notice period'],
];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function fixtureBrief() {
  const semantic = { version: 1, inputs: { careerSnapshotId: SNAPSHOT,
    jobUrlSha256: sha256(JOB_URL), applicationArtifactId: 'b'.repeat(64), applicationArtifactDigest: 'c'.repeat(64) },
  role: { title: 'Product Manager', company: 'Example Company', location: 'Toronto', summary: 'Example Company builds free tools for creative teams through collaborative product development.' },
  roleThemes: ['Onboarding conversion', 'Teams build free tools for creative projects.'], companyFacts: [], recentContext: [],
  likelyQuestions: ['How did you improve onboarding conversion?'], questionsToAsk: [], applicationPositioning: [], warnings: [] };
  return { ...semantic, briefId: sha256(stable(semantic)), createdAt: '2026-10-30T00:00:00.000Z', sources: [] };
}
function fixtureSnapshot() {
  return { snapshotId: SNAPSHOT, profile: { roles: [{ id: 'r1', title: 'Product Manager', employer: 'Example Employer' },
    { id: 'r2', title: 'Technical Writer', employer: 'Second Example Employer' }],
    achievements: [{ id: 'a1', roleId: 'r1', claim: ONBOARDING_SOURCE },
      ...REVIEW_TOPICS.map((topic, index) => ({ id: `a${index + 2}`, roleId: 'r2', claim: `Coordinated a ${topic} review with writers to validate guide changes for staff. Reviewed guide changes with writers before delivery. I compared ${topic} feedback with the writers before guide delivery. I documented ${topic} review decisions in the staff guide for delivery. I tested the revised guide against the staff access checklist.` }))],
    projects: [], skills: [], education: [], certifications: [], otherEvidence: [] } };
}
function fixtureBank(brief = fixtureBrief()) {
  const evidence = buildInterviewAnswerEvidence({ snapshot: fixtureSnapshot(), brief });
  const claim = (source, text) => ({ text, evidenceIds: [source.id], quotes: [{ evidenceId: source.id, quote: source.text }] });
  const statement = claim(evidence[0], 'I led a team through a simpler setup flow for onboarding conversion.');
  const leadership = INTERVIEW_ANSWER_QUESTION_CATALOG.find(item => item.question === 'Describe your approach to leadership.');
  const cards = [{
    id: 'onboarding', question: leadership.question, variants: [...leadership.variants],
    headline: statement, thinEvidence: true,
    bullets: [{ ...claim(evidence[0], 'I reviewed setup changes with the team to validate onboarding conversion.'), stage: 'point' },
      { ...claim(evidence[0], 'I wrote setup instructions for staff before the team review.'), stage: 'point' }], example: claim(evidence[0], 'I documented conversion checks in the onboarding guide.'),
    consistency: { consistentWithResume: false, resumeQuote: '' },
  }, ...INTERVIEW_ANSWER_QUESTION_CATALOG.filter(item => item !== leadership && item.question !== 'Tell me about yourself.').slice(0, 11).map((item, index) => ({
    id: `other-${index}`, question: item.question, variants: [...item.variants],
    headline: claim(evidence[index + 1], `I coordinated a ${REVIEW_TOPICS[index]} review with writers to validate guide changes.`), thinEvidence: true,
    bullets: [{ ...claim(evidence[index + 1], `I compared ${REVIEW_TOPICS[index]} feedback with the writers before guide delivery.`), stage: 'point' },
      { ...claim(evidence[index + 1], `I documented ${REVIEW_TOPICS[index]} review decisions in the staff guide for delivery.`), stage: 'point' }],
    example: claim(evidence[index + 1], 'I tested the revised guide against the staff access checklist.'),
    consistency: { consistentWithResume: false, resumeQuote: '' },
  }))];
  const companyResearch = evidence.find(item => item.kind === 'research' && item.text.startsWith('Example Company'));
  const roleResearch = evidence.find(item => item.kind === 'research' && item.text.startsWith('Teams build'));
  for (const card of cards) {
    if (card.question === 'Why are you interested in this role?') {
      card.headline = claim(roleResearch, 'This role interests me because teams build free tools for creative projects.');
    } else if (card.question === 'Why are you interested in this company?') {
      card.headline = claim(companyResearch, companyResearch.text);
    }
  }
  const intro = INTERVIEW_ANSWER_QUESTION_CATALOG[0];
  cards[cards.length - 1] = {
    id: 'intro', question: intro.question, variants: [...intro.variants], thinEvidence: false,
    headline: claim(evidence[0], 'I led a team at Example Employer as a Product Manager.'),
    bullets: [{ ...claim(evidence[1], 'I coordinated a documentation review with writers at Second Example Employer.'), stage: 'point' },
      { ...claim(roleResearch, 'This role interests me because teams build free tools for creative projects.'), stage: 'point' }],
    example: claim(evidence[0], 'I reviewed setup changes with the team to validate onboarding conversion.'),
    consistency: { consistentWithResume: false, resumeQuote: '' },
  };
  const used = new Set(cards.flatMap(card => [card.headline, ...card.bullets, card.example].flatMap(item => item.evidenceIds)));
  return { version: 2, inputs: { ...brief.inputs, briefId: brief.briefId }, cards, evidence: evidence.filter(item => used.has(item.id)) };
}
function matcherBank() {
  const bank = fixtureBank();
  bank.cards = [{ ...bank.cards[0], question: 'How did you improve onboarding conversion?',
    variants: ['How did you simplify onboarding?', 'Tell me about improving onboarding conversion.'] }];
  return bank;
}
class WebContents extends EventEmitter {
  constructor(id) { super(); this.id = id; this.sent = []; }
  send(channel, data) { this.sent.push({ channel, data }); }
  setWindowOpenHandler() {}
}
class Window extends EventEmitter {
  static nextId = 1;
  static windows = new Map();
  static fromWebContents(contents) { return this.windows.get(contents?.id) || null; }
  constructor(options) { super(); this.id = Window.nextId++; this.options = options; this.webContents = new WebContents(this.id + 1_000); Window.windows.set(this.webContents.id, this); }
  isDestroyed() { return !!this.destroyed; }
  async loadURL() {}
  close() { this.destroyed = true; this.emit('closed'); }
  focus() {}
}
async function launch({ loadAnswerBank, loadSnapshot = async () => fixtureSnapshot() } = {}) {
  const owner = new Window(); const brief = fixtureBrief(); const bank = fixtureBank(brief);
  let audioInput = null; let turn = 0; const notices = [];
  const controller = createInterviewWindowController({ createAudioService: input => { audioInput = input; return { start: () => ({ status: 'listening' }), stop: () => ({ status: 'idle' }), notice: message => notices.push(message) }; },
    matcherTransportFactory: () => { throw new Error('Offline fixture: AI unavailable.'); }, BrowserWindow: Window, ipcMain: {}, registerIpc: false,
    appInstance: { getPath: () => '/synthetic-user-data' }, isAuthorizedOwner: value => value === owner,
    loadPreparedBrief: async () => brief,
    loadBundle: async () => ({ artifactId: brief.inputs.applicationArtifactId, applicationArtifactDigest: brief.inputs.applicationArtifactDigest }),
    loadSnapshot, loadAnswerBank: loadAnswerBank || (async () => bank), devServerUrl: 'http://localhost:5173/' });
  await controller.launch({ sender: owner.webContents }, { nodeId: 'interview_fixture', snapshotId: SNAPSHOT,
    jobUrl: JOB_URL, briefRecordId: interviewPreparedBriefRecordId(brief), brief, plan: null, currentStep: 0 });
  const session = [...controller.sessions.values()][0];
  const event = { sender: session.child.webContents };
  // One detected question, delivered the way the listening path delivers it;
  // resolves to the display the child now holds.
  const ask = async question => {
    controller.startListening(event);
    await audioInput.onQuestion({ text: question, id: ++turn }, () => true);
    return controller.getBrief(event);
  };
  return { owner, controller, session, event, ask, notices, bank, brief };
}

export default [
  {
    name: 'interview answer live: dropped prepared questions and variants use the exact-cue rail',
    async run() {
      const original = fixtureBank();
      const dropped = original.cards[0];
      const cards = original.cards.slice(1);
      const used = new Set(cards.flatMap(card => [card.headline, ...card.bullets, card.example].flatMap(claim => claim.evidenceIds)));
      const degraded = { ...original, cards, evidence: original.evidence.filter(item => used.has(item.id)), droppedQuestions: [dropped.question] };
      const { controller, session, event, ask } = await launch({ loadAnswerBank: async () => degraded });
      try {
        const briefing = controller.getBrief(event).briefing;
        assert(briefing.preparedQuestions.length === 11 && !briefing.preparedQuestions.includes(dropped.question), 'degraded bank remains available and offers only retained prepared questions');
        for (const question of [dropped.question, ...dropped.variants]) {
          const result = await ask(question);
          assert(result.answerCard === null, 'a dropped intent must never select another retained spoken card');
          if (result.plan.status === 'supported') assert(result.plan.steps.some(step => step.cue === ONBOARDING_SOURCE), 'supported fallback must display the entire exact saved source');
        }
        const result = await ask(dropped.question);
        assert(result.plan.status === 'supported' && result.plan.steps.some(step => step.cue === ONBOARDING_SOURCE), 'the dropped leadership question uses exact verified career cues');
      } finally { session.child.close(); }
    },
  },
  ...TRAILING_QUESTIONS.map(([question, latest]) => ({
    name: `interview answer matching: trailing question supersedes prepared role-interest answer (${latest})`,
    run() {
      const bank = fixtureBank();
      assert(matchInterviewAnswerCard(question, bank) === null, 'an unmatched trailing question must not open the earlier role-interest card');
      assert(extractLatestInterviewQuestion(question) === latest, 'question extraction must retain only the latest request');
      assert(extractLatestInterviewQuestion(latest) === latest, 'the extracted question must remain stable for saved-rail validation');
    },
  })),
  {
    name: 'interview answer matching: the latest tail can use an exact prepared variant and ordinary prose does not supersede a question',
    run() {
      const bank = fixtureBank();
      const role = bank.cards.find(card => card.question === 'Why are you interested in this role?');
      assert(matchInterviewAnswerCard('Why are you interested in this company? Also why this role', bank) === role, 'an exact latest variant must match even when its lexical vocabulary is too small for fuzzy lookup');
      assert(matchInterviewAnswerCard('Why are you interested in this role? Please answer in two minutes.', bank) === role, 'ordinary instructions must preserve the latest actual question');
      for (const tail of ['Who did you mentor', 'Tell me your salary expectations', 'Walk me through your salary expectations', 'Can you share your notice period', 'Could you share your notice period', 'Would you share your notice period', 'Salary expectations', 'Notice period']) {
        assert(extractLatestInterviewQuestion(`Why are you interested in this role? Also ${tail}.`) === tail, `a trailing question/request must supersede the older topic: ${tail}`);
        assert(matchInterviewAnswerCard(`Why are you interested in this role? Also ${tail}.`, bank) === null, `an unfamiliar latest topic must abstain: ${tail}`);
      }
      assert(extractLatestInterviewQuestion('Why are you interested in this role? What salary. Thank you.') === 'What salary', 'polite prose after a new request must not resurrect the earlier topic');
    },
  },
  {
    name: 'interview answer live: trailing unmatched spoken questions abstain with a notice instead of showing an earlier answer',
    async run() {
      const { session, ask, notices } = await launch();
      try {
        for (const [question, latest] of TRAILING_QUESTIONS) {
          const seen = notices.length; const result = await ask(question);
          assert(result.answerCard === null && result.plan === null && !session.locked && notices.length === seen + 1,
            `an unmatched trailing request must abstain with a notice instead of displaying an earlier prepared answer: ${latest}`);
        }
      } finally { session.child.close(); }
    },
  },
  {
    name: 'interview answer matching: unique exact questions and intent variants beat lexical lookup',
    run() {
      const bank = matcherBank(); const card = bank.cards[0];
      for (const question of [card.question, '  HOW DID YOU SIMPLIFY ONBOARDING? ', 'Tell me about improving onboarding conversion!']) {
        assert(matchInterviewAnswerCard(question, bank) === card, 'prepared question or variant must open its card locally');
      }
      assert(matchInterviewAnswerCard('Could you explain improving onboarding conversion?', bank) === card, 'controlled inflection and high lexical coverage should match');
      for (const question of ['How did you approach onboarding stakeholder conflict?', 'What did you learn about onboarding?', 'How do you manage budgets?', 'What was the result?',
        'How did you improve onboarding conversion at RivalCo?', 'How did you improve onboarding conversion 40%?', 'Why did you improve onboarding conversion?',
        'How did you improve onboarding conversion? Why?', '', 'x'.repeat(2001)]) {
        assert(matchInterviewAnswerCard(question, bank) === null, `weak or different intent must abstain: ${question}`);
      }
    },
  },
  {
    name: 'interview answer matching: duplicate exact variants and competing cards abstain',
    run() {
      const bank = matcherBank(); const duplicate = { ...bank.cards[0], id: 'duplicate' };
      bank.cards.push(duplicate);
      assert(matchInterviewAnswerCard(bank.cards[0].question, bank) === null, 'an exact duplicate across cards is ambiguous');
      assert(matchInterviewAnswerCard('Could you explain improving onboarding conversion?', bank) === null, 'lexical tie must abstain rather than choose source order');
      duplicate.question = 'Tell me about managing budgets?'; duplicate.variants = [];
      assert(matchInterviewAnswerCard(bank.cards[0].question, bank)?.id === 'onboarding', 'unrelated card must not affect unique exact selection');
    },
  },
  {
    name: 'interview answer display: exposes only cited exact cues and refuses a stale bank binding',
    run() {
      const brief = fixtureBrief(); const bank = fixtureBank(brief);
      const display = projectInterviewDisplay({ brief, snapshotId: SNAPSHOT, currentStep: 0, answerBank: bank, answerCard: bank.cards[0] });
      assert(display.answerCard.headline === bank.cards[0].headline.text && display.answerCard.evidence.length === 1, 'ready card must lead with prepared text and include only cited cues');
      assert(display.answerCard.thinEvidence === true, 'projection must retain the host-checked thin evidence warning');
      assert(display.answerCard.evidence[0].quote === bank.evidence[0].text && display.answerCard.bullets[0].evidenceIds[0] === bank.evidence[0].id, 'exact cues and bullet citations must survive the bounded projection');
      assert(display.answerCard.headlineEvidenceIds[0] === bank.evidence[0].id, 'headline must expose its own exact citation mapping');
      assert(display.briefing.preparedQuestions[0] === bank.cards[0].question && !('inputs' in display.answerCard), 'prepared buttons get questions but no snapshot/bundle/profile authority');
      for (const field of ['careerSnapshotId', 'briefId', 'applicationArtifactId', 'applicationArtifactDigest', 'jobUrlSha256']) {
        const stale = structuredClone(bank); stale.inputs[field] = 'f'.repeat(64);
        let rejected = false;
        try { projectInterviewDisplay({ brief, snapshotId: SNAPSHOT, currentStep: 0, answerBank: stale }); } catch { rejected = true; }
        assert(rejected, `projection must refuse changed ${field}`);
      }
    },
  },
  {
    name: 'interview answer live: a detected prepared question locks its card and later questions replace it with honest local fallback',
    async run() {
      const { controller, session, event, bank, ask } = await launch();
      try {
        assert(controller.getBrief(event).briefing.preparedQuestions.length === 12, 'all prepared questions must be available before listening');
        const result = await ask(bank.cards[0].question);
        assert(result.answerCard?.id === 'onboarding' && result.plan.status === 'supported' && session.locked, 'matching card should lead while retaining literal evidence rail');
        const replacement = await ask('How do you manage budgets?');
        assert(replacement !== result && replacement.answerCard === null && replacement.plan.status === 'unsupported'
          && replacement.question === 'How do you manage budgets?' && !session.locked,
        'a later detected question must replace the card without silently retaining it or inventing an answer');
        await ask(bank.cards[0].question);
        const continued = await ask('What did you learn?');
        assert(continued.answerCard === null && continued.plan.missingComponents.includes('lesson'), 'follow-up must use exact story cues and disclose missing details, never reuse authored card as a new answer');
        const unknown = await ask('How do you manage budgets?');
        assert(unknown.answerCard === null && unknown.plan.status === 'unsupported' && !session.locked, 'unmatched question keeps existing honest unsupported behavior');
        const cardOnly = await ask(bank.cards[0].variants[1]);
        assert(cardOnly.answerCard?.id === 'onboarding' && cardOnly.plan === null && session.locked, 'prepared intent variant can show a verified card even when career lexical rail abstains');
        assert(controller.getBrief(event).answerCard.id === 'onboarding', 'renderer reload must retain the main-owned card');
      } finally { session.child.close(); }
    },
  },
  {
    name: 'interview answer live: a missing or stale bank at launch falls back to newly validated exact cues',
    async run() {
      const brief = fixtureBrief(); const bank = fixtureBank(brief);
      for (const mode of ['missing', 'stale']) {
        const { session, ask } = await launch({ loadAnswerBank: async ({ snapshot, brief: inputBrief, bundle }) => {
          assert(snapshot.snapshotId === SNAPSHOT && inputBrief.briefId === brief.briefId && bundle.applicationArtifactDigest === brief.inputs.applicationArtifactDigest, 'loader receives verified pin and exact captured artifact binding');
          return mode === 'missing' ? null : { ...bank, inputs: { ...bank.inputs, briefId: 'f'.repeat(64) } };
        } });
        try {
          const result = await ask(bank.cards[0].question);
          assert(result.answerCard === null && result.plan.status === 'supported', `an invalidated (${mode}) bank must fall back to newly validated exact cues`);
        } finally { session.child.close(); }
      }
    },
  },
  {
    name: 'interview answer live: job-aware example cannot inherit a different source-order story for follow-ups',
    async run() {
      const { controller, session, event, bank, ask } = await launch();
      try {
        const card = bank.cards.find(item => item.question === 'Tell me about your relevant experience.');
        const answer = await ask(card.question);
        assert(answer.answerCard.id === card.id && answer.answerCard.example.text === 'I tested the revised guide against the staff access checklist.', 'prepared job-aware example should remain the selected answer');
        assert(answer.plan === null && session.anchorPlan === null && session.locked, 'source-order role A cues must not be offered as role B card continuation');
        await ask('What did you learn?');
        assert(controller.getBrief(event).answerCard.id === card.id, 'dependent follow-up must preserve the usable card while refusing an unrelated anchor');
      } finally { session.child.close(); }
    },
  },
  {
    name: 'interview answer live: controller rejects altered statement shapes and changed approved source text',
    async run() {
      const original = fixtureBank();
      for (const mode of ['shape-changed', 'source-changed']) {
        const { controller, session, event, ask } = await launch({
          loadSnapshot: async () => {
            const snapshot = fixtureSnapshot();
            if (mode === 'source-changed') snapshot.profile.achievements[0].claim = ONBOARDING_SOURCE.replace('simpler', 'new');
            return snapshot;
          },
          loadAnswerBank: async () => {
            if (mode !== 'shape-changed') return original;
            const altered = structuredClone(original); altered.cards[0].headline.text += ' by 90%';
            return altered;
          },
        });
        try {
          const result = await ask(original.cards[0].question);
          assert(result.answerCard === null && result.plan.status === 'supported', 'untrusted or stale prepared prose must never cross the projection; exact newly checked evidence remains available');
          if (mode === 'source-changed') {
            assert(controller.getBrief(event).plan.steps.some(step => step.cue === ONBOARDING_SOURCE.replace('simpler', 'new')), 'fallback must use newly checked exact text, never the stale bank quote');
          }
        } finally { session.child.close(); }
      }
    },
  },
  {
    name: 'interview answer live: live matching code has no model call of its own',
    run() {
      const source = fs.readFileSync(new URL('../../electron/interviewWindow.js', import.meta.url), 'utf8');
      const live = source.slice(source.indexOf('const answerQuestion ='), source.indexOf('const audioFor ='));
      const matcher = fs.readFileSync(new URL('../../src/utils/interviewAnswerMatching.js', import.meta.url), 'utf8');
      assert(live.length > 1000 && !/callLLM|requestNonApiAi|fetch\(|https?:|buildInterviewBrief|interviewAnswerBankPrompt/u.test(live + matcher), 'live matching must contain no generation, network or bridge fallback');
    },
  },
];
