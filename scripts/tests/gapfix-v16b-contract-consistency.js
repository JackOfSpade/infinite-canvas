// One contract, said once: what a proof-bearing paragraph owes.
//
// The failure these tests pin. The claim budget told the writer that only the first
// proof-bearing paragraph owes a claim span and a later one may leave it out. Beside
// that, the same cover-letter contract, the review contract, the correction brief and
// the error text still said that every later paragraph keeps its claim, proof and
// relevance, that all three spans are each an exact span of the paragraph, and that
// the audit must carry all four fields. A writer that obeyed the older sentences kept
// the closed-grammar abstract claim in every paragraph: the filler the budget was
// meant to remove. The contradiction lived in prose no test read, because each test
// pinned the sentence it was written for.
//
// What each group below proves:
//   scanner    a scanner for sentences that make every proof-bearing paragraph owe a
//              claim or a relevance span is itself proved: it flags each phrasing the
//              reviewers found (and variants), and it passes the budget sentences
//   surface    nothing the system prints says it: the exported rule constants, every
//              prose line of the prompt, schema and error sources, the docs, the
//              contracts the real protocol prints (cover-letter, review), and the
//              correction brief for a letter paragraph
//   one voice  the span-budget block is printed once in each contract and in the
//              brief, built from the exported constants, the generationAudit shape
//              notation marks the optional fields, and the shape error names the
//              fields each paragraph owes
//   guidance   the placement rule separates the claim phrase from the relevance
//              sentence, the repair rule names the host-required functions from the
//              constants (and follows them when a constant moves), and the opening and
//              proof-count rules cover the cases they left open
//   relevance  (v16c) a second scanner flags the older sentences that push EVERY paragraph toward a standalone statement of relevance ("point, proof and relevance",
//              "relevance links need their own path", "ties them to the target work"); nothing the system prints says them, and the opening and the reference
//              criterion say once, in one voice, how the role and the employer are named
//
// Every fixture is SYNTHETIC (invented careers in unrelated fields). Nothing in
// production names any of them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert } from './testHelpers.js';
import { getLocalApplicationHandoff, queueLocalApplicationJob, submitLocalApplicationHandoff } from '../test-dependencies.js';
import * as checks from '../../electron/ipc/coverLetterChecks.js';
import * as guidance from '../../electron/ipc/applicationWriterGuidance.js';
import * as convergence from '../../electron/ipc/applicationRepairConvergence.js';
import { APPLICATION_QUALITY_CRITERIA, pasteCorrectionPrompt } from '../../electron/ipc/localAiApplication.js';

const read = file => fs.readFileSync(path.resolve(file), 'utf8');

// ---------------------------------------------------------------------------
// The scanner.
// ---------------------------------------------------------------------------
// A clause that quantifies over paragraphs (every, each, all), says that paragraph
// keeps, records, owes, carries, supplies or needs something, and names a claim or a
// relevance within a few words, makes every proof-bearing paragraph owe that span. The
// windows are word counts, not sentence boundaries, so a sentence that merely mentions
// relevance elsewhere ("each body paragraph's point, proof, and relevance across as many
// sentences as clarity requires") is not read as an obligation. A clause is let through
// only when it also says the span may be left out or is the first paragraph's alone.
const OWING_VERBS = '(?:keeps?|records?|owes?|carr(?:y|ies)|supplies|supply|needs?|requires?|must|holds?|names?)';
const UNIVERSAL_OWNERSHIP = new RegExp(
  String.raw`\b(?:every|each|all)\b(?:\s+[\p{L}-]+){0,3}?\s+paragraphs?(?:['’]s)?\b(?:\s+[\p{L}'’,-]+){0,4}?\s+${OWING_VERBS}\b(?:\s+[\p{L}'’-]+){0,6}?\s+(?:claims?|relevance)\b`, 'iu');
const SPAN_REQUIRED_OF_EVERY = /\b(?:claims?|relevance)\b(?:\s+[\p{L}'’,-]+){0,6}?\s+(?:is|are)\s+(?:required|owed|needed)\s+(?:of|from|in)\s+(?:every|each|all)\b/iu;
const SPAN_MAY_BE_OMITTED = /\b(?:may (?:leave|omit)|leaves? (?:it|the claim|the relevance) out|omits?|where one is recorded|that records|it records|records it|no (?:claim|relevance)|neither|owes only|owes no|not owed|only the first|first proof-bearing|if it records|without (?:a|its|the) (?:claim|relevance))\b/iu;
// Phrasings that state the older contract outright, whatever the clause around them says.
const OLD_CONTRACT_PHRASES = Object.freeze([
  /\bclaim,? proof,? and relevance (?:spans )?(?:are|is) each\b/iu,
  /\b(?:all|those|these|the) (?:three|four) (?:argumentMapping )?(?:spans|fields)\b/iu,
  /\bkeeping each paragraph['’]s claim\b/iu,
  /\bkeeps? its claim,? (?:its )?proof\b/iu,
  /\bclaim, proof, relevance and jobNeedQuote\b/iu,
]);

/** The clauses of `text` that make every proof-bearing paragraph owe a claim or a relevance span. */
export function findUniversalSpanOwnership(text) {
  const found = [];
  for (const clause of String(text).replace(/\s+/gu, ' ').split(/(?<=[.;!?])\s+|\s+[—–]\s+/u)) {
    if (OLD_CONTRACT_PHRASES.some(pattern => pattern.test(clause))) { found.push(clause); continue; }
    if ((UNIVERSAL_OWNERSHIP.test(clause) || SPAN_REQUIRED_OF_EVERY.test(clause)) && !SPAN_MAY_BE_OMITTED.test(clause)) found.push(clause);
  }
  return found;
}

// Sentences that push EVERY paragraph toward a statement of relevance of its own, written before the budgets said that only the first proof-bearing paragraph owes one.
// Each is matched on its own words, whatever the sentence around it says; a negation ("no fixed claim-proof-relevance sentence pattern applies") is not one of them.
const RELEVANCE_PUSH_PHRASES = Object.freeze([
  /\b(?:establish|make)s? (?:its |their )?point,? (?:establish(?:es)? )?(?:its |their )?proof,? and (?:explain )?(?:its |their )?relevance\b/iu,
  /\bclaims?,? action steps?,? (?:and|or) relevance links?\b/iu,
  /\brelevance links? (?:need|get|require)s? (?:their|its) own\b/iu,
  /\b(?:and|then) ties? (?:them|each) to the target work\b/iu,
]);
// The reference criterion must name the role once and then say "this role"; the older wording said only that the position is referenced proximally.
const NAMES_THE_ROLE_ONCE = /\bnames the role by its title and the employer by name once\b/iu;

/** The clauses of `text` that tell a writer every paragraph owes a statement of relevance. */
export function findRelevancePush(text) {
  const found = [];
  for (const clause of String(text).replace(/\s+/gu, ' ').split(/(?<=[.;!?])\s+/u)) {
    if (RELEVANCE_PUSH_PHRASES.some(pattern => pattern.test(clause))) found.push(clause);
  }
  return found;
}

// The text a writer reads out of a JavaScript source: its string and template literals (adjacent literals joined by "+" are one
// string, comments are skipped, and a template's substitutions are elided). Identifiers, regular expressions and the notes the
// engineers left in comments are not text a writer sees, and scanning whole lines would read them as prose.
function stringLiterals(source) {
  const pieces = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i += 1; continue; }
    if (c === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1; let text = '';
      while (j < n && source[j] !== c && source[j] !== '\n') { if (source[j] === '\\') { text += source[j + 1] ?? ''; j += 2; } else { text += source[j]; j += 1; } }
      pieces.push({ start: i, end: j + 1, text }); i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1; let text = ''; let depth = 0;
      while (j < n) {
        const d = source[j];
        if (depth === 0 && d === '`') break;
        if (d === '\\') { text += source[j + 1] ?? ''; j += 2; continue; }
        if (d === '$' && source[j + 1] === '{') { depth += 1; text += ' … '; j += 2; continue; }
        if (depth > 0) { if (d === '{') depth += 1; else if (d === '}') depth -= 1; j += 1; continue; }
        text += d; j += 1;
      }
      pieces.push({ start: i, end: j + 1, text }); i = j + 1; continue;
    }
    i += 1;
  }
  const merged = [];
  for (const piece of pieces) {
    const last = merged.at(-1);
    if (last && /^\s*\+\s*$/u.test(source.slice(last.end, piece.start))) { last.text += piece.text; last.end = piece.end; } else merged.push({ ...piece });
  }
  return merged.map(piece => piece.text).filter(text => text.length >= 40);
}

// Every string an exported constant of a module holds (strings, and strings inside frozen arrays and plain objects).
function exportedStrings(module) {
  const out = [];
  const visit = (name, value) => {
    if (typeof value === 'string') out.push([name, value]);
    else if (Array.isArray(value)) value.forEach((item, index) => visit(`${name}[${index}]`, item));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => visit(`${name}.${key}`, item));
  };
  for (const [name, value] of Object.entries(module)) if (typeof value !== 'function') visit(name, value);
  return out;
}

// ---------------------------------------------------------------------------
// The real protocol's contracts, over a synthetic career (the legacy walker: queue a paste job, accept the plan and the résumé,
// keep the cover-letter and review prompts).
// ---------------------------------------------------------------------------
const CONTEXT_MARKER = '\n\nAuthoritative context:\n';
const contractOf = prompt => prompt.slice(0, prompt.lastIndexOf(CONTEXT_MARKER));
const reply = (handoff, fields) => ({ protocol: 1, jobId: handoff.jobId, stage: handoff.stage, handoffCode: handoff.handoffCode, baseHashes: handoff.baseHashes || {}, ...fields });
const CAREER = Object.freeze({
  name: 'Wen Adeyemi', email: 'wen@example.test', employer: 'Alderbank Ferries', title: 'Berth Planner',
  listing: 'Berth planner role focused on reliable ferry turnarounds. The team schedules docking crews and supports captains who depend on those schedules every working day. You will work with port partners to keep the sailing timetable dependable for the passengers who rely on it each week.',
  bullet: 'Maintained ferry turnaround schedules with supported docking practices.',
  lead: 'Reliable ferry turnarounds are the capability this planning role needs, and my scheduling experience supports it.',
  body: 'In my planning role at Alderbank Ferries, I kept the docking schedule dependable for daily captains through shared berth sheets.',
  thesis: 'Reliable ferry turnarounds are the supported capability this planning role needs.',
});

async function walkContracts() {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'v16b-contracts-')));
  try {
    const canvasFilePath = path.join(root, 'Canvas.json');
    await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
    const paragraph = `${CAREER.lead} ${CAREER.body}`;
    const queued = await queueLocalApplicationJob({
      transport: 'paste', canvasFilePath,
      careerData: [CAREER.name, CAREER.email, `${CAREER.title} profile`, '', `## ${CAREER.employer}`, CAREER.title, '', CAREER.bullet, paragraph].join('\n'),
      job: { title: CAREER.title, company: CAREER.employer, snippet: CAREER.listing },
      resumeProfile: { workHistory: [{ id: 'role-1', title: CAREER.title, employer: CAREER.employer, startDate: '', endDate: '' }] },
    });
    const current = async () => (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
    const submit = async fields => {
      const handoff = await current();
      return submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, fields)) });
    };
    const must = (result, stage) => assert(result.accepted, `the ${stage} fixture is accepted (${JSON.stringify(result.validationErrors || [])})`);
    const prompts = {};
    must(await submit({
      identity: { name: CAREER.name, contact: [CAREER.email], subtitleRole: CAREER.title },
      evidence: [
        { id: 'resume-proof-1', sourceId: 'career-data', quote: CAREER.bullet, requirement: 'Reliable turnarounds', priority: 'highest' },
        { id: 'letter-proof-1', sourceId: 'career-data', quote: paragraph, requirement: 'Reliable turnarounds', priority: 'highest' },
        { id: 'job-proof', sourceId: 'job-listing', quote: `${CAREER.listing.split('. ')[0]}.`, requirement: 'Reliable turnarounds', priority: 'highest' },
      ],
      requirements: [{ id: 'need-1', text: 'Reliable turnarounds', priority: 'highest', evidenceIds: ['resume-proof-1', 'job-proof'] }],
    }), 'evidence-plan');
    must(await submit({
      resume: {
        schemaVersion: 'structured-resume.v1', identity: { name: CAREER.name, contact: [CAREER.email], subtitleRole: CAREER.title, credential: '' },
        roles: [{ id: 'role-1', title: CAREER.title, company: CAREER.employer, dates: '', location: '', bullets: [{ id: 'bullet-1', text: CAREER.bullet, evidenceIds: ['resume-proof-1'] }] }],
      },
    }), 'resume');
    prompts['cover-letter'] = (await current()).prompt;
    must(await submit({
      coverLetter: {
        name: CAREER.name, contact: [CAREER.email], paragraphs: [{ id: 'paragraph-1', text: paragraph, evidenceIds: ['letter-proof-1', 'job-proof'] }], roleThesis: CAREER.thesis,
        coverLetterArgument: { primaryEvidence: { evidence: CAREER.bullet, evidenceRole: `${CAREER.title} at ${CAREER.employer}`, relationToThesis: 'The scheduling work establishes the turnaround capability named in the thesis.' } },
      },
    }), 'cover-letter');
    prompts.review = (await current()).prompt;
    return prompts;
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

export default [
  {
    name: 'Scanner: it flags every phrasing of "every proof-bearing paragraph owes a claim or a relevance span" the reviewers found, and passes the budget sentences and the statements that follow from them (A/B/C)',
    run() {
      // A: the sentences of the older contract, in the words the reviewers quoted and in neighbouring words, are each flagged.
      const old = [
        'every later proof-bearing paragraph keeps its claim, proof and jobNeedQuote and ends on what the work did',
        'In a paragraph that owes one, claim, proof and relevance are each an exact span of THAT paragraph',
        'it must be an object carrying claim, proof, relevance and jobNeedQuote. Supply those four fields as an object',
        'keeping each paragraph’s claim, proof and the responsibility it answers, so that a proof paragraph closes on its last sentence about the work',
        'Every later proof paragraph records a relevance span that names the responsibility',
        'Each proof-bearing paragraph owes a claim span in the closed grammar',
        'All proof paragraphs must carry a claim and a relevance span',
        'Every later paragraph supplies its claim',
        'a relevance span is required of every later proof-bearing paragraph, so each later paragraph needs one',
        'The final review records all three spans for each paragraph',
      ];
      for (const sentence of old) assert(findUniversalSpanOwnership(sentence).length > 0, `the scanner flags: ${sentence}`);
      // B: the budget sentences, the rule for a span that is recorded, and ordinary statements about paragraphs pass.
      const current = [
        checks.EXPLICIT_CLAIM_BUDGET_RULE, checks.EXPLICIT_RELEVANCE_BUDGET_RULE, checks.EXPLICIT_TRANSFER_BUDGET_RULE, checks.ARGUMENT_LATER_RELEVANCE_SPAN_RULE,
        'A later proof-bearing paragraph owes only its proof and jobNeedQuote: it may leave the claim out and may leave the relevance out',
        'Every paragraph has one argumentative job and advances the same argument with clear transitions',
        'Each proof-bearing paragraph keeps its proof span and its jobNeedQuote',
        'each span the review records for it (claim, proof or relevance) is an exact span of THAT paragraph',
        'Only the first proof-bearing paragraph of the letter owes a claim or a relevance',
        'every proof-bearing paragraph must keep a sentence stating its own completed action',
      ];
      for (const sentence of current) assert(findUniversalSpanOwnership(sentence).length === 0, `the scanner passes: ${sentence}`);
      // C: flip one clause of a passing sentence into the older contract, and the verdict flips; flip it back and it clears.
      const hedged = 'Every later proof-bearing paragraph keeps its proof and may leave the claim out';
      const flipped = hedged.replace('may leave the claim out', 'keeps the claim');
      assert(flipped !== hedged && findUniversalSpanOwnership(hedged).length === 0 && findUniversalSpanOwnership(flipped).length > 0, 'flipping the hedge to the older wording is flagged');
      assert(findUniversalSpanOwnership(flipped.replace('keeps the claim', 'may leave the claim out')).length === 0, 'restoring the hedge clears it');
      // The real budget sentence, with only its second clause turned into the older contract, is flagged; the sentence as shipped is not.
      const realRule = checks.EXPLICIT_RELEVANCE_BUDGET_RULE;
      const olderRule = realRule.replace('a later proof-bearing paragraph owes only its proof span and its jobNeedQuote, may leave the relevance out, and is held to the same shape for a relevance span it records', 'every later proof-bearing paragraph keeps its relevance');
      assert(olderRule !== realRule && findUniversalSpanOwnership(olderRule).length === 1 && findUniversalSpanOwnership(realRule).length === 0, 'the shipped budget sentence passes and its older wording is flagged');
    },
  },
  {
    name: 'Surface: no exported rule, no string literal of a prompt, schema or error source, no document, no printed contract and no correction brief says that every proof-bearing paragraph owes a claim or a relevance span (4 surfaces)',
    async run() {
      const flagged = [];
      const scan = (where, text) => {
        for (const clause of findUniversalSpanOwnership(text)) flagged.push(`${where}: ${clause.slice(0, 200)}`);
        for (const clause of findRelevancePush(text)) flagged.push(`${where} (relevance push): ${clause.slice(0, 200)}`);
      };

      // 1. Exported strings of the modules that own the rules.
      for (const [label, module] of [['coverLetterChecks', checks], ['applicationWriterGuidance', guidance], ['applicationRepairConvergence', convergence]]) {
        for (const [name, value] of exportedStrings(module)) scan(`${label}.${name}`, value);
      }
      // 2. Every string literal of the sources that print or throw text a writer reads.
      for (const file of ['electron/ipc/coverLetterChecks.js', 'electron/ipc/localAiApplication.js', 'electron/ipc/aiSchemas.js', 'electron/ipc/applicationWriterGuidance.js',
        'electron/ipc/applicationRepairConvergence.js', 'electron/ipc/applicationBlindReview.js', 'electron/ipc/pasteReviewDelta.js']) {
        for (const literal of stringLiterals(read(file))) scan(file, literal);
      }
      // 3. Every document that describes the contract.
      const docs = ['local_ai/LOCAL_AI_APPLICATION_ROUTINE.md', 'local_ai/PASTE_BACK_APPLICATION.md', 'Job Application Design System/SKILL.md', 'Job Application Design System/STYLE.md',
        'Job Application Design System/CONTENT_RULES.md', 'Job Application Design System/ENGINEERING.md'];
      for (const file of docs) scan(file, read(file));
      // 4. The contracts the real protocol prints, and the correction brief of a letter-paragraph round.
      const prompts = await walkContracts();
      for (const stage of ['cover-letter', 'review']) scan(`the ${stage} contract`, contractOf(prompts[stage]));
      const input = { jobId: 'consistency-job', qualityChecklist: { criteria: [], version: 4 }, generationAudit: { required: true, version: 1 } };
      const state = { stage: 'cover-letter', handoffCode: 'h', baseHashes: {}, reviewBaseline: null, findings: [] };
      const correction = pasteCorrectionPrompt({ input, state, corrections: ['paragraph-argument-links: paragraph 2 argumentMapping.relevance is missing'], stagePromptChars: 0 }).prompt;
      assert(correction.includes('argument-spans') || correction.includes(checks.ARGUMENT_SPAN_BUDGET_RULES), 'the correction round prints the argument brief (the premise of scanning it)');
      scan('the letter-paragraph correction brief', correction);
      assert(flagged.length === 0, `no printed surface says every proof-bearing paragraph owes a claim or a relevance span:\n${flagged.join('\n')}`);
    },
  },
  {
    name: 'One voice: the span-budget block is printed once in each contract and in the brief from the exported constants, the audit shape marks the optional fields, and the shape error names what each paragraph owes (A/B/C)',
    async run() {
      const prompts = await walkContracts();
      const block = checks.ARGUMENT_SPAN_BUDGET_RULES;
      // A: each contract prints the block once, and so each budget sentence once (the claim, the relevance and the transfer budgets read the same way).
      for (const stage of ['cover-letter', 'review']) {
        const contract = contractOf(prompts[stage]);
        assert(contract.split(block).length === 2, `the ${stage} contract prints the span-budget block exactly once`);
        for (const rule of [checks.EXPLICIT_TRANSFER_BUDGET_RULE, checks.EXPLICIT_CLAIM_BUDGET_RULE, checks.EXPLICIT_RELEVANCE_BUDGET_RULE, checks.ARGUMENT_LATER_RELEVANCE_SPAN_RULE]) {
          assert(contract.split(rule).length === 2, `the ${stage} contract prints each budget sentence once (${rule.slice(0, 60)})`);
        }
        // The static statement of what the review records is the conditional one.
        assert(!contract.includes('claim, proof and relevance are each an exact span') && !contract.includes('claim, proof and relevance are each'), `the ${stage} contract no longer says all three spans are each required`);
      }
      assert(contractOf(prompts['cover-letter']).includes('each span the review records for it (claim, proof or relevance) is an exact span of THAT paragraph'), 'the cover-letter contract says which spans are exact spans');
      assert(contractOf(prompts.review).includes('each span it records (claim, proof or relevance) is an exact span of that paragraph and no two of them are the same span'), 'and the review contract says it of the spans it records');
      assert(contractOf(prompts['cover-letter']).includes('This stage reports a paragraph that owes a mapping and offers no span it owes (a claim span or a relevance span, only where the budgets above say the paragraph owes one)'),
        'the cover-letter contract says the drafting reporter names only spans the budgets owe');
      // B: the generationAudit shape notation marks the claim and the relevance as optional, and says who owes them.
      const audit = contractOf(prompts.review);
      assert(audit.includes('argumentMapping?:{claim?,proof,relevance?,jobNeedQuote} only for proof-bearing paragraphs, claim and relevance only where their budgets say so'), 'the audit shape marks claim and relevance optional');
      assert(!audit.includes('argumentMapping?:{claim?,proof,relevance,jobNeedQuote}'), 'and no notation still requires the relevance');
      // C: the shape error is the one sentence both call sites read, built to name what is owed by every paragraph and what by the budgets.
      const source = read('electron/ipc/localAiApplication.js');
      assert(source.includes('it must be an object carrying proof and jobNeedQuote, and carrying claim and relevance wherever the span budgets in this contract say the paragraph owes them.')
        && !source.includes('Supply those four fields'), 'the shape error names the fields every paragraph owes and defers the rest to the budgets');
      // The drafting-stage reporter names the spans a paragraph owes, from the same two counts the gate reads.
      assert(source.includes("const owedSpans = [owesClaim[index] ? 'claim' : null, 'proof', owesRelevance[index] ? 'relevance' : null].filter(Boolean);"), 'the reporter derives the named spans from the counts');
    },
  },
  {
    name: 'Guidance: the placement rule separates the claim phrase from the relevance sentence, the repair rule names the host-required functions from the constants and follows them, and the opening and proof-count rules cover the cases they left open (A/B/C)',
    async run() {
      // A: placement. The sentence that is never written only to carry a span is the claim's; the relevance is a sentence of the paragraph apart from the proof.
      const placement = guidance.LETTER_CLAIM_PLACEMENT_RULE;
      assert(placement.includes('write no sentence whose only job is to carry the claim span') && !placement.includes('carry a span.'), `the placement rule limits itself to the claim span (${placement})`);
      assert(placement.includes('The relevance span a paragraph owes is a different thing: it is a sentence of that paragraph, apart from the proof sentence, that says how the proof bears on the requirement its jobNeedQuote came from.'),
        'and says what the relevance span is, so the two cannot be read as one instruction');
      // B: the repair rule names the functions, from the same constants.
      const raised = convergence.BLIND_REPAIR_RAISED_CYCLES_RULE;
      // The list is not claimed to be complete ("among the functions"), and it names the opening and the letter's proportions beside the claim, the proof and the closing
      // (gapfix-v16c-letter-functions holds it against the checks themselves: every check that newly fails when a sentence is deleted is named by it).
      assert(raised.includes(`Among the functions the host requires of a cover-letter paragraph are these: ${checks.HOST_REQUIRED_LETTER_FUNCTIONS}.`) && raised.includes('unless a function the host requires of that paragraph would be lost'), `the repair rule prints the functions (${raised})`);
      assert(!raised.includes('requires only these functions'), 'and no longer claims the list is the whole of what the host requires');
      for (const part of ['a claim phrase and a sentence relating its proof to the job need', 'a proof sentence in every proof-bearing paragraph', 'an opening that leads with the target work', 'the closing’s asset, action and target parts', 'proportion limits']) {
        assert(checks.HOST_REQUIRED_LETTER_FUNCTIONS.includes(part), `the functions list says: ${part}`);
      }
      assert(!/["“”]/u.test(raised) && !/\d/u.test(raised) && raised.length < 1_000, 'the repair rule quotes nothing, prints no figure and stays short');
      // The list follows the constants: in temporary copies of the checks and the convergence module wired together, a moved claim budget moves the functions phrase.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v16b-functions-'));
      try {
        const IPC = path.resolve('electron/ipc');
        const absolutize = text => text.replace(/from '(\.{1,2}\/[^']+)'/gu, (_match, relative) => `from '${pathToFileURL(path.resolve(IPC, relative)).href}'`);
        const checksSource = read('electron/ipc/coverLetterChecks.js');
        const declaration = 'export const MAX_EXPLICIT_CLAIM_PARAGRAPHS = 1;';
        assert(checksSource.split(declaration).length === 2, 'the claim number is declared once');
        const load = async (name, source) => {
          const file = path.join(dir, `${name}.mjs`);
          fs.writeFileSync(file, source, 'utf8');
          return { url: pathToFileURL(file).href, module: await import(`${pathToFileURL(file).href}?copy=${name}`) };
        };
        const control = await load('checks-control', absolutize(checksSource));
        const two = await load('checks-two', absolutize(checksSource.replace(declaration, 'export const MAX_EXPLICIT_CLAIM_PARAGRAPHS = 2;')));
        const convergenceSource = absolutize(read('electron/ipc/applicationRepairConvergence.js'));
        const realChecksUrl = pathToFileURL(path.resolve(IPC, 'coverLetterChecks.js')).href;
        assert(convergenceSource.includes(realChecksUrl), 'the convergence module imports the checks module');
        const wired = async (name, checksCopy) => (await load(name, convergenceSource.replace(realChecksUrl, checksCopy.url))).module;
        const controlRule = (await wired('conv-control', control)).BLIND_REPAIR_RAISED_CYCLES_RULE;
        const twoRule = (await wired('conv-two', two)).BLIND_REPAIR_RAISED_CYCLES_RULE;
        assert(controlRule === raised, 'an unmutated copy prints exactly what the real module prints');
        assert(twoRule !== controlRule && twoRule.includes('a claim phrase in each of the first 2 proof-bearing paragraphs of the letter and a sentence relating its proof to the job need in the first proof-bearing paragraph of the letter'),
          `a moved claim budget moves the functions the repair rule names (${twoRule})`);
        assert(checks.HOST_REQUIRED_LETTER_FUNCTIONS.includes('in the first proof-bearing paragraph of the letter') && !checks.HOST_REQUIRED_LETTER_FUNCTIONS.includes('each of the first 2'), 'the real module is unchanged by the copies');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      // C: the cases the opening and proof-count rules left open.
      assert(guidance.LETTER_OPENING_RULE.includes('when the record gives no usable title or no usable employer, it names the one it does give, leaves out the other, and invents neither'), 'the opening rule covers a job record with no usable title or employer');
      assert(guidance.LETTER_PROOF_ADDS_RULE.includes('so leave it out and state the proof plainly instead'), 'the adds rule says what to do when no quote states a reason');
      assert(guidance.LETTER_PROOF_COUNT_RULE.includes('When a cited quote states nothing beyond its bullet, the paragraph says the proof plainly and invents no reason, constraint, decision or outcome for it, and a letter whose evidence is all of that kind uses fewer, plainer paragraphs.'),
        'the count rule says what a letter does when its quotes state nothing beyond their bullets');
      // The printed rules quote nothing and print no figure, so there is no string to copy, and the new sentences name no field of work.
      for (const name of ['LETTER_OPENING_RULE', 'LETTER_PROOF_ADDS_RULE', 'LETTER_PROOF_COUNT_RULE', 'LETTER_CLAIM_PLACEMENT_RULE']) {
        assert(!/["“”‘']/u.test(guidance[name]) && !/\d/u.test(guidance[name]), `${name} quotes nothing and prints no number`);
      }
    },
  },
  {
    name: 'Relevance scanner: it flags every older sentence that pushes each paragraph toward a statement of relevance of its own, passes the sentences that replaced them, and flips with one clause (A/B/C)',
    run() {
      // A: the sentences the round-2 reviewer found in the prompts, the criteria, the proportion rule and the documents, in their own words.
      const older = [
        'Use the sentences the paragraph needs to establish its point, proof, and relevance clearly, usually two to four',
        'Use the sentences that paragraph needs to make its point, establish its proof, and explain its relevance clearly, usually two to four.',
        'Split a sentence when separate claims, action steps, or relevance links need their own clear grammatical path; combine them only when the combined sentence is simpler',
        'separate claims, action steps, and relevance links get their own sentence when that is easier to parse',
        'and split separate claims, action steps, or relevance links within the paragraph when a combined sentence is harder to parse.',
        'A persuasive letter selects the strongest two or three proofs, develops each in one paragraph of two to four sentences, and ties them to the target work',
        'Relevance links need their own sentence in every paragraph',
      ];
      for (const sentence of older) assert(findRelevancePush(sentence).length > 0, `the scanner flags: ${sentence}`);
      // B: what replaced them, the negations, and ordinary statements about relevance pass.
      const current = [
        'Use the sentences the paragraph needs to establish its point and its proof clearly, usually two to four',
        'Split a sentence when separate claims or action steps need their own clear grammatical path; combine them only when the combined sentence is simpler',
        'Only the paragraph that owes the sentence about the target gives it a sentence of its own',
        'no fixed claim-proof-relevance sentence pattern applies, and no single detail of the evidence gets a paragraph of its own',
        'A persuasive letter selects the strongest two or three proofs, develops each in one paragraph of two to four sentences, and binds each to the work it answers',
        checks.LETTER_PROPORTION_RULE, checks.EXPLICIT_RELEVANCE_BUDGET_RULE, checks.ARGUMENT_LATER_RELEVANCE_SPAN_RULE,
      ];
      for (const sentence of current) assert(findRelevancePush(sentence).length === 0, `the scanner passes: ${sentence.slice(0, 120)}`);
      // C: flip one clause of the real proportion rule back to the older wording and the verdict flips; flip it back and it clears.
      const rule = checks.LETTER_PROPORTION_RULE;
      assert(rule.includes('binds each to the work it answers'), 'the real proportion rule says what it replaced the older clause with');
      const flipped = rule.replace('binds each to the work it answers', 'ties them to the target work');
      assert(flipped !== rule && findRelevancePush(rule).length === 0 && findRelevancePush(flipped).length === 1, 'the older clause is flagged in the real rule');
      assert(findRelevancePush(flipped.replace('ties them to the target work', 'binds each to the work it answers')).length === 0, 'restoring the clause clears it');
    },
  },
  {
    name: 'Opening and criteria: the contracts say once how the role and the employer are named, the opening-context rule no longer repeats it, and the reference criterion names the role once and then says this role (A/B/C)',
    async run() {
      const prompts = await walkContracts();
      // A: the guidance rule is printed exactly once in each contract, and the sentence that said it a second time is gone, with the clause that undercut it.
      for (const stage of ['cover-letter', 'review']) {
        const contract = contractOf(prompts[stage]);
        assert(contract.split(guidance.LETTER_OPENING_RULE).length === 2, `the ${stage} contract prints the opening rule once`);
        assert(!contract.includes('The role title and the employer’s name belong in the opening'), `the ${stage} contract does not say it twice`);
        assert(!contract.includes('The application already identifies the candidate and position'), `the ${stage} contract does not justify an unnamed role`);
        assert(contract.includes('the opening rule of the letter writing guidance says how the opening names the role and the employer, once'), `the ${stage} contract points to the one rule`);
        assert(findRelevancePush(contract).length === 0, `the ${stage} contract holds no sentence that gives every paragraph a statement of relevance`);
      }
      // B: the criterion a writer attests to agrees with the rule, and the craft criterion no longer lists relevance links as a thing each paragraph splits out.
      const criteria = new Map(APPLICATION_QUALITY_CRITERIA.map(criterion => [criterion.id, criterion.requirement]));
      const clarity = criteria.get('cover-reference-clarity');
      assert(NAMES_THE_ROLE_ONCE.test(clarity) && clarity.includes('referenced proximally') && clarity.includes('this role'), `the reference criterion names the role once, then says this role (${clarity})`);
      const craft = criteria.get('cover-sentence-craft');
      assert(findRelevancePush(craft).length === 0 && craft.includes('only the paragraph that owes the sentence about the target gives it a sentence of its own'), 'the craft criterion gives the sentence about the target to the one paragraph that owes it');
      // C: mutation. The older criterion wording fails the same test, and so does the craft criterion's older clause.
      const olderClarity = clarity.replace('the opening names the role by its title and the employer by name once, after which target scope', 'target scope');
      assert(olderClarity !== clarity && !NAMES_THE_ROLE_ONCE.test(olderClarity) && olderClarity.includes('referenced proximally'), 'the older reference criterion does not name the role once');
      const olderCraft = craft.replace('separate claims and action steps get their own sentence when that is easier to parse, only the paragraph that owes the sentence about the target gives it a sentence of its own,', 'separate claims, action steps, and relevance links get their own sentence when that is easier to parse,');
      assert(olderCraft !== craft && findRelevancePush(olderCraft).length === 1, 'the older craft criterion is flagged');
    },
  },
];
