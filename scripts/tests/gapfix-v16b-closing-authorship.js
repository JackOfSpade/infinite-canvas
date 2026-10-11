// The closing's authorship asset: “the <artifact> I built”.
//
// The failure these tests pin. The writer guidance told a writer to close on a concrete
// item the letter had shown and printed the authorship form “the <artifact> I built”,
// but the gate accepted that form only for about twenty-five listed artifact nouns
// (tool, system, platform, dashboard and the like). A closing built on the strongest
// thing the candidate made was rejected with “missing its asset half” whenever that
// thing was named by any other noun (a hub, a workflow, a register, a template), and
// the direct-welcome-closing check was the most frequent host rejection of the last
// live run. The list was not lengthened, because no list reaches every field. The same
// authorship clause is accepted when its noun is one the LETTER already used for the
// candidate's own work: as the head of the object of an earlier first-person sentence
// whose verb is an authorship verb, or of the object of such a verb in a career-data
// quote the letter cites. A closing may refer back to what the letter showed.
//
// What each group below proves:
//   accepted   a closing on an artifact the letter built (earlier paragraph, earlier
//              sentence of the closing paragraph, cited quote) passes (4 domains)
//   rejected   rename the artifact so the letter never used it and it is rejected;
//              flip it back and it passes (A / B / C); and every near miss stays
//              rejected: a noun used without an authorship verb, someone else's
//              authorship, a noun that was only a modifier or a complement inside an
//              object, a light noun or pronoun, the closing sentence's own noun, a
//              quote's noun that no authorship verb governs
//   unchanged  every earlier accepted form (possessive, demonstrative with a
//              descriptor, the fixed noun list) and every earlier rejection (a bare
//              invitation, no employer side, no asset) still behaves as it did
//   guidance   the asset half the stage contract and the rejection both print says
//              what the gate accepts, from the same constants, and the target half
//              prints placeholders, not a domain
//
// Every fixture is SYNTHETIC: invented careers in unrelated fields (orchard cold
// storage, orthodontic recall, municipal permits, theatre stage management). Nothing
// in production names any of them.
import { assert } from './testHelpers.js';
import {
  CANDIDATE_AUTHORSHIP_VERBS, checkDirectWelcomeClosing, closingContributionParts, evaluateCoverLetterChecks,
} from '../../electron/ipc/coverLetterChecks.js';
import * as guidance from '../../electron/ipc/applicationWriterGuidance.js';

// Each domain: the artifact (a noun the fixed list does NOT contain), a second artifact, the employer side of the closing, and a letter that built the first.
const DOMAINS = Object.freeze([
  {
    key: 'orchard cold storage', artifact: 'ripening chart', head: 'chart', other: 'loading rota', employerSide: 'your packing house',
    opening: 'Fruit leaves cold storage on a schedule somebody set, and this role sets it.',
    proofs: [
      'I built a ripening chart that storage crews read before every shift. The chart replaced a wall of handwritten notes.',
      'I wrote the loading rota that the night team followed for each outbound truck.',
    ],
    quote: 'Built the ripening chart used by every storage crew.',
  },
  {
    key: 'orthodontic recall', artifact: 'recall register', head: 'register', other: 'consent template', employerSide: 'your front desk',
    opening: 'A missed retainer check is a small thing until it is a repeat visit, and this role tracks it.',
    proofs: [
      'I created a recall register that the front desk opened each morning. The register listed every patient due within thirty days.',
      'I developed the consent template that parents signed at the first appointment.',
    ],
    quote: 'Developed the recall register for the front desk.',
  },
  {
    key: 'municipal permits', artifact: 'permit tracker', head: 'tracker', other: 'inspection checklist', employerSide: 'your permit counter',
    opening: 'A permit is a promise with a clock on it, and this role keeps the clock honest.',
    proofs: [
      'I designed a permit tracker that counter staff updated at every handoff. The tracker showed which applications waited on an inspector.',
      'I wrote the inspection checklist that field staff carried to each site.',
    ],
    quote: 'Designed the permit tracker for counter staff.',
  },
  {
    key: 'theatre stage management', artifact: 'cue sheet', head: 'sheet', other: 'fly rail schedule', employerSide: 'your production office',
    opening: 'A show is a sequence of small promises kept in the dark, and this role keeps them.',
    proofs: [
      'I created a cue sheet that the stage crew followed from the first call. The sheet marked every scene change by the minute.',
      'I wrote the fly rail schedule that the carpenters trusted for load-in.',
    ],
    quote: 'Created the cue sheet followed by the stage crew.',
  },
]);

const closingFor = (noun, employerSide) => `I welcome a conversation about how the ${noun} I built could support ${employerSide}.`;
const letterFor = (domain, closing, { proofs = domain.proofs } = {}) => [domain.opening, ...proofs, closing];
const verdict = (paragraphs, options) => checkDirectWelcomeClosing(paragraphs, '', options);
const detailOf = check => `${check.id}: ${check.detail}`;

export default [
  {
    name: 'Closing, accepted: a closing on an artifact the letter built passes, in an earlier paragraph, an earlier sentence of the closing paragraph or a cited quote, though the noun is on no fixed list (4 domains)',
    run() {
      for (const domain of DOMAINS) {
        const closing = closingFor(domain.artifact, domain.employerSide);
        // The premise: the fixed noun list does not know this word. The same closing on a letter that never used the noun is rejected.
        const unused = verdict(letterFor(domain, closing, { proofs: ['I kept the incoming records current for the whole team.'] }));
        assert(!unused.passed && unused.detail.includes('missing its asset half'), `${domain.key}/premise: ${domain.artifact} is on no fixed list, so a letter that never used it is rejected (${detailOf(unused)})`);
        // A: earlier paragraph.
        const earlier = verdict(letterFor(domain, closing));
        assert(earlier.passed, `${domain.key}/A: the letter built the ${domain.artifact} in an earlier paragraph, so the closing may refer back to it (${detailOf(earlier)})`);
        // B: an earlier sentence of the closing paragraph itself, with the graded sentence last.
        const sameParagraph = verdict([domain.opening, `${domain.proofs[0]} ${closing}`]);
        assert(sameParagraph.passed, `${domain.key}/B: an earlier sentence of the closing paragraph counts (${detailOf(sameParagraph)})`);
        // C: a cited career-data quote whose authorship verb governs the noun, when no sentence of the letter says it.
        const bare = ['I kept the incoming records current for the whole team.'];
        const quoted = verdict(letterFor(domain, closing, { proofs: bare }), { citations: [[], [domain.quote], []] });
        assert(quoted.passed, `${domain.key}/C: a cited quote states the candidate built the ${domain.artifact} (${detailOf(quoted)})`);
        // D: the same closing with a plural or a different modifier still resolves on the head noun, and a second artifact works the same way.
        const second = verdict(letterFor(domain, closingFor(domain.other, domain.employerSide)));
        assert(second.passed, `${domain.key}/D: the second artifact the letter built (${domain.other}) is available to the closing too (${detailOf(second)})`);
        const plural = verdict(letterFor(domain, closingFor(`${domain.artifact}s`, domain.employerSide)));
        assert(plural.passed, `${domain.key}/D: the plural of a noun the letter used counts (${detailOf(plural)})`);
        // The whole battery agrees: the closing's check is the only thing this changes.
        const battery = evaluateCoverLetterChecks({ plan: {}, paragraphs: letterFor(domain, closing), evidence: { roles: [], projects: [], bullets: [] }, jobText: '', researchText: '', companyName: '' });
        assert(battery.find(check => check.id === 'direct-welcome-closing').passed, `${domain.key}/battery: the whole evaluation passes the closing`);
      }
    },
  },
  {
    name: 'Closing, rejected: rename the artifact so the letter never used it and the closing is rejected; every near miss stays rejected (A/B/C, 4 domains)',
    run() {
      for (const domain of DOMAINS) {
        const closing = closingFor(domain.artifact, domain.employerSide);
        // A / B / C: the artifact renamed away from anything the letter said, then put into the letter, then taken out of it again.
        const renamed = closingFor('visitor map', domain.employerSide);
        const rejected = verdict(letterFor(domain, renamed));
        assert(!rejected.passed && rejected.detail.includes('missing its asset half'), `${domain.key}/A: a closing naming something the letter never said it made is rejected (${detailOf(rejected)})`);
        const added = verdict(letterFor(domain, renamed, { proofs: [...domain.proofs, 'I developed a visitor map that guests followed on arrival.'] }));
        assert(added.passed, `${domain.key}/B: the same closing passes once the letter says the candidate developed that artifact (${detailOf(added)})`);
        const removed = verdict(letterFor(domain, renamed, { proofs: [...domain.proofs, 'I kept a visitor map that guests followed on arrival.'] }));
        assert(!removed.passed, `${domain.key}/C: and fails again when the verb is not an authorship verb (${detailOf(removed)})`);

        // Near misses. Each is a letter that mentions the noun without the candidate having made it, or a noun that names nothing.
        const nearMisses = [
          ['a noun used by the candidate, not made by them', [`I used the ${domain.artifact} that the previous team left.`]],
          ['someone else built it', [`The previous team built a ${domain.artifact} that I inherited.`]],
          ['a noun that was only a complement inside the object', [`I built a ${domain.other} that replaced the old ${domain.artifact}.`]],
          ['a noun that was only a modifier inside the object', [`I built a ${domain.artifact} archive for the team.`]],
          ['the verb is present tense and not the candidate\'s', [`The ${domain.artifact} builds itself each night.`]],
          ['a noun that follows a preposition of the object', [`I built the schedule for the ${domain.artifact}.`]],
        ];
        for (const [why, proofs] of nearMisses) {
          const near = verdict(letterFor(domain, closing, { proofs }));
          assert(!near.passed && near.detail.includes('missing its asset half'), `${domain.key}/near: ${why} does not license the closing (${detailOf(near)})`);
        }
        // Light nouns and pronouns name nothing even when the letter said the candidate built one.
        for (const light of ['one', 'thing', 'piece', 'it']) {
          const vacuous = verdict(letterFor(domain, closingFor(light, domain.employerSide), { proofs: [`I built ${light === 'it' ? 'it' : `one ${light}`} for the whole team.`] }));
          assert(!vacuous.passed, `${domain.key}/near: “the ${light} I built” names nothing (${detailOf(vacuous)})`);
        }
        // The closing sentence's own noun does not count: with no earlier sentence, there is nothing to refer back to.
        const alone = verdict([closing]);
        assert(!alone.passed && alone.detail.includes('missing its asset half'), `${domain.key}/near: the graded sentence is not its own evidence (${detailOf(alone)})`);
        // A quote supports the noun only through an authorship verb: a quote that merely mentions the artifact does not.
        const mentioned = verdict(letterFor(domain, closing, { proofs: ['I kept the incoming records current for the whole team.'] }), { citations: [[], [`Retired the ${domain.artifact} after the migration.`], []] });
        assert(!mentioned.passed, `${domain.key}/near: a quote that retires the artifact does not say the candidate built it (${detailOf(mentioned)})`);
        const verbless = verdict(letterFor(domain, closing, { proofs: ['I kept the incoming records current for the whole team.'] }), { citations: [[], [`Staff relied on the ${domain.artifact} each shift.`], []] });
        assert(!verbless.passed, `${domain.key}/near: a quote that only names the artifact is no authorship (${detailOf(verbless)})`);
        // Citations of the wrong shape never throw and never help.
        for (const odd of [null, undefined, 'text', [null], [[null, 7, {}]], {}]) {
          assert(!verdict(letterFor(domain, closing, { proofs: ['I kept the incoming records current for the whole team.'] }), { citations: odd }).passed, `${domain.key}/near: malformed citations (${JSON.stringify(odd)}) add nothing`);
        }
      }
    },
  },
  {
    name: 'Closing, unchanged: every earlier accepted form and every earlier rejection behaves as before (4 domains)',
    run() {
      for (const domain of DOMAINS) {
        const proofs = ['I kept the incoming records current for the whole team.'];
        const accepted = [
          ['the possessive form', `I welcome a conversation about how my ${domain.head} work could support ${domain.employerSide}.`],
          ['a fixed artifact noun without the letter saying it', closingFor('tool', domain.employerSide)],
          ['a demonstrative with its own descriptor', `I welcome a conversation about applying that ${domain.head} building experience to ${domain.employerSide}.`],
          ['the authorship clause with a noun on the fixed list', closingFor('dashboard', domain.employerSide)],
        ];
        for (const [why, closing] of accepted) {
          assert(verdict(letterFor(domain, closing, { proofs })).passed, `${domain.key}: ${why} still passes (${closing})`);
        }
        const rejected = [
          ['a bare invitation', 'I welcome a conversation.'],
          ['a bare demonstrative', `I welcome a conversation about applying that work to ${domain.employerSide}.`],
          ['an asset the letter built with no employer side', `I welcome a conversation about the ${domain.artifact} I built.`],
          ['a conditional opening modal', `I would welcome a conversation about how the ${domain.artifact} I built could support ${domain.employerSide}.`],
        ];
        for (const [why, closing] of rejected) {
          assert(!verdict(letterFor(domain, closing)).passed, `${domain.key}: ${why} is still rejected even on a letter that built the ${domain.artifact} (${closing})`);
        }
        // The employer side is still required: the asset half passing does not excuse the target half, and the message names only the half that is missing.
        const noTarget = verdict(letterFor(domain, `I welcome a conversation about how the ${domain.artifact} I built could support my own growth.`));
        assert(!noTarget.passed && noTarget.detail.includes('the sentence is missing its target half') && !noTarget.detail.includes('authorship clause'), `${domain.key}: a closing that reaches no employer side names the target half alone (${detailOf(noTarget)})`);
      }
    },
  },
  {
    name: 'Closing, guidance: the asset half the contract and the rejection print says what the gate accepts from the same constants, and the target half prints placeholders, not a domain (A/B/C)',
    run() {
      const parts = closingContributionParts();
      const asset = parts[0];
      // A: the verbs the guidance lists are the verbs the gate reads, in the same order, from the exported constant.
      const verbs = `${CANDIDATE_AUTHORSHIP_VERBS.slice(0, -1).join(', ')} or ${CANDIDATE_AUTHORSHIP_VERBS.at(-1)}`;
      assert(asset.includes(`in an authorship clause the verb is one of ${verbs}`) && CANDIDATE_AUTHORSHIP_VERBS.includes('built') && CANDIDATE_AUTHORSHIP_VERBS.includes('architected'), `the asset half lists the authorship verbs (${asset})`);
      // B: it says what the gate accepts about the noun: one the letter already used for the candidate's own work, in an earlier sentence or a cited quote.
      for (const phrase of ['the <artifact> I built', 'a noun this letter has already used for your own work', 'the object of an earlier sentence of yours with such a verb', 'in a career-data quote the letter cites']) {
        assert(asset.includes(phrase), `the asset half says: ${phrase}`);
      }
      assert(asset.includes('possessive, an authorship clause, or a demonstrative that carries its own descriptor') && asset.includes('never a bare demonstrative'), 'and it keeps the earlier accepted forms');
      // The stage contract prints the same words the check reports (one source), and so does a rejection.
      assert(guidance.LETTER_CLOSING_RULE.includes(`(1) ${asset}`), 'the stage contract prints the asset half exactly as the check words it');
      const emitted = checkDirectWelcomeClosing(['I welcome a conversation.'], '');
      assert(!emitted.passed && emitted.detail.includes(asset), 'and a rejection prints the same sentence');
      // C: the target half prints placeholders and no domain noun.
      const target = parts[2];
      assert(target.includes('“the … <noun>”') && target.includes('“this … <noun>”') && target.includes('“clients”, “customers”, “users”'), `the target half prints placeholders (${target})`);
      for (const text of parts) assert(!/\b(?:platform|pipeline|dashboard|repository|database|server)\b/iu.test(text), `no part of the closing grammar prints a software noun (${text})`);
    },
  },
];
