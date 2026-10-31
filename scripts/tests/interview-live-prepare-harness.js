import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import electronPkg from 'electron';
import { assert } from './testHelpers.js';
import { writeApprovedCareerSnapshotFixture } from './careerSnapshotFixture.mjs';
import { loadInterviewHelperCareerSnapshot } from '../../electron/ipc/interviewHelper.js';
import { captureInterviewPreparationBundle, isPublishedInterviewBrief, validateInterviewBriefAssessment } from '../../electron/ipc/interviewPreparation.js';
import { buildInterviewAnswerEvidence, INTERVIEW_ANSWER_BANK_SCHEMA, INTERVIEW_ANSWER_QUESTION_CATALOG, isInterviewAnswerBank } from '../../electron/ipc/interviewAnswerBank.js';
import { interviewAnswerEntailmentClaims } from '../../electron/ipc/interviewAnswerEntailment.js';
import { deriveInterviewResumeConsistency } from '../../electron/ipc/interviewResumeCoverage.js';
import { installWriteGuard } from '../interview-live-prepare-harness.mjs';

const execute = promisify(execFile);
// Match the compact live handoff. Sealed expected cards retain their complete
// exact quotes; the host restores them from evidence IDs before validation.
const compactHandoff = value => value.cards ? { ...value, cards: value.cards.map(card => ({ ...card,
  extensions: card.extensions.map(point => Object.fromEntries(Object.entries(point).filter(([key]) => key !== 'quotes'))),
})) } : value;
const canonicalJobUrl = 'https://jobs.example.test/interview';
const COMPANY_FACT = 'Example Studio builds free tools for teams.';
const research = `${COMPANY_FACT} Source: https://example.test/about`;
const assessment = {
  role: { title: 'Engineer', company: 'Example Studio', location: 'Remote', summary: '' },
  roleThemes: ['Python services'],
  companyFacts: [{ fact: COMPANY_FACT, sourceUrl: 'https://example.test/about', sourceDate: 'unknown', evidenceQuote: COMPANY_FACT }],
  recentContext: [], likelyQuestions: ['How did you build a service?'], questionsToAsk: [], applicationPositioning: [], warnings: [],
};

async function fingerprint(root) {
  const entries = [];
  async function visit(relative) {
    const filename = path.join(root, relative);
    const stat = await fs.promises.lstat(filename);
    entries.push({ relative, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
      ...(stat.isFile() ? { digest: crypto.createHash('sha256').update(await fs.promises.readFile(filename)).digest('hex') } : {}) });
    if (stat.isDirectory()) for (const child of (await fs.promises.readdir(filename)).sort()) await visit(path.join(relative, child));
  }
  await visit('');
  return JSON.stringify(entries);
}

async function fixture(root) {
  const source = path.join(root, 'user-data');
  const bundleDirectory = path.join(root, 'bundle');
  const staging = path.join(root, 'staging');
  const out = path.join(root, 'out');
  const topics = ['deployment', 'validation', 'documentation', 'migration', 'integration', 'operations', 'testing', 'planning', 'reporting', 'support', 'monitoring', 'tooling'];
  const claims = topics.map(topic => `Built a Python ${topic} service for internal staff workflows. I tested the ${topic} service against a documented checklist. I reviewed the ${topic} guide with internal staff. I automated the ${topic} status report for internal staff. I added timeout handling to the ${topic} service. I tested ${topic} recovery steps for internal staff.`);
  const { snapshotId } = await writeApprovedCareerSnapshotFixture({ achievementClaims: claims });
  await fs.promises.cp(electronPkg.app.getPath('userData'), source, { recursive: true });
  for (const directory of [source, path.join(source, 'career-snapshot-store'), path.join(source, 'career-snapshot-store', 'career-snapshots')]) {
    await fs.promises.chmod(directory, 0o755);
  }
  await fs.promises.mkdir(bundleDirectory);
  await fs.promises.mkdir(staging);
  await fs.promises.mkdir(out);
  await fs.promises.writeFile(path.join(bundleDirectory, 'Application.html'), `<section data-ic-document-panel="resume"><main>${claims.map(claim => `<p>${claim}</p>`).join('')}</main></section>`);
  await fs.promises.writeFile(path.join(bundleDirectory, 'Original Job Listing.md'), '# Engineer\n\n**Company:** Example Studio\n**Location:** Remote\n\n---\n\nBuild Python services.');
  const captured = await captureInterviewPreparationBundle({ directory: bundleDirectory, userDataPath: staging });
  const bundle = JSON.parse(await fs.promises.readFile(path.join(staging, 'interview-helper-artifacts', `${captured.artifactId}.json`), 'utf8'));
  // Build fixture citations from the same projection the production answer step uses.
  const snapshot = await loadInterviewHelperCareerSnapshot({ snapshotId, userDataPath: staging,
    readSnapshot: async () => JSON.parse(await fs.promises.readFile(path.join(source, 'career-snapshot-store', 'career-snapshots', `${snapshotId}.json`), 'utf8')) });
  const brief = validateInterviewBriefAssessment(assessment, { rawResearch: research, snapshotId, canonicalJobUrl, bundle, bundleArtifactId: captured.artifactId });
  const projection = buildInterviewAnswerEvidence({ snapshot, brief, bundle });
  const careers = projection.filter(item => item.kind === 'career');
  const motivation = projection.find(item => item.kind === 'research' && item.text === COMPANY_FACT);
  assert(careers.length === 12, 'synthetic approved snapshot must expose twelve distinct career sources');
  const statement = (source, text) => ({ text, evidenceIds: [source.id], quotes: [{ evidenceId: source.id, quote: source.text }] });
  const intents = [INTERVIEW_ANSWER_QUESTION_CATALOG.at(-1), ...INTERVIEW_ANSWER_QUESTION_CATALOG.slice(1, 12)];
  intents[11] = INTERVIEW_ANSWER_QUESTION_CATALOG[0];
  const bankResponse = { cards: intents.map((entry, index) => {
    const career = careers[index]; const topic = topics[index];
    const why = index === 2 || index === 3;
    const headline = why ? `This ${index === 2 ? 'role' : 'company'} interests me because ${COMPANY_FACT}`
      : `I built a Python ${topic} service for internal staff workflows.`;
    const first = `I tested the ${topic} service against a documented checklist.`;
    const second = index === 11 ? `This role interests me because ${COMPANY_FACT}` : `I reviewed the ${topic} guide with internal staff.`;
    const example = `I automated the ${topic} status report for internal staff.`;
    return {
      id: `card-${index + 1}`, question: entry.question, variants: [...entry.variants], thinEvidence: true,
      headline: statement(why ? motivation : career, headline), bullets: [first, second].map((text, bullet) => ({ stage: 'point', ...statement(index === 11 && bullet === 1 ? motivation : career, text) })),
      example: statement(career, example),
      extensions: [
        { id: `card-${index + 1}-timeouts`, ...statement(career, `I added timeout handling to the ${topic} service.`) },
        { id: `card-${index + 1}-recovery`, ...statement(career, `I tested ${topic} recovery steps for internal staff.`) },
      ], consistency: { consistentWithResume: true, resumeQuote: career.text },
    };
  }) };
  for (const card of bankResponse.cards) {
    card.consistency = deriveInterviewResumeConsistency([card.headline, ...card.bullets, card.example], careers, bundle.applicationPositioning.resume);
    assert(card.consistency?.consistentWithResume, 'each synthetic harness card has a genuine captured résumé match');
  }
  const invalidAssessment = structuredClone(assessment);
  invalidAssessment.companyFacts[0].fact = 'Invented unsourced company claim.';
  const invalidBank = structuredClone(bankResponse);
  invalidBank.cards[0].bullets[0].text += ' Saved $1 million.';
  invalidBank.cards[1].extensions.push({ id: 'invented-outcome', ...statement(careers[1], 'I reduced validation costs by 80 percent.') });
  const structured = value => JSON.stringify({ handoffCode: '{{HANDOFF_CODE}}', ...compactHandoff(value) });
  const judge = cards => ({ verdicts: interviewAnswerEntailmentClaims({ cards }).map(({ path, claimDigest }) => ({ path, claimDigest, entailed: true, reason: 'SUPPORTED' })) });
  // The transport accepts a draft as internal data. The host reviews the eleven
  // mechanically valid cards, then requests and reviews only the failed card.
  const repair = { cards: [bankResponse.cards[0]] };
  const responses = [`Handoff: {{HANDOFF_CODE}}\n${research}`, structured(invalidAssessment), structured(assessment),
    structured(invalidBank), structured(judge(bankResponse.cards.slice(1))), structured(repair), structured(judge(repair.cards))];
  for (const [index, response] of responses.entries()) await fs.promises.writeFile(path.join(out, `${String(index + 1).padStart(3, '0')}.response.txt`), response);
  return { source, bundleDirectory, out, snapshotId, bundle, snapshot, bankResponse };
}

function harnessArguments({ source, snapshotId, bundleDirectory, out }) {
  return ['--import', './scripts/test-stubs/register.mjs', 'scripts/interview-live-prepare-harness.mjs',
    '--user-data', source, '--snapshot-id', snapshotId, '--job-url', canonicalJobUrl, '--bundle-dir', bundleDirectory, '--out', out, '--transport', 'replay'];
}

export default [
  {
    name: 'interview live prepare harness: extension handoff stays compact and requires dedicated points',
    run() {
      const card = INTERVIEW_ANSWER_BANK_SCHEMA.properties.cards.items;
      const extension = card.properties.extensions;
      // The field is required on every card; the prompt asks for 2–4 points, but an
      // empty list is the honest answer when no valid additional evidence remains.
      assert(card.required.includes('extensions') && extension.minItems === 0 && extension.maxItems === 4,
        'fresh handoffs must require an extensions list of at most four dedicated points on every card');
      assert(extension.items.required.join(',') === 'id,text,evidenceIds' && !Object.hasOwn(extension.items.properties, 'quotes'),
        'extension wire claims must bind evidence IDs without repeated full source paragraphs');
    },
  },
  {
    name: 'interview live prepare harness: write guard refuses input mutations and output link escapes',
    run: async () => {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-live-write-guard-')));
      const source = path.join(root, 'protected.txt');
      const output = path.join(root, 'out');
      let restore = () => {};
      try {
        await fs.promises.mkdir(output);
        await fs.promises.writeFile(source, 'protected synthetic evidence', { mode: 0o640 });
        await fs.promises.symlink(source, path.join(output, 'symbolic.txt'));
        await fs.promises.link(source, path.join(output, 'hard.txt'));
        const before = await fingerprint(source);
        restore = installWriteGuard([output]);
        const refuses = async (action, code) => {
          let caught;
          try { await action(); } catch (error) { caught = error; }
          assert(caught?.code === code, `write guard must refuse mutation with ${code}`);
        };
        await refuses(() => fs.promises.writeFile(source, 'overwrite'), 'INPUT_WRITE_REFUSED');
        await refuses(() => fs.writeFileSync(source, 'overwrite'), 'INPUT_WRITE_REFUSED');
        await refuses(() => fs.promises.chmod(source, 0o777), 'INPUT_WRITE_REFUSED');
        const handle = await fs.promises.open(source, 'r');
        try { await refuses(() => handle.utimes(new Date(0), new Date(0)), 'INPUT_WRITE_REFUSED'); }
        finally { await handle.close(); }
        await refuses(() => fs.promises.writeFile(path.join(output, 'symbolic.txt'), 'escape'), 'UNSAFE_OUTPUT');
        await refuses(() => fs.writeFileSync(path.join(output, 'hard.txt'), 'escape'), 'UNSAFE_OUTPUT');
        await refuses(() => fs.promises.symlink(source, path.join(output, 'new-link.txt')), 'INPUT_WRITE_REFUSED');
        await fs.promises.writeFile(path.join(output, 'owned.txt'), 'owned output');
        assert(await fingerprint(source) === before && await fs.promises.readFile(path.join(output, 'owned.txt'), 'utf8') === 'owned output',
          'refused writes must preserve source content and metadata while owned output remains writable');
        return { refused: 7 };
      } finally {
        restore();
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview live prepare harness: replay exercises assessment rejection and sparse card repair before sealing without input writes',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-live-prepare-test-'));
      try {
        const context = await fixture(root);
        const beforeSource = await fingerprint(context.source);
        const beforeBundle = await fingerprint(context.bundleDirectory);
        const run = await execute(process.execPath, harnessArguments(context), { cwd: process.cwd(), timeout: 20_000, maxBuffer: 1024 * 1024 }).catch(async error => {
          // Only synthetic fixture data is ever used by this test.
          const diagnostic = await fs.promises.readFile(path.join(context.out, 'failure.json'), 'utf8').catch(() => 'no failure artifact');
          throw new Error(`Synthetic harness replay failed: ${diagnostic}`, { cause: error });
        });
        assert(!`${run.stdout}${run.stderr}`.includes('Ada Lovelace') && !`${run.stdout}${run.stderr}`.includes('ada@example.test')
          && !`${run.stdout}${run.stderr}`.includes('Saved $1 million.'), 'harness terminal output must not expose source identity or responses');
        const read = async name => JSON.parse(await fs.promises.readFile(path.join(context.out, name), 'utf8'));
        const verdicts = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(index => read(`${String(index).padStart(3, '0')}.validation.json`)));
        assert(verdicts.map(value => value.accepted).join(',') === 'true,false,true,true,true,true,true', 'brief truth failures must trigger transport correction while candidate drafts stay internal until host card checks and repairs');
        assert(JSON.stringify(verdicts[1]).includes('RAW RESEARCH'), 'assessment rejection artifact must retain the real validator reason');
        const assessmentCorrection = await fs.promises.readFile(path.join(context.out, '003.prompt.txt'), 'utf8');
        const firstJudge = await fs.promises.readFile(path.join(context.out, '005.prompt.txt'), 'utf8');
        const answerCorrection = await fs.promises.readFile(path.join(context.out, '006.prompt.txt'), 'utf8');
        const repairedJudge = await fs.promises.readFile(path.join(context.out, '007.prompt.txt'), 'utf8');
        assert(assessmentCorrection.includes('--- CORRECTION REQUIRED ---') && assessmentCorrection.includes('RAW RESEARCH')
          && answerCorrection.includes('SPARSE CARD REPAIR') && answerCorrection.includes('INTERVIEW_ANSWER_NUMBER')
          && answerCorrection.includes('cards[0].bullets[0]') && answerCorrection.includes('million'), 'sparse repair must name the failed claim, numeric rule and the worker’s own unsupported words');
        assert(!answerCorrection.includes('--- CORRECTION REQUIRED ---') && !answerCorrection.includes('Regenerate the entire answer')
          && answerCorrection.includes('"id":"card-1"') && !answerCorrection.includes('"id":"card-2"'), 'host repair must request only the failing card and avoid transport whole-bank regeneration');
        assert(firstJudge.includes('INTERVIEW ANSWER ENTAILMENT REVIEW') && firstJudge.includes('"path":"cards[10].example"')
          && !firstJudge.includes('"path":"cards[11].headline"') && !firstJudge.includes('Saved $1 million.'), 'only eleven mechanically valid cards may reach the first independent judge');
        assert(repairedJudge.includes('"path":"cards[0].example"') && !repairedJudge.includes('"path":"cards[1].headline"'), 'the second independent judge must review only the repaired card');
        const brief = await read('final-brief.json');
        const bank = await read('final-answer-bank.json');
        const report = await read('report.json');
        const rounds = report.answerValidationRounds.filter(round => round.phase === 'validation');
        assert(rounds.length === 2 && rounds[0].survivingCardCount === 11 && rounds[1].survivingCardCount === 12,
          'each host validation round must report surviving cards after mechanical and semantic checks');
        assert(rounds[0].failingCards.length === 1 && rounds[0].failingCards[0].id === 'card-1'
          && rounds[0].failingCards[0].issueCodes.includes('INTERVIEW_ANSWER_NUMBER') && !rounds[1].failingCards.length,
        'round diagnostics must identify each failing card and its issue codes');
        assert(verdicts[3].answerValidationRounds[0].survivingCardCount === 11
          && verdicts[5].answerValidationRounds[0].survivingCardCount === 12,
        'draft and sparse repair transport records must retain the resulting host card diagnostics');
        assert(report.survivingCardCount === 12 && report.droppedCards.length === 0
          && (await read('final-dropped-cards.json')).length === 0,
        'successful Prepare must record the final count and explicit empty dropped list');
        assert(bank.cards.every(card => card.extensions?.length === 2) && !bank.cards.some(card => card.extensions.some(point => point.id === 'invented-outcome')),
          'individual extension truth failures must drop sparsely while two grounded points survive on every card');
        assert(firstJudge.includes('"path":"cards[0].extensions[0]"') && !firstJudge.includes('invented-outcome') && !firstJudge.includes('80 percent'),
          'independent judge must review surviving extension claims without an invalid point or extra card repair');
        assert(isPublishedInterviewBrief(brief) && bank.cards.length === 12
          && isInterviewAnswerBank(bank, { snapshot: context.snapshot, brief, bundle: context.bundle, canonicalJobUrl, bundleArtifactId: brief.inputs.applicationArtifactId }), 'final artifacts must pass real sealing and input-binding validators');
        assert(JSON.stringify(bank.cards.slice(1)) === JSON.stringify(context.bankResponse.cards.slice(1)), 'sparse repair must retain every passing card byte for byte');
        assert(await fingerprint(context.source) === beforeSource && await fingerprint(context.bundleDirectory) === beforeBundle,
          'harness must preserve the exact input contents, directory modes and metadata');
        // Convert the synthetic response templates into actual saved wire
        // responses so this rerun exercises the live replay contract too.
        const savedResponses = [];
        for (let index = 1; index <= 7; index += 1) {
          const number = String(index).padStart(3, '0');
          const prompt = await fs.promises.readFile(path.join(context.out, `${number}.prompt.txt`), 'utf8');
          const handoffCode = prompt.match(/^=== (HANDOFF-[2-9A-HJ-NP-Z]{6})\b/u)?.[1];
          assert(handoffCode, 'each real prompt must identify the wire handoff code');
          const filename = path.join(context.out, `${number}.response.txt`);
          const response = (await fs.promises.readFile(filename, 'utf8')).replaceAll('{{HANDOFF_CODE}}', handoffCode);
          assert(!response.includes('{{HANDOFF_CODE}}'), 'saved responses must contain actual transport codes before replay');
          await fs.promises.writeFile(filename, response);
          savedResponses.push({ filename, response });
        }
        await execute(process.execPath, harnessArguments(context), { cwd: process.cwd(), timeout: 20_000, maxBuffer: 1024 * 1024 });
        assert((await read('final-brief.json')).briefId === brief.briefId && JSON.stringify(await read('final-answer-bank.json')) === JSON.stringify(bank), 'replaying actual saved transport codes must preserve semantic sealed results');
        for (const { filename, response } of savedResponses) assert(await fs.promises.readFile(filename, 'utf8') === response, 'replay must consume saved wire responses unchanged');
        let refused = false;
        try { await execute(process.execPath, harnessArguments({ ...context, out: path.join(context.source, 'unsafe-output') }), { cwd: process.cwd(), timeout: 10_000 }); } catch { refused = true; }
        assert(refused && !fs.existsSync(path.join(context.source, 'unsafe-output')) && await fingerprint(context.source) === beforeSource,
          'overlapping output must be refused before any source write');
        return { handoffs: 7, rejected: 1, repairedCards: 1, cards: bank.cards.length };
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview live prepare harness: exhausted repairs retain every failing card reason and final survivor count',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-live-prepare-drops-'));
      try {
        const context = await fixture(root);
        const draft = structuredClone(context.bankResponse);
        const failedIds = new Set([1, 5, 6, 7, 8].map(index => draft.cards[index].id));
        for (const card of draft.cards) if (failedIds.has(card.id)) card.bullets[0].text += ' Saved $1 million.';
        const structured = value => JSON.stringify({ handoffCode: '{{HANDOFF_CODE}}', ...compactHandoff(value) });
        const passing = draft.cards.filter(card => !failedIds.has(card.id));
        const review = { verdicts: interviewAnswerEntailmentClaims({ cards: passing }).map(({ path, claimDigest }) => ({ path, claimDigest, entailed: true, reason: 'SUPPORTED' })) };
        const repair = { cards: draft.cards.filter(card => failedIds.has(card.id)) };
        for (const [index, response] of [structured(draft), structured(review), structured(repair), structured(repair)].entries()) {
          await fs.promises.writeFile(path.join(context.out, `${String(index + 4).padStart(3, '0')}.response.txt`), response);
        }
        let failed = false;
        try { await execute(process.execPath, harnessArguments(context), { cwd: process.cwd(), timeout: 20_000, maxBuffer: 1024 * 1024 }); }
        catch { failed = true; }
        const read = async name => JSON.parse(await fs.promises.readFile(path.join(context.out, name), 'utf8'));
        const report = await read('report.json');
        const rounds = report.answerValidationRounds.filter(round => round.phase === 'validation');
        assert(failed && report.status === 'failed' && !fs.existsSync(path.join(context.out, 'final-answer-bank.json')),
          'a bank below the truth-checked floor must remain unpublished');
        assert(rounds.length === 3 && rounds.every(round => round.survivingCardCount === 7 && round.failingCards.length === 5
          && round.failingCards.every(card => failedIds.has(card.id) && card.issueCodes.includes('INTERVIEW_ANSWER_NUMBER'))),
        'all exhausted rounds must retain all five failing cards and their numeric issue codes');
        const dropped = await read('final-dropped-cards.json');
        assert(report.survivingCardCount === 7 && dropped.length === 5 && dropped.every(card => failedIds.has(card.id)
          && card.issueCodes.includes('INTERVIEW_ANSWER_NUMBER') && card.issues.some(issue => issue.path.endsWith('.bullets[0]'))),
        'failed Prepare must persist a final dropped list with a precise per-card rule and claim path');
        const repairRecords = await Promise.all([6, 7].map(index => read(`${String(index).padStart(3, '0')}.validation.json`)));
        assert(repairRecords.every(record => record.answerValidationRounds.some(round => round.phase === 'validation'
          && round.survivingCardCount === 7 && round.failingCards.length === 5)),
        'each sparse repair recording must show the full host failure diagnostics even if no judge round is needed');
        return { rounds: rounds.length, surviving: report.survivingCardCount, dropped: dropped.length };
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
];
