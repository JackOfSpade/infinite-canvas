import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import {
  buildInterviewBrief, buildInterviewPreparedAnswers, captureInterviewPreparationBundle,
  loadInterviewPreparedAnswerBank, publishInterviewPreparedAnswers, publishInterviewPreparedBrief,
  registerInterviewPreparationHandlers, validateInterviewBriefAssessment,
} from '../../electron/ipc/interviewPreparation.js';
import { answerBankRecordId, buildInterviewAnswerEvidence, INTERVIEW_ANSWER_QUESTION_CATALOG, inspectInterviewAnswerCards, isInterviewAnswerBank } from '../../electron/ipc/interviewAnswerBank.js';
import { canonicalizeGeneratedUntrustedBoundaryNonces } from '../../electron/ipc/nonApiAi.js';
import { deriveInterviewResumeConsistency, resumeCoverage } from '../../electron/ipc/interviewResumeCoverage.js';

const snapshotId = 'a'.repeat(64);
const canonicalJobUrl = 'https://jobs.example.test/interview';
const TOPICS = ['deployment automation', 'release validation', 'documentation', 'data migration', 'integration', 'operations', 'testing', 'planning', 'reporting', 'support', 'monitoring', 'tooling'];
const snapshot = { snapshotId, profile: { roles: [{ id: 'r1', title: 'Engineer', employer: 'Fixture Labs' }],
  achievements: TOPICS.map((topic, index) => ({ id: `a${index + 1}`, roleId: 'r1',
    claim: `${index ? '' : 'Led deployment automation. '}I maintained the ${topic} system and created a ${topic} guide. I tested the ${topic} system against a documented checklist. I reviewed the ${topic} guide with internal staff. I automated the ${topic} status report for internal staff.`,
    evidenceSegmentIds: [`segment-${String(index + 1).padStart(4, '0')}`] })), projects: [], otherEvidence: [] } };
const COMPANY_FACT = 'Example Studio builds free tools for teams.';
const research = `${COMPANY_FACT} https://example.test/about`;
const assessment = { role: { title: 'Engineer', company: 'Example Studio', location: 'Remote', summary: '' },
  roleThemes: ['Release automation'], companyFacts: [{ fact: COMPANY_FACT, sourceUrl: 'https://example.test/about', sourceDate: 'unknown', evidenceQuote: COMPANY_FACT }],
  recentContext: [], likelyQuestions: ['How did you improve release automation?'], questionsToAsk: [], applicationPositioning: [], warnings: [] };

async function fixture(root) {
  const directory = path.join(root, 'bundle');
  await fs.promises.mkdir(directory);
  await fs.promises.writeFile(path.join(directory, 'Application.html'), `<section data-ic-document-panel="resume"><main><h2>Experience</h2><h3>Engineer · Fixture Labs</h3><p>May 2022 – June 2025</p><ul>${snapshot.profile.achievements.map(item => `<li>${item.claim}</li>`).join('')}</ul></main></section>`);
  await fs.promises.writeFile(path.join(directory, 'Original Job Listing.md'), '# Engineer\n\n**Company:** Example Studio\n**Location:** Remote\n\n---\n\nRelease automation.');
  const captured = await captureInterviewPreparationBundle({ directory, userDataPath: root });
  const bundle = JSON.parse(await fs.promises.readFile(path.join(root, 'interview-helper-artifacts', `${captured.artifactId}.json`), 'utf8'));
  const brief = validateInterviewBriefAssessment(assessment, { rawResearch: research, bundle, snapshotId, canonicalJobUrl, bundleArtifactId: captured.artifactId });
  const projection = buildInterviewAnswerEvidence({ snapshot, brief, bundle });
  const evidence = projection.filter(item => item.kind === 'career');
  const motivation = projection.find(item => item.kind === 'research' && item.text === COMPANY_FACT);
  const statement = (item, text) => ({ text, evidenceIds: [item.id], quotes: [{ evidenceId: item.id, quote: item.text }] });
  const intents = [INTERVIEW_ANSWER_QUESTION_CATALOG.at(-1), ...INTERVIEW_ANSWER_QUESTION_CATALOG.slice(1, 12)];
  intents[11] = INTERVIEW_ANSWER_QUESTION_CATALOG[0];
  const value = { cards: intents.map((intent, index) => {
    const topic = TOPICS[index]; const item = evidence[index];
    const why = index === 2 || index === 3;
    const headline = why ? `This ${index === 2 ? 'role' : 'company'} interests me because ${COMPANY_FACT}`
      : `I maintained the ${topic} system and created a ${topic} guide.`;
    const first = `I tested the ${topic} system against a documented checklist.`;
    const second = index === 11 ? `This role interests me because ${COMPANY_FACT}` : `I reviewed the ${topic} guide with internal staff.`;
    const example = `I automated the ${topic} status report for internal staff.`;
    return { id: `card-${index}`, question: intent.question, variants: [...intent.variants], thinEvidence: true, extensions: [],
      headline: statement(why ? motivation : item, headline), bullets: [first, second].map((text, bullet) => ({ stage: 'point', ...statement(index === 11 && bullet === 1 ? motivation : item, text) })), example: statement(item, example),
      consistency: { consistentWithResume: true, resumeQuote: item.text } };
  }) };
  for (const card of value.cards) {
    card.consistency = deriveInterviewResumeConsistency([card.headline, ...card.bullets, card.example], evidence, bundle.applicationPositioning.resume);
    assert(card.consistency?.consistentWithResume, 'each synthetic prepared card has a genuine captured résumé match');
  }
  return { captured, bundle, brief, value, args: { nodeId: 'interview-node', snapshotId, canonicalJobUrl, bundleArtifactId: captured.artifactId, manualAiRunId: 'interview-run' } };
}

function isEntailmentPrompt(prompt) { return prompt.includes('INTERVIEW ANSWER ENTAILMENT REVIEW'); }
function promptData(prompt, label) {
  const match = prompt.match(new RegExp(`<untrusted-${label}-[^>]+>\\n([\\s\\S]*?)\\n</untrusted-`));
  return match ? JSON.parse(match[1]) : null;
}
function reviewedReply(prompt, failedPaths = []) {
  return { verdicts: promptData(prompt, 'interview-answer-entailment-claims').map(({ path, claimDigest }) => ({
    path, claimDigest, entailed: !failedPaths.includes(path), reason: failedPaths.includes(path) ? 'CAUSALITY' : 'SUPPORTED',
  })) };
}
function sparseReply(value, prompt) {
  const targets = promptData(prompt, 'interview-answer-failing-cards');
  return targets ? { cards: targets.map(({ card }) => structuredClone(value.cards.find(item => item.id === card.id))) } : value;
}
function answerReply(value, prompt, opts) {
  const reply = isEntailmentPrompt(prompt) ? reviewedReply(prompt) : sparseReply(value, prompt);
  opts?.responseValidator?.(reply);
  return reply;
}

export default [
  {
    name: 'interview answer preparation: reviewed-claim why intro and project fallbacks review previously unreviewed extensions',
    async run() {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-fallback-extensions-'));
      try {
        const { args, brief, value, bundle } = await fixture(root);
        const inputSnapshot = structuredClone(snapshot);
        inputSnapshot.profile.projects.push({ id: 'additional-release', name: 'Release migration', roleId: 'r1',
          description: 'I reviewed release feedback with staff. I tested rollback checklists with engineers. I documented migration requirements.',
          evidenceSegmentIds: ['segment-0099'] });
        const evidence = buildInterviewAnswerEvidence({ snapshot: inputSnapshot, brief, bundle });
        const source = evidence.find(item => item.entityId === 'additional-release');
        for (const targetIndex of [2, 3, 4, 11]) {
          const invalid = structuredClone(value); const target = invalid.cards[targetIndex];
          if (targetIndex === 3) {
            // A thin intro may retain one separately research-cited reason;
            // approve the company frame without borrowing a role motive.
            invalid.cards[11].bullets = [{ stage: 'point', ...structuredClone(target.headline) }];
          }
          target.headline.text += ' with 997 widgets.';
          target.extensions = [
            { id: 'feedback', text: 'I reviewed release feedback with staff.', evidenceIds: [source.id] },
            { id: 'wrong-relationship', text: 'I reviewed rollback requirements with engineers.', evidenceIds: [source.id] },
            { id: 'invented-metric', text: 'I reduced rollback time by 90%.', evidenceIds: [source.id] },
          ];
          let generations = 0; let judgments = 0; const rounds = [];
          const { bank } = await buildInterviewPreparedAnswers({ ...args, brief, userDataPath: root,
            loadSnapshot: async () => inputSnapshot, onValidationRound: round => rounds.push(round),
            callText: async (prompt, opts) => {
              let reply;
              if (isEntailmentPrompt(prompt)) {
                judgments++;
                const extensions = promptData(prompt, 'interview-answer-entailment-claims').filter(claim => claim.path.includes('.extensions['));
                if (judgments === 1) assert(!extensions.length, 'the mechanically failing draft has never had its optional points reviewed');
                else assert(extensions.length === 2 && extensions.every(claim => claim.question === target.question),
                  'the final batch reviews both mechanically valid points against the rescued card, excluding the invented metric');
                reply = reviewedReply(prompt, extensions.filter(claim => claim.text.includes('rollback requirements')).map(claim => claim.path));
              } else { generations++; reply = sparseReply(invalid, prompt); }
              opts.responseValidator(reply); return reply;
            } });
          const rescued = bank.cards.find(card => card.id === target.id);
          assert(generations === 3 && judgments === 2 && bank.cards.length === 12 && !bank.droppedQuestions,
            'all exhausted draft rounds retain the full bank with one final semantic batch and no extra generation');
          assert(rescued.thinEvidence && rescued.extensions.map(point => point.id).join() === 'feedback',
            'the reviewed optional point survives while the semantically false sibling is dropped without losing its card');
          assert(rescued.extensions[0].quotes[0].quote === source.text && isInterviewAnswerBank(bank),
            'the retained point seals with the whole bound source and all ordinary bank guards');
          assert(rounds.filter(round => ['fallback', 'final'].includes(round.phase)).every(round => {
            const review = round.fallbackExtensionReviews?.find(item => item.cardId === target.id);
            return review?.submittedCount === 2 && review.rejectedCount === 1 && review.retainedCount === 1 && review.unreviewedDroppedCount === 0;
          }), 'fallback and final diagnostics count reviewed, rejected and retained points without silently dropping unreviewed material');
        }
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview answer preparation: compact extensions receive full source and semantic sparse rejection preserves every card',
    async run() {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-extension-entailment-'));
      try {
        const { args, brief, value, bundle } = await fixture(root);
        const inputSnapshot = structuredClone(snapshot);
        inputSnapshot.profile.projects.push({ id: 'additional-release', name: 'Release migration', roleId: 'r1',
          description: 'I reviewed release feedback with staff. I tested rollback checklists with engineers. I documented migration requirements.', evidenceSegmentIds: ['segment-0099'] });
        inputSnapshot.profile.projects.push({ id: 'additional-audit', name: 'Rollback audit', roleId: 'r1',
          description: 'I reviewed rollback requirements with engineers.', evidenceSegmentIds: ['segment-0100'] });
        const evidence = buildInterviewAnswerEvidence({ snapshot: inputSnapshot, brief, bundle });
        const source = evidence.find(item => item.entityId === 'additional-release');
        const supported = evidence.find(item => item.entityId === 'additional-audit');
        const point = (id, text, citation = source) => ({ id, text, evidenceIds: [citation.id] });
        value.cards[0].extensions = [point('wrong-relationship', 'I reviewed rollback requirements with engineers.'),
          point('correct-relationship', 'I reviewed rollback requirements with engineers.', supported),
          point('feedback', 'I reviewed release feedback with staff.'),
          point('invented-metric', 'I reduced rollback time by 90%.')];
        let generations = 0; let judgments = 0;
        const { bank } = await buildInterviewPreparedAnswers({ ...args, brief, userDataPath: root, loadSnapshot: async () => inputSnapshot,
          callText: async (prompt, opts) => {
            let reply;
            if (isEntailmentPrompt(prompt)) {
              judgments++;
              const claims = promptData(prompt, 'interview-answer-entailment-claims');
              assert(claims.filter(claim => claim.path.includes('.extensions[')).length === 3,
                'mechanically invented metric drops before review while same-vocabulary new relationship still reaches the judge');
              assert(prompt.includes(source.text), 'the compact IDs hydrate the whole authoritative source before review');
              reply = reviewedReply(prompt, ['cards[0].extensions[0]']);
            } else { generations++; reply = value; }
            opts.responseValidator(reply); return reply;
          } });
        assert(generations === 1 && judgments === 1 && bank.cards.length === 12 && !bank.droppedQuestions,
          'a semantic extension failure cannot cause card repair, card omission or another generation step');
        assert(bank.cards[0].extensions.map(item => item.id).join() === 'correct-relationship,feedback', 'a false earlier proposition cannot displace the same text bound to genuinely supporting evidence, and both safe points survive');
        assert(bank.cards[0].extensions.every(item => item.quotes[0].quote === evidence.find(source => source.id === item.evidenceIds[0]).text), 'sealed points bind complete exact quotes reconstructed only by evidence ID');
        assert(JSON.stringify(bank.cards.slice(1)) === JSON.stringify(value.cards.slice(1)), 'other prepared cards remain unchanged');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview answer preparation: a genuine captured résumé match survives a repair reset and sealed reload',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-resume-sealed-recovery-'));
      try {
        const { args, brief, value } = await fixture(root);
        const reset = structuredClone(value); reset.cards[0].consistency = { consistentWithResume: false, resumeQuote: '' };
        let generations = 0; let judgments = 0;
        const { bank } = await buildInterviewPreparedAnswers({ ...args, brief, userDataPath: root, loadSnapshot: async () => snapshot,
          callText: async (prompt, opts) => {
            let reply;
            if (isEntailmentPrompt(prompt)) reply = reviewedReply(prompt, ++judgments === 1 ? ['cards[0].headline'] : []);
            else reply = sparseReply(++generations === 1 ? value : reset, prompt);
            opts.responseValidator(reply); return reply;
          } });
        assert(generations === 2 && bank.cards[0].consistency.consistentWithResume && bank.cards[0].consistency.resumeQuote,
          'the host retains a genuine captured match after a repair returns false and an empty quote');
        await publishInterviewPreparedBrief({ brief, userDataPath: root });
        await publishInterviewPreparedAnswers({ bank, brief, userDataPath: root, loadSnapshot: async () => snapshot });
        const loaded = await loadInterviewPreparedAnswerBank({ brief, userDataPath: root, snapshot });
        assert(JSON.stringify(loaded.cards[0].consistency) === JSON.stringify(bank.cards[0].consistency),
          'canonical captured résumé proof survives sealing, persistence and bound validation');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview answer preparation: captured HTML keeps first résumé bullet separate from role headings and wrapped spans',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-resume-block-capture-'));
      try {
        const directory = path.join(root, 'bundle');
        await fs.promises.mkdir(directory);
        await fs.promises.writeFile(path.join(directory, 'Application.html'), `<section data-ic-document-panel="resume"><main>
          <h2>Experience</h2><h3>Software Engineer · Fixture Labs</h3><p>May 2022 – June 2025</p>
          <ul><li><span>Built a full-stack intranet portal with a</span><span>React and TypeScript frontend.</span></li>
          <li>Maintained scheduled data integrations for internal staff.</li></ul>
          <p>Observed:</p><ul><li>Led external delivery.</li></ul>
          <p>Contact fixture@example.test or 555-123-4567.</p>
        </main></section>`);
        await fs.promises.writeFile(path.join(directory, 'Original Job Listing.md'), '# Engineer\n\n**Company:** Example Studio\n**Location:** Remote\n\n---\n\nFull-stack engineering.');
        const captured = await captureInterviewPreparationBundle({ directory, userDataPath: root });
        const bundle = JSON.parse(await fs.promises.readFile(path.join(root, 'interview-helper-artifacts', `${captured.artifactId}.json`), 'utf8'));
        const resume = bundle.applicationPositioning.resume;
        const quote = 'Built a full-stack intranet portal with a React and TypeScript frontend.';
        const evidence = [{ id: 'first-bullet', text: quote }];
        assert(resume.includes(`June 2025\u2029${quote}`) && !/[\p{Cc}\p{Cf}]/u.test(resume), 'paragraph separators preserve role and item boundaries without allowing control characters');
        assert(resume.includes('[redacted email]') && resume.includes('[redacted phone]') && !resume.includes('fixture@example.test'), 'each captured semantic block retains identity redaction');
        assert(resumeCoverage(quote, evidence, resume, true, [{ text: `I ${quote[0].toLowerCase()}${quote.slice(1)}`, evidenceIds: ['first-bullet'] }]), 'the first genuine résumé statement matches despite preceding role metadata and inline wrapping');
        assert(!resumeCoverage('Led external delivery.', [{ id: 'observed', text: 'Led external delivery.' }], resume, true, [{ text: 'I led external delivery.', evidenceIds: ['observed'] }]), 'a paragraph boundary after an observation colon cannot detach its qualifier');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview answer preparation: malformed sparse repairs retain approved cards and degrade within the round budget',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-answer-malformed-repair-'));
      try {
        const { args, brief, value } = await fixture(root);
        const invalid = structuredClone(value); invalid.cards[0].headline.text += ' with 997 widgets.';
        let generations = 0; let judgments = 0;
        const { bank } = await buildInterviewPreparedAnswers({ ...args, brief, userDataPath: root, loadSnapshot: async () => snapshot,
          callText: async (prompt, opts) => {
            let reply;
            if (isEntailmentPrompt(prompt)) { judgments++; reply = reviewedReply(prompt); }
            else { generations++; reply = generations === 1 ? invalid : { cards: [] }; }
            opts.responseValidator(reply); return reply;
          } });
        assert(generations === 3 && judgments === 1 && bank.cards.length === 11 && bank.droppedQuestions[0] === value.cards[0].question, 'malformed repairs consume the bounded budget without discarding eleven approved cards');
        assert(JSON.stringify(bank.cards) === JSON.stringify(value.cards.slice(1)), 'malformed patches cannot alter any passing claim');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview answer preparation: host restores canonical quotes and warns about missing question shape',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-answer-host-recovery-'));
      try {
        const { args, brief, value } = await fixture(root);
        const draft = structuredClone(value); const card = draft.cards[5];
        card.thinEvidence = false;
        for (const claim of [card.headline, ...card.bullets, card.example]) claim.quotes[0].quote = 'A cropped or incorrectly copied source.';
        let generations = 0; let judgments = 0;
        const { bank } = await buildInterviewPreparedAnswers({ ...args, brief, userDataPath: root, loadSnapshot: async () => snapshot,
          callText: async (prompt, opts) => {
            if (isEntailmentPrompt(prompt)) judgments++;
            else generations++;
            return answerReply(draft, prompt, opts);
          } });
        const restored = bank.cards.find(item => item.id === card.id);
        assert(generations === 1 && judgments === 1 && bank.cards.length === 12,
          'host-owned quote restoration and an evidence warning do not need a model repair');
        assert(restored.thinEvidence && restored.headline.text === card.headline.text,
          'a factual deliverable without challenge evidence retains its speech with a thin-evidence warning');
        for (const claim of [restored.headline, ...restored.bullets, restored.example]) {
          assert(claim.quotes.every(quote => bank.evidence.some(source => source.id === quote.evidenceId && source.text === quote.quote)),
            'each restored quote must be the complete sealed source bound to the existing ID');
        }
        assert(card.headline.quotes[0].quote === 'A cropped or incorrectly copied source.' && !card.thinEvidence,
          'host recovery leaves the untrusted model response unchanged');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview answer preparation: quote recovery and evidence warnings cannot rescue number entity or candor failures',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-answer-recovery-guards-'));
      try {
        const { args, brief, bundle, value } = await fixture(root);
        for (const kind of ['number', 'entity', 'candor', 'unbound']) {
          const inputSnapshot = structuredClone(snapshot); const draft = structuredClone(value); const card = draft.cards[5];
          card.thinEvidence = false;
          if (kind === 'number') card.headline.text = 'I maintained 997 operations systems and created the operations guide.';
          if (kind === 'entity') card.headline.text = 'I maintained the UnlistedCorp operations system and created an operations guide.';
          if (kind === 'candor') {
            const entity = inputSnapshot.profile.achievements[5];
            entity.claim = entity.claim.replaceAll('I ', 'We ') + ' We co-built the operations system with the other engineer.';
            const source = buildInterviewAnswerEvidence({ snapshot: inputSnapshot, brief, bundle }).find(item => item.entityId === entity.id);
            for (const claim of [card.headline, ...card.bullets, card.example]) {
              claim.evidenceIds = [source.id]; claim.quotes = [{ evidenceId: source.id, quote: 'A cropped source omitting the shared-work qualification.' }];
            }
          } else {
            for (const claim of [card.headline, ...card.bullets, card.example]) claim.quotes[0].quote = 'A cropped source.';
          }
          if (kind === 'unbound') {
            card.headline.evidenceIds = [`career-${'0'.repeat(64)}`];
            card.headline.quotes[0].evidenceId = card.headline.evidenceIds[0];
          }
          const rounds = []; let generations = 0;
          const { bank } = await buildInterviewPreparedAnswers({ ...args, brief, userDataPath: root, loadSnapshot: async () => inputSnapshot,
            onValidationRound: round => rounds.push(round),
            callText: async (prompt, opts) => {
              if (!isEntailmentPrompt(prompt)) generations++;
              else assert(!promptData(prompt, 'interview-answer-entailment-claims').some(claim => claim.text === card.headline.text),
                `${kind}: a mechanically failing claim must never reach semantic approval`);
              return answerReply(draft, prompt, opts);
            } });
          const expected = `INTERVIEW_ANSWER_${{ number: 'NUMBER', entity: 'ENTITY', candor: 'CO_BUILT', unbound: 'CITATION' }[kind]}`;
          assert(generations === 3 && bank.cards.length === 11 && !bank.cards.some(item => item.id === card.id),
            `${kind}: a persistent factual failure is dropped after the bounded repairs`);
          assert(rounds.some(round => round.failingCards.some(item => item.id === card.id && item.issueCodes.includes(expected))),
            `${kind}: diagnostics retain the factual guard that rejected the card`);
          assert(isInterviewAnswerBank(bank), `${kind}: every surviving claim still passes the sealed bank guards`);
        }
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview answer preparation: two sparse repair rounds seal eight survivors and reject seven',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-answer-floor-'));
      try {
        const { args, brief, value } = await fixture(root);
        for (const rejectedCount of [4, 5]) {
          const invalid = structuredClone(value);
          invalid.cards.filter((_, index) => ![2, 3, 4, 11].includes(index)).slice(0, rejectedCount)
            .forEach(card => { card.headline.text += ' with 997 widgets.'; });
          let generations = 0; let judgments = 0; const repairSizes = [];
          let result; let error;
          try {
            result = await buildInterviewPreparedAnswers({ ...args, brief, userDataPath: root, loadSnapshot: async () => snapshot,
              callText: async (prompt, opts) => {
                let reply;
                if (isEntailmentPrompt(prompt)) { judgments++; reply = reviewedReply(prompt); }
                else { generations++; reply = sparseReply(invalid, prompt); if (generations > 1) repairSizes.push(reply.cards.length); }
                opts.responseValidator(reply); return reply;
              } });
          } catch (caught) { error = caught; }
          assert(generations === 3 && judgments === 1 && repairSizes.every(count => count === rejectedCount), 'exactly two repairs target only failing cards; passing cards are reviewed once');
          if (rejectedCount === 4) {
            assert(!error && result.bank.cards.length === 8 && result.bank.droppedQuestions.length === 4 && isInterviewAnswerBank(result.bank), 'eight survivors seal with all omitted questions recorded');
            await publishInterviewPreparedBrief({ brief, userDataPath: root });
            const summary = await publishInterviewPreparedAnswers({ bank: result.bank, brief, userDataPath: root, loadSnapshot: async () => snapshot });
            const loaded = await loadInterviewPreparedAnswerBank({ brief, userDataPath: root, snapshot });
            assert(summary.answerCardCount === 8 && JSON.stringify(loaded.droppedQuestions) === JSON.stringify(result.bank.droppedQuestions), 'degraded metadata survives sealed publication and verified reload');
          } else assert(error?.correctionRuleIds?.includes('INTERVIEW_ANSWER_CARD_FLOOR') && !result, 'seven survivors fail Prepare without accepting a failing claim');
        }
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview answer preparation: required intro and project survive exhausted repairs with fewer verified claims',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-answer-required-project-'));
      try {
        const { args, brief, value } = await fixture(root);
        const invalid = structuredClone(value);
        for (const index of [4, 11]) invalid.cards[index].headline.text += ' with 997 widgets.';
        let generations = 0; let judgments = 0;
        const { bank } = await buildInterviewPreparedAnswers({ ...args, brief, userDataPath: root, loadSnapshot: async () => snapshot,
            callText: async (prompt, opts) => {
              const reply = isEntailmentPrompt(prompt) ? reviewedReply(prompt) : sparseReply(invalid, prompt);
              if (!isEntailmentPrompt(prompt)) generations++;
              else judgments++;
              opts.responseValidator(reply);
              return reply;
            } });
        assert(generations === 3 && judgments === 1 && bank.cards.length === 12 && !bank.droppedQuestions,
          'both required cards survive two repairs by reusing already reviewed claims without another model handoff');
        const verifiedClaims = value.cards.filter((_, index) => ![4, 11].includes(index))
          .flatMap(card => [card.headline, ...card.bullets, card.example])
          .map(({ text, evidenceIds, quotes }) => JSON.stringify({ text, evidenceIds, quotes }));
        for (const question of ['Tell me about yourself.', 'Walk me through a project.']) {
          const card = bank.cards.find(card => card.question === question);
          assert(card?.thinEvidence && card.bullets.length === 0 && !card.headline.text.includes('997') && card.headline.text === card.example.text, 'retain only a narrower verified claim and a visible thin-evidence warning');
          assert(verifiedClaims.includes(JSON.stringify(card.headline)), 'each host fallback must exactly preserve a claim already approved against its own citations');
        }
        assert(isInterviewAnswerBank(bank), 'narrowed required cards pass the sealed-bank guards');
        let unsafe;
        try {
          await buildInterviewPreparedAnswers({ ...args, brief, userDataPath: root, loadSnapshot: async () => snapshot,
            callText: async (prompt, opts) => {
              const reply = isEntailmentPrompt(prompt)
                ? reviewedReply(prompt, promptData(prompt, 'interview-answer-entailment-claims').map(item => item.path))
                : sparseReply(invalid, prompt);
              opts.responseValidator(reply); return reply;
            } });
        } catch (error) { unsafe = error; }
        assert(unsafe?.correctionRuleIds?.includes('INTERVIEW_ANSWER_REQUIRED_SAFE_CLAIM'),
          'even a required fallback cannot seal when its separate semantic review rejects every candidate');
        assert(!fs.existsSync(path.join(root, 'interview-helper-answer-banks')) && !fs.existsSync(path.join(root, 'interview-helper-answer-bindings')), 'building narrowed answers never publishes a partial bank');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview answer preparation: an exhausted why headline retains separately reviewed research in a thin bullet',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-answer-why-fallback-'));
      try {
        const { args, brief, value } = await fixture(root);
        const rejectedText = value.cards[2].headline.text;
        // Keep a separately approved role reason available. The company
        // interest frame must not rescue a failed why-role answer.
        value.cards[11].bullets[1].text = value.cards[11].bullets[1].text.replace('free tools', 'tools');
        let generations = 0; let judgments = 0;
        const { bank } = await buildInterviewPreparedAnswers({ ...args, brief, userDataPath: root, loadSnapshot: async () => snapshot,
          callText: async (prompt, opts) => {
            let reply;
            if (isEntailmentPrompt(prompt)) {
              judgments++;
              const rejectedPaths = promptData(prompt, 'interview-answer-entailment-claims')
                .filter(claim => claim.text === rejectedText).map(claim => claim.path);
              reply = reviewedReply(prompt, rejectedPaths);
            } else { generations++; reply = sparseReply(value, prompt); }
            opts.responseValidator(reply); return reply;
          } });
        const why = bank.cards.find(card => card.id === value.cards[2].id);
        assert(generations === 3 && judgments === 3 && bank.cards.length === 12 && !bank.droppedQuestions,
          `a repeatedly rejected why headline retains the card using previously reviewed claims: ${JSON.stringify({ generations, judgments, count: bank.cards.length, dropped: bank.droppedQuestions })}`);
        assert(why?.thinEvidence && why.bullets.length === 1 && why.headline.text === why.example.text,
          'the warned fallback keeps one factual career connection and a separate research bullet');
        assert(why.bullets[0].evidenceIds.every(id => bank.evidence.some(source => source.id === id && source.kind === 'research')),
          'the fallback reason keeps its own sealed research citations');
        assert(![why.headline, ...why.bullets, why.example].some(claim => claim.text === rejectedText)
          && isInterviewAnswerBank(bank), 'the semantically rejected wording never enters the sealed fallback');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview answer preparation: banks and bindings retain only the newest 100 publications',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-answer-retention-'));
      try {
        const { args, brief, bundle, value } = await fixture(root);
        const { bank } = await buildInterviewPreparedAnswers({ ...args, brief, userDataPath: root, loadSnapshot: async () => snapshot, callText: async (prompt, opts) => answerReply(value, prompt, opts) });
        const publications = [];
        const publish = async index => {
          const selected = validateInterviewBriefAssessment({ ...assessment, roleThemes: [`Release automation ${index}`] }, {
            rawResearch: research, bundle, snapshotId, canonicalJobUrl, bundleArtifactId: args.bundleArtifactId,
          });
          const selectedBank = structuredClone(bank); selectedBank.inputs.briefId = selected.briefId;
          const current = buildInterviewAnswerEvidence({ snapshot, brief: selected, bundle });
          const replacements = new Map(selectedBank.evidence.filter(item => item.kind === 'research').map(item => [item.id,
            current.find(source => source.kind === 'research' && source.entityId === item.entityId && source.sourceField === item.sourceField && source.text === item.text)]));
          selectedBank.evidence = selectedBank.evidence.map(item => replacements.get(item.id) || item);
          for (const card of selectedBank.cards) for (const statement of [card.headline, ...card.bullets, card.example]) {
            statement.evidenceIds = statement.evidenceIds.map(id => replacements.get(id)?.id || id);
            statement.quotes = statement.quotes.map(quote => ({ ...quote, evidenceId: replacements.get(quote.evidenceId)?.id || quote.evidenceId }));
          }
          await publishInterviewPreparedBrief({ brief: selected, userDataPath: root });
          await publishInterviewPreparedAnswers({ bank: selectedBank, brief: selected, userDataPath: root, loadSnapshot: async () => snapshot });
          return { brief: selected, bank: selectedBank, recordId: answerBankRecordId(selectedBank) };
        };
        const bankDirectory = path.join(root, 'interview-helper-answer-banks');
        const bindingDirectory = path.join(root, 'interview-helper-answer-bindings');
        for (let index = 0; index < 100; index++) {
          const publication = await publish(index);
          publications.push(publication);
          const date = new Date(Date.UTC(2000, 0, 1, 0, 0, index));
          await fs.promises.utimes(path.join(bankDirectory, `${publication.recordId}.json`), date, date);
          await fs.promises.utimes(path.join(bindingDirectory, `${publication.brief.briefId}.json`), date, date);
        }
        // Republishing an immutable bank must renew its retention position;
        // otherwise the next Prepare can immediately evict the current bank.
        const renewed = publications[0];
        await publishInterviewPreparedAnswers({ bank: renewed.bank, brief: renewed.brief, userDataPath: root, loadSnapshot: async () => snapshot });
        const sentinel = path.join(root, 'outside-store.json');
        await fs.promises.writeFile(sentinel, 'retain outside contents');
        for (const directory of [bankDirectory, bindingDirectory]) {
          await fs.promises.writeFile(path.join(directory, '.in-progress.tmp'), 'pending publication');
          await fs.promises.writeFile(path.join(directory, 'notes.json'), 'unrelated');
          await fs.promises.symlink(sentinel, path.join(directory, `${'f'.repeat(64)}.json`));
        }
        const newest = await publish(100);
        for (const directory of [bankDirectory, bindingDirectory]) {
          const records = (await fs.promises.readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name));
          assert(records.length === 100, 'both sealed bank and binding stores must stay capped at 100 records');
          assert(await fs.promises.readFile(path.join(directory, '.in-progress.tmp'), 'utf8') === 'pending publication'
            && await fs.promises.readFile(path.join(directory, 'notes.json'), 'utf8') === 'unrelated'
            && (await fs.promises.lstat(path.join(directory, `${'f'.repeat(64)}.json`))).isSymbolicLink(), 'retention must ignore temporary, unrelated and symlink entries');
        }
        assert(!fs.existsSync(path.join(bankDirectory, `${publications[1].recordId}.json`))
          && !fs.existsSync(path.join(bindingDirectory, `${publications[1].brief.briefId}.json`)), 'both oldest bank and binding records must expire');
        assert(await fs.promises.readFile(sentinel, 'utf8') === 'retain outside contents', 'retention must not touch a symlink target outside the store');
        const load = publication => loadInterviewPreparedAnswerBank({ brief: publication.brief, userDataPath: root, snapshot });
        assert(await load(publications[1]) === null, 'the oldest publication must expire rather than accumulate forever');
        assert((await load(renewed))?.cards.length === 12 && (await load(newest))?.cards.length === 12, 'renewed and newest prepared helpers must retain loadable banks');
        return { retainedBanks: 100, retainedBindings: 100 };
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview answer preparation: generation and secondary review seal answers without changing the brief contract',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-answer-prep-'));
      try {
        const { args, value } = await fixture(root);
        const tasks = []; let answerPrompt; let answerValidator;
        const handlers = new Map();
        const loadSnapshot = async () => snapshot;
        registerInterviewPreparationHandlers({ appInstance: { getPath: () => root }, registerHandler: (channel, handler) => handlers.set(channel, handler),
          buildBrief: args => buildInterviewBrief({ ...args, callRaw: async (_prompt, opts) => { tasks.push(opts.task); return research; }, callText: async (_prompt, opts) => { tasks.push(opts.task); opts.responseValidator(assessment); return assessment; } }),
          buildAnswers: args => buildInterviewPreparedAnswers({ ...args, loadSnapshot, callText: async (prompt, opts) => { tasks.push(opts.task); if (!isEntailmentPrompt(prompt)) { answerPrompt = prompt; answerValidator = opts.responseValidator; } return answerReply(value, prompt, opts); } }),
          publishAnswers: args => publishInterviewPreparedAnswers({ ...args, loadSnapshot }),
          loadAnswers: args => loadInterviewPreparedAnswerBank({ ...args, loadSnapshot }),
        });
        const reply = await handlers.get('build-interview-brief')({}, args);
        assert(tasks.join(',') === 'interview-brief-research,interview-brief-assessment,interview-answer-bank,interview-answer-bank', 'Prepare must generate and independently judge candidate claims after the two no-candidate research steps');
        assert(reply.answerBankAvailable && reply.answerCardCount === 12 && !Object.hasOwn(reply, 'bank') && !JSON.stringify(reply.brief).includes('Fixture Labs'), 'only an opaque readiness summary reaches the canvas; career answers never enter the brief');
        assert(answerPrompt.includes('Release automation') && answerPrompt.includes('Led deployment automation.') && answerPrompt.includes('interview-answer-submitted-positioning') && !answerPrompt.includes('evidenceSegmentContents'), 'job themes, restricted approved evidence and captured positioning drive selection');
        const bad = structuredClone(value); bad.cards[0].bullets[0].text += ' Saved $1 million.';
        assert(answerValidator(bad).cards.length === 12, 'transport accepts internal drafts so card truth failures reach the sparse host loop');
        const invalid = inspectInterviewAnswerCards(bad.cards, { snapshot, brief: reply.brief,
          bundle: JSON.parse(await fs.promises.readFile(path.join(root, 'interview-helper-artifacts', `${args.bundleArtifactId}.json`), 'utf8')),
          canonicalJobUrl, bundleArtifactId: args.bundleArtifactId }).failures;
        assert(invalid.some(issue => /NUMBER/u.test(issue.rule) && issue.instruction.includes('million')), 'host still rejects unsupported numbers and names the worker’s offending value');
        const loaded = await handlers.get('load-interview-prepared-brief')({}, { nodeId: args.nodeId, briefRecordId: reply.briefRecordId, snapshotId, canonicalJobUrl, bundleArtifactId: args.bundleArtifactId, bundleArtifactDigest: reply.brief.inputs.applicationArtifactDigest });
        assert(loaded.answerBankAvailable && loaded.answerCardCount === 12, 'host-verified bank readiness survives a renderer reload');
        return { tasks, cards: reply.answerCardCount };
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview answer preparation: stable resume prompt, no partial acceptance and cancellation before another handoff',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-answer-resume-'));
      try {
        const { args, brief, value } = await fixture(root);
        const prompts = [];
        const run = selectedBrief => buildInterviewPreparedAnswers({ ...args, brief: selectedBrief, userDataPath: root, loadSnapshot: async () => snapshot,
          callText: async (prompt, opts) => { if (!isEntailmentPrompt(prompt)) prompts.push(prompt); return answerReply(value, prompt, opts); } });
        await run(brief);
        await run({ ...brief, createdAt: '2026-01-01T00:00:00.000Z' });
        assert(canonicalizeGeneratedUntrustedBoundaryNonces(prompts[0]) === canonicalizeGeneratedUntrustedBoundaryNonces(prompts[1]), 'wall-clock brief publication must not change the durable answer-step identity on resume');
        await publishInterviewPreparedBrief({ brief, userDataPath: root });
        assert(await loadInterviewPreparedAnswerBank({ brief, userDataPath: root, snapshot }) === null, 'a research-only legacy brief must never gain unsealed candidate answers');
        assert(!fs.existsSync(path.join(root, 'interview-helper-answer-banks')) && !fs.existsSync(path.join(root, 'interview-helper-answer-bindings')), 'legacy lookup creates no answer store');
        const cancelled = new AbortController(); cancelled.abort(); let called = false;
        const rejected = await buildInterviewPreparedAnswers({ ...args, brief, signal: cancelled.signal, userDataPath: root, loadSnapshot: async () => snapshot, callText: async () => { called = true; return value; } }).then(() => false, () => true);
        assert(rejected && !called, 'a cancelled preparation must not start a third bridge handoff');
        const handlers = new Map();
        registerInterviewPreparationHandlers({ appInstance: { getPath: () => root }, registerHandler: (channel, handler) => handlers.set(channel, handler), buildBrief: async () => ({ brief }), buildAnswers: async () => { throw new Error('private provider/path diagnostic'); } });
        let failure; try { await handlers.get('build-interview-brief')({}, args); } catch (error) { failure = error; }
        assert(failure && !failure.message.includes('private provider') && !fs.existsSync(path.join(root, 'interview-helper-answer-bindings')), 'third-step failure returns fixed recovery text and cannot publish partial answers');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview answer preparation: a semantic rejection repairs only the failed card with a separately bound review',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-answer-semantic-correction-'));
      try {
        const { args, brief, value } = await fixture(root);
        const corrected = structuredClone(value);
        corrected.cards[0].headline.text = 'I created a deployment automation guide and maintained the deployment automation system.';
        let generations = 0; let judgments = 0; let correctionPrompt;
        const { bank } = await buildInterviewPreparedAnswers({ ...args, brief, userDataPath: root, loadSnapshot: async () => snapshot,
          callText: async (prompt, opts) => {
            let reply;
            if (isEntailmentPrompt(prompt)) {
              judgments += 1;
              reply = reviewedReply(prompt, judgments === 1 ? ['cards[0].headline'] : []);
            } else {
              generations += 1;
              if (generations > 1) correctionPrompt = prompt;
              reply = sparseReply(generations === 1 ? value : corrected, prompt);
            }
            opts.responseValidator(reply);
            return reply;
          } });
        assert(generations === 2 && judgments === 2 && bank.cards[0].headline.text === corrected.cards[0].headline.text, 'a valid negative semantic verdict must trigger a new draft and separately bound positive verdict');
        assert(correctionPrompt.includes('cards[0].headline') && /ENTAILMENT/u.test(correctionPrompt), 'semantic correction must identify the claim path and failed rule');
        assert(promptData(correctionPrompt, 'interview-answer-failing-cards').length === 1 && !correctionPrompt.includes('COMPLETE bank'), 'repair must contain only the failed card');
        assert(JSON.stringify(bank.cards.slice(1)) === JSON.stringify(value.cards.slice(1)), 'all passing cards remain byte-for-byte unchanged');
        assert(!fs.existsSync(path.join(root, 'interview-helper-answer-banks')), 'building corrected answers alone must never publish a partial or accepted store record');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview answer preparation: mechanical failures skip review until repaired and persistent semantic failures degrade',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-answer-bounded-correction-'));
      try {
        const { args, brief, value } = await fixture(root);
        const invalid = structuredClone(value); invalid.cards[0].headline.text += ' by 91%';
        let generations = 0; let judgments = 0; let correctionPrompt;
        const result = await buildInterviewPreparedAnswers({ ...args, brief, userDataPath: root, loadSnapshot: async () => snapshot,
          callText: async prompt => {
            if (isEntailmentPrompt(prompt)) { judgments += 1; return reviewedReply(prompt); }
            generations += 1;
            if (generations > 1) correctionPrompt = prompt;
            // Deliberately bypass the transport validator. The host must still
            // reject this response before asking any semantic judge about it.
            return sparseReply(generations === 1 ? invalid : value, prompt);
          } });
        assert(result.bank.cards.length === 12 && generations === 2 && judgments === 2, 'review passing cards once, then review only the repaired card');
        assert(correctionPrompt.includes('cards[0].headline') && /INTERVIEW_ANSWER_NUMBER/u.test(correctionPrompt), 'mechanical correction must identify the failed numeric rule and claim');
        assert(correctionPrompt.includes('91') && correctionPrompt.includes('never a template'), 'delta guidance names offending numbers and treats rejected wording as evidence');
        generations = 0; judgments = 0;
        const degraded = await buildInterviewPreparedAnswers({ ...args, brief, userDataPath: root, loadSnapshot: async () => snapshot,
            callText: async (prompt, opts) => {
              let reply;
              if (isEntailmentPrompt(prompt)) { judgments += 1; reply = reviewedReply(prompt, ['cards[0].headline']); }
              else { generations += 1; reply = sparseReply(value, prompt); }
              opts.responseValidator(reply);
              return reply;
            } });
        assert(degraded.bank.cards.length === 11 && generations === 3 && judgments === 3, 'after two repairs discard the unsupported card and keep eleven approved cards');
        assert(degraded.bank.droppedQuestions[0] === value.cards[0].question && isInterviewAnswerBank(degraded.bank), 'sealed degradation records the omitted question and passes every bank guard');
        assert(!fs.existsSync(path.join(root, 'interview-helper-answer-banks')) && !fs.existsSync(path.join(root, 'interview-helper-answer-bindings')), 'building candidates alone never publishes a store record');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview answer preparation: source bindings and unsafe private lookup records fail closed',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-answer-binding-'));
      try {
        const { args, brief, bundle, value } = await fixture(root);
        await publishInterviewPreparedBrief({ brief, userDataPath: root });
        const { bank } = await buildInterviewPreparedAnswers({ ...args, brief, userDataPath: root, loadSnapshot: async () => snapshot, callText: async (prompt, opts) => answerReply(value, prompt, opts) });
        await publishInterviewPreparedAnswers({ bank, brief, userDataPath: root, loadSnapshot: async () => snapshot });
        const load = (extra = {}) => loadInterviewPreparedAnswerBank({ brief, userDataPath: root, snapshot, ...extra });
        assert((await load())?.cards.length === 12, 'an intact bound bank reloads');
        assert(await load({ snapshot: { ...snapshot, snapshotId: 'b'.repeat(64) } }) === null, 'changing the approved career pin invalidates the bank');
        const changed = validateInterviewBriefAssessment({ ...assessment, roleThemes: ['Changed role'] }, { rawResearch: research, bundle, snapshotId, canonicalJobUrl, bundleArtifactId: args.bundleArtifactId });
        await publishInterviewPreparedBrief({ brief: changed, userDataPath: root });
        assert(await load({ brief: changed }) === null, 'changed brief semantics cannot reuse another brief answer lookup');
        const file = path.join(root, 'interview-helper-answer-bindings', `${brief.briefId}.json`);
        const saved = await fs.promises.readFile(file);
        await fs.promises.unlink(file); await fs.promises.symlink(path.join(root, 'missing.json'), file);
        assert(await load() === null, 'a symlinked binding must not resolve');
        await fs.promises.unlink(file); await fs.promises.writeFile(file, 'x'.repeat(2049), { mode: 0o600 });
        assert(await load() === null, 'oversized binding is bounded before JSON parsing');
        await fs.promises.writeFile(file, saved);
        const replacement = structuredClone(bank); replacement.cards[0].headline.text = 'I created a deployment automation guide and maintained the deployment automation system.';
        await publishInterviewPreparedAnswers({ bank: replacement, brief, userDataPath: root, loadSnapshot: async () => snapshot });
        assert((await load()).cards[0].headline.text.startsWith('I created'), 'explicit repreparation atomically replaces a prior bank with the same semantic brief');
        await fs.promises.writeFile(file, 'corrupt', { mode: 0o600 });
        await publishInterviewPreparedAnswers({ bank, brief, userDataPath: root, loadSnapshot: async () => snapshot });
        assert((await load()).cards[0].headline.text === bank.cards[0].headline.text, 'a fresh validated Prepare repairs a corrupt lookup instead of retaining stale cards');
        const source = path.join(root, 'interview-helper-artifacts', `${args.bundleArtifactId}.json`);
        const tampered = JSON.parse(await fs.promises.readFile(source, 'utf8')); tampered.applicationPositioning.resume = 'Different submitted text.';
        await fs.promises.writeFile(source, JSON.stringify(tampered));
        assert(await load() === null, 'changed captured application content invalidates the bank through its content hash');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
];
