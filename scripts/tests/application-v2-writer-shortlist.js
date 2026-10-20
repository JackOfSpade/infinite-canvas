import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { archiveV2WriterNotes, splitWriteVerifyWriterResponse } from '../../electron/ipc/applicationV2WriterShortlist.js';

// Synthetic catalog built from three synthetic domains: freight, clinic, library.
const ID = {
  freight1: 'host.career.achievement.freight-1.1',
  freight1b: 'host.career.achievement.freight-1.2',
  freightPlan: 'host.career.project.freight-plan.1',
  freightOps: 'host.career.skill.freight-ops.1',
  clinic1: 'host.career.achievement.clinic-1.1',
  clinic1b: 'host.career.achievement.clinic-1.2',
  clinicPlan: 'host.career.project.clinic-plan.1',
  clinicOps: 'host.career.skill.clinic-ops.1',
  library1: 'host.career.achievement.library-1.1',
  libraryPlan: 'host.career.project.library-plan.1',
  libraryOps: 'host.career.skill.library-ops.1',
  sharedAchievement: 'host.career.achievement.shared-1.1',
  sharedProject: 'host.career.project.shared-1.1',
};
const ALLOWED = Object.values(ID);

const SIX = [ID.freight1, ID.freightPlan, ID.freightOps, ID.clinic1, ID.clinicPlan, ID.library1];
const RESUME_BODY = 'Coordinated dispatch rotations across three depots.';
const LETTER_BODY = 'I would bring steady scheduling habits to the role.';
const PLAIN = `RÉSUMÉ\n${RESUME_BODY}\nCOVER LETTER\n${LETTER_BODY}`;

const COUNT_FORM = (count) => new RegExp(
  `one per line as "- <catalog ID> - <reason>" with the full ID \\(host\\.career\\.<kind>\\.<entity>\\.<n>\\) copied from the FULL APPROVED CATALOG; ${count} item lines were found\\.`, 'u');
const ID_FAILURE = /needs one approved catalog ID in the form host\.career\.<kind>\.<entity>\.<n>, copied byte-for-byte/u;
const DISTINCT = /working shortlist IDs must be distinct/u;

function reply(working, { resume = RESUME_BODY, letter = LETTER_BODY } = {}) {
  return ['EVIDENCE SHORTLIST (WORKING NOTES)', ...working, 'RÉSUMÉ', resume, 'COVER LETTER', letter].join('\n');
}

function parse(working, options) {
  return splitWriteVerifyWriterResponse(reply(working, options), ALLOWED);
}

function fullLines(ids) {
  return ids.map((id, index) => `${id} - reason ${index + 1}`);
}

export default [
  {
    name: 'writer shortlist: unmarked lines each starting with a full ID parse',
    run() {
      const lines = fullLines(SIX);
      const result = parse(lines);
      assert.deepEqual(result.ids, SIX);
      assert.equal(result.shortlist, lines.join('\n'));
      assert.equal(result.plainText, PLAIN);
    },
  },
  {
    name: 'writer shortlist: bullet U+2022 lines parse',
    run() {
      const lines = SIX.map((id, index) => `\u2022 ${id} - reason ${index + 1}`);
      assert.deepEqual(parse(lines).ids, SIX);
    },
  },
  {
    name: 'writer shortlist: short entity tokens resolve to the lowest-numbered ID',
    run() {
      const lines = [
        'freight-1 - two quotes exist, the first is chosen',
        'freight-plan - project entity in the same list',
        'freight-ops: skill entity',
        'clinic-1 - another achievement with two quotes',
        'clinic-plan - clinic project',
        'library-1 - library achievement',
      ];
      assert.deepEqual(parse(lines).ids, [ID.freight1, ID.freightPlan, ID.freightOps, ID.clinic1, ID.clinicPlan, ID.library1]);
    },
  },
  {
    name: 'writer shortlist: every supported list marker parses',
    run() {
      const markers = [
        (i) => `${i + 1}.`, (i) => `(${i + 1})`, (i) => `${i + 1})`,
        () => '\u2014', () => '\u2013', () => '\u00b7', () => '+', () => '*', () => '-',
      ];
      for (const marker of markers) {
        const lines = SIX.map((id, index) => `${marker(index)} ${id} - reason ${index + 1}`);
        assert.deepEqual(parse(lines).ids, SIX, `marker ${marker(0)} parses`);
      }
    },
  },
  {
    name: 'writer shortlist: bracketed full IDs parse',
    run() {
      const lines = SIX.map((id, index) => `- [${id}] reason ${index + 1}`);
      assert.deepEqual(parse(lines).ids, SIX);
      const unmarked = SIX.map((id, index) => `[${id}]: reason ${index + 1}`);
      assert.deepEqual(parse(unmarked).ids, SIX);
    },
  },
  {
    name: 'writer shortlist: short token whose entity exists under two kinds is rejected',
    run() {
      const lines = [...fullLines(SIX.slice(0, 5)), '- shared-1 - ambiguous entity'];
      assert.throws(() => parse(lines), ID_FAILURE);
    },
  },
  {
    name: 'writer shortlist: marker-led short token matching nothing is rejected',
    run() {
      const lines = [...fullLines(SIX.slice(0, 5)), '- freight-9 - unknown entity'];
      assert.throws(() => parse(lines), ID_FAILURE);
    },
  },
  {
    name: 'writer shortlist: unmarked unresolved token is a note and leaves the count short',
    run() {
      const lines = [...fullLines(SIX.slice(0, 5)), 'freight-9 - unknown entity'];
      assert.throws(() => parse(lines), COUNT_FORM(5));
    },
  },
  {
    name: 'writer shortlist: two short tokens of one entity are duplicates',
    run() {
      const lines = ['freight-1 - first', 'freight-1 - second', ...fullLines(SIX.slice(1, 5))];
      assert.throws(() => parse(lines), DISTINCT);
      assert.throws(() => parse([`${ID.freight1} - full`, 'freight-1 - short', ...fullLines(SIX.slice(1, 5))]), DISTINCT);
    },
  },
  {
    name: 'writer shortlist: 5 and 11 items are rejected with the exact count',
    run() {
      assert.throws(() => parse(fullLines(SIX.slice(0, 5))), COUNT_FORM(5));
      const eleven = [ID.freight1, ID.freight1b, ID.freightPlan, ID.freightOps, ID.clinic1, ID.clinic1b,
        ID.clinicPlan, ID.clinicOps, ID.library1, ID.libraryPlan, ID.libraryOps];
      assert.throws(() => parse(fullLines(eleven)), COUNT_FORM(11));
      assert.deepEqual(parse(fullLines(eleven.slice(0, 10))).ids, eleven.slice(0, 10));
    },
  },
  {
    name: 'writer shortlist: sabotage, exactly six fails when one item becomes a note',
    run() {
      const lines = fullLines(SIX);
      assert.deepEqual(parse(lines).ids, SIX);
      const sabotaged = [...lines.slice(0, 5), 'Dropped the last library item after review.'];
      assert.throws(() => parse(sabotaged), COUNT_FORM(5));
    },
  },
  {
    name: 'writer shortlist: note lines are ignored, kept in shortlist, absent from plainText',
    run() {
      const note = 'Leaning on dispatch evidence before clinic work.';
      const lines = [...fullLines(SIX.slice(0, 3)), note, ...fullLines(SIX.slice(3))];
      const result = parse(lines);
      assert.deepEqual(result.ids, SIX);
      assert.equal(result.shortlist, lines.join('\n'));
      assert.equal(result.shortlist.split('\n').length, 7);
      assert.equal(result.plainText, PLAIN);
      assert.equal(result.plainText.includes(note), false);
    },
  },
  {
    name: 'writer shortlist: two full IDs on one line are rejected',
    run() {
      const lines = [`${ID.freight1} and ${ID.freightPlan} - reason`, ...fullLines(SIX.slice(2)), `${ID.libraryOps} - reason`];
      assert.throws(() => parse(lines), ID_FAILURE);
    },
  },
  {
    name: 'writer shortlist: unapproved full ID is rejected',
    run() {
      const lines = [...fullLines(SIX.slice(0, 5)), 'host.career.achievement.freight-9.1 - reason'];
      assert.throws(() => parse(lines), ID_FAILURE);
    },
  },
  {
    name: 'writer shortlist: an item with an ID but no reason is rejected',
    run() {
      assert.throws(() => parse([...fullLines(SIX.slice(0, 5)), `- ${ID.library1}`]), ID_FAILURE);
      assert.throws(() => parse([...fullLines(SIX.slice(0, 5)), `- [${ID.library1}] \u2014`]), ID_FAILURE);
      assert.throws(() => parse([...fullLines(SIX.slice(0, 5)), '- library-1:']), ID_FAILURE);
    },
  },
  {
    name: 'writer shortlist: ids follow item order for mixed full, bracketed and short forms',
    run() {
      const lines = [
        `- ${ID.freight1b} - full form`,
        `[${ID.clinicPlan}] bracketed form`,
        'library-ops - short form',
        '\u2022 [freight-1] bracketed short form',
        `${ID.clinicOps}: full with colon`,
        '3) library-plan - numbered short form',
      ];
      assert.deepEqual(parse(lines).ids,
        [ID.freight1b, ID.clinicPlan, ID.libraryOps, ID.freight1, ID.clinicOps, ID.libraryPlan]);
    },
  },
  {
    name: 'writer shortlist: JSON and heading-order rejections',
    run() {
      assert.throws(() => splitWriteVerifyWriterResponse('{"resume": "text"}', ALLOWED), /plain-text résumé and cover letter with no JSON\./u);
      assert.throws(() => splitWriteVerifyWriterResponse(`Preface line\n${reply(fullLines(SIX))}`, ALLOWED),
        /Writer must begin with EVIDENCE SHORTLIST \(WORKING NOTES\), then a RÉSUMÉ heading\./u);
      const noResume = ['EVIDENCE SHORTLIST (WORKING NOTES)', ...fullLines(SIX), 'COVER LETTER', LETTER_BODY].join('\n');
      assert.throws(() => splitWriteVerifyWriterResponse(noResume, ALLOWED), /Writer must begin with EVIDENCE SHORTLIST/u);
    },
  },
  {
    name: 'writer shortlist: empty résumé or letter sections are rejected',
    run() {
      const empty = /Writer must return nonempty résumé and cover letter sections with a COVER LETTER heading\./u;
      assert.throws(() => parse(fullLines(SIX), { resume: '' }), empty);
      assert.throws(() => parse(fullLines(SIX), { letter: '' }), empty);
      const noLetter = ['EVIDENCE SHORTLIST (WORKING NOTES)', ...fullLines(SIX), 'RÉSUMÉ', RESUME_BODY].join('\n');
      assert.throws(() => splitWriteVerifyWriterResponse(noLetter, ALLOWED), empty);
    },
  },
  {
    name: 'writer shortlist: heading or catalog ID inside application text is rejected',
    run() {
      assert.throws(() => parse(fullLines(SIX), { resume: 'Recap of EVIDENCE SHORTLIST (WORKING NOTES) here.' }),
        /Working shortlist must stay before the résumé, outside application text\./u);
      assert.throws(() => parse(fullLines(SIX), { letter: `I led ${ID.freightPlan} to completion.` }),
        /Résumé and letter text must not contain catalog evidence IDs;/u);
    },
  },
  {
    name: 'v2 writer shortlist: the decision log is split out, archived as notes, and never reaches the application text',
    run() {
      const working = SIX.map(id => `- ${id} - strongest fit for the posting`);
      const notes = ['Thesis: the depot role needs steady rotations, chosen because the posting leads with it.', `P1 serves rotation planning, using ${ID.freight1} over ${ID.clinic1} because it is closer.`, 'Left out the library work: unrelated to dispatch.'];
      const text = ['EVIDENCE SHORTLIST (WORKING NOTES)', ...working, 'DECISION LOG (WORKING NOTES)', ...notes, 'RÉSUMÉ', RESUME_BODY, 'COVER LETTER', LETTER_BODY].join('\n');
      const parsed = splitWriteVerifyWriterResponse(text, ALLOWED);
      assert.equal(parsed.decisions, notes.join('\n'));
      assert.deepEqual(parsed.ids, SIX, 'the shortlist still holds exactly its six items');
      assert.equal(parsed.shortlist, working.join('\n'), 'decision notes are not shortlist items');
      assert.equal(parsed.plainText, PLAIN);
      // A missing decision log is recorded as empty, never a rejection.
      assert.equal(parse(working).decisions, '');
      // The log may not appear inside the application text.
      assert.throws(() => splitWriteVerifyWriterResponse(['EVIDENCE SHORTLIST (WORKING NOTES)', ...working, 'RÉSUMÉ', RESUME_BODY, 'DECISION LOG (WORKING NOTES)', 'note', 'COVER LETTER', LETTER_BODY].join('\n'), ALLOWED), /must stay before the résumé/u);
    },
  },
  {
    name: 'v2 writer appendices: completed documents lead and editorial explanation is excluded from conversion',
    run() {
      const explanation = 'The dispatch example supports the scheduling need. The clinic example was omitted because it adds less relevant evidence.';
      const response = [PLAIN, 'EVIDENCE SHORTLIST', ...fullLines(SIX), 'EDITORIAL SUMMARY', explanation].join('\n');
      const split = splitWriteVerifyWriterResponse(response, ALLOWED);
      assert.equal(split.plainText, PLAIN);
      assert.equal(split.decisions, explanation);
      assert.deepEqual(split.ids, SIX);
      assert.equal(split.shortlist, fullLines(SIX).join('\n'));
      const headedExplanation = `${explanation}\nRÉSUMÉ\nThe order follows relevant evidence.\nCOVER LETTER\nThe paragraphs develop the thesis.`;
      const headed = splitWriteVerifyWriterResponse(response.replace(explanation, headedExplanation), ALLOWED);
      assert.equal(headed.plainText, PLAIN);
      assert.equal(headed.decisions, headedExplanation);
      const absent = splitWriteVerifyWriterResponse([PLAIN, 'EVIDENCE SHORTLIST', ...fullLines(SIX)].join('\n'), ALLOWED);
      assert.equal(absent.decisions, '');
      assert.equal(absent.plainText, PLAIN);
      assert.throws(() => splitWriteVerifyWriterResponse(response.replace('COVER LETTER', 'EDITORIAL SUMMARY'), ALLOWED), /separate sections/u);
      assert.throws(() => splitWriteVerifyWriterResponse(`${response}\nEDITORIAL SUMMARY\nRepeated appendix`, ALLOWED), /separate sections/u);
      assert.throws(() => splitWriteVerifyWriterResponse(response.replace(RESUME_BODY, ID.freight1), ALLOWED), /must not contain catalog evidence IDs/u);
      assert.throws(() => splitWriteVerifyWriterResponse(response.replace(`${LETTER_BODY}\n`, ''), ALLOWED), /nonempty résumé and cover letter/u);
    },
  },
  {
    name: 'v2 writer notes: production archive retains editorial summaries after working job removal and records missing summaries',
    async run() {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'writer-notes-')));
      const jobId = '11111111-1111-4111-8111-111111111111';
      const jobDir = path.join(root, '.local-ai', 'jobs', jobId);
      try {
        const notes = 'Thesis: reliable dispatch. Selected depot evidence over clinic evidence for its direct operational relevance.';
        const text = [PLAIN, 'EVIDENCE SHORTLIST', ...fullLines(SIX), 'EDITORIAL SUMMARY', notes].join('\n');
        const split = splitWriteVerifyWriterResponse(text, ALLOWED);
        const paths = await archiveV2WriterNotes({ jobDir, jobId, revision: 2, candidateId: 'candidate-1', responseSha256: 'a'.repeat(64), split });
        const working = JSON.parse(await fs.readFile(paths.working, 'utf8'));
        assert.deepEqual(JSON.parse(await fs.readFile(paths.retained, 'utf8')), working);
        assert.equal(working.decisions, notes);
        assert.equal(working.decisionLogPresent, true);
        assert.equal(working.decisionLogKind, 'editorial-summary');
        assert.equal(split.plainText, PLAIN);
        assert.equal((await fs.stat(paths.retained)).mode & 0o777, 0o600);
        await fs.rm(jobDir, { recursive: true, force: true });
        assert.equal(JSON.parse(await fs.readFile(paths.retained, 'utf8')).decisions, notes);
        const absent = await archiveV2WriterNotes({ jobDir, jobId, revision: 3, candidateId: 'candidate-2', responseSha256: 'b'.repeat(64), split: parse(fullLines(SIX)) });
        const missing = JSON.parse(await fs.readFile(absent.retained, 'utf8'));
        assert.equal(missing.decisionLogPresent, false);
        assert.equal(missing.decisions, '');
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'v2 writer notes: a substituted archive directory cannot redirect candidate notes',
    async run() {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'writer-notes-link-')));
      const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'writer-notes-outside-')));
      const jobId = '11111111-1111-4111-8111-111111111111';
      try {
        await fs.mkdir(path.join(root, '.local-ai'), { mode: 0o700 });
        await fs.symlink(outside, path.join(root, '.local-ai', 'writer-shortlists'), 'dir');
        await assert.rejects(archiveV2WriterNotes({ jobDir: path.join(root, '.local-ai', 'jobs', jobId), jobId,
          revision: 1, candidateId: 'candidate-1', responseSha256: 'a'.repeat(64), split: parse(fullLines(SIX)) }), /symbolic link|regular directory/u);
        assert.deepEqual(await fs.readdir(outside), []);
      } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
    },
  },
];
