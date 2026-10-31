import { interviewClaimFailures } from './interviewSpokenClaims.js';

const BULLET = /^\s*(?:[-*•‣▪◦]|\d+[.)])\s+/u;
// These labels carry structure only. In particular, Observed:, Planned: and
// Did not perform: must stay attached to the sentence they qualify.
const LABEL = /^(?:achievements?|experience|professional experience|work experience|projects?|summary|situation|task|action|result):\s*/iu;
const spaces = value => value.replace(/\s+/gu, ' ').trim();
const normalized = value => spaces(value).toLowerCase().replace(/^i /u, '');

function units(value) {
  const blocks = [];
  let block = '';
  const flush = () => { if (block.trim()) blocks.push(block); block = ''; };
  for (const line of value.split(/(\r?\n|\u2029)/u)) {
    if (/^\r?\n$/u.test(line)) continue;
    if (line === '\u2029') { if (!/:\s*$/u.test(block)) flush(); continue; }
    const cleaned = line.replace(BULLET, '').trimStart().replace(LABEL, '');
    if (!cleaned.trim() || /^(?:achievements?|experience|professional experience|work experience|projects?|summary)\s*$/iu.test(cleaned)) { flush(); continue; }
    // A fresh bullet is an item boundary; an ordinary wrapped line is not.
    // An attribution colon before a bullet still scopes that continuation.
    if (BULLET.test(line) && !/:\s*$/u.test(block)) flush();
    block += ` ${cleaned}`;
  }
  flush();
  const result = [];
  for (const cleaned of blocks) {
    // Blocks (bullets, paragraphs) are already separate; only join within one.
    const start = result.length;
    for (const { segment } of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(cleaned)) {
      const next = spaces(segment);
      if (!next) continue;
      const previous = result.length > start ? result.at(-1) : undefined;
      // Segmenter sometimes treats an abbreviation as a sentence. Never let
      // that boundary discard an observation/negation or a colon continuation.
      if (previous && /(?:\b(?:e\.g|i\.e|dr|mr|mrs|ms|prof|sr|jr|vs|etc)|\b[a-z])\.$|:$/iu.test(previous)) result[result.length - 1] += ` ${next}`;
      else result.push(next);
    }
  }
  return result;
}

function contains(haystack, needles) {
  return needles.length > 0 && haystack.some((_, index) => needles.every((needle, offset) => haystack[index + offset] === needle));
}

// HTML captures retain semantic blocks with paragraph separators. A worker
// often flattens role/date headings into the following complete sentence and
// quotes a later role after omitting unrelated bullets. Match complete blocks
// in order, permitting only omissions between quoted sentences. Never accept
// a substring that could shed an observation, negation or other qualification.
function capturedExcerpts(quoteUnits, resumeUnits) {
  const matched = [];
  let cursor = 0;
  for (const quoted of quoteUnits) {
    let found = false;
    for (let start = cursor; start < resumeUnits.length && !found; start++) {
      let candidate = '';
      for (let end = start; end < resumeUnits.length; end++) {
        candidate += `${candidate ? ' ' : ''}${resumeUnits[end]}`;
        if (candidate === quoted) {
          for (let index = start; index <= end; index++) matched.push(index);
          cursor = end + 1; found = true; break;
        }
        if (candidate.length >= quoted.length || !quoted.startsWith(candidate)) break;
      }
    }
    if (!found) return null;
  }
  return matched.length ? matched : null;
}

const words = value => (String(value || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ');
const ROLE_ACTION = /^(?:(?:I|we)\s+(?:(?:also|only|partially)\s+)*)?(?:built|build|led|lead|maintained|maintain|improved|implemented|tested|created|developed|wrote|evaluated|supported|helped|contributed|assisted|adopted|automated|migrated|coordinated|reviewed|resolved|coached|traced|interviewed|stopped)\b/iu;
const DATE_HEADING = /^(?:january|february|march|april|may|june|july|august|september|october|november|december|(?:19|20)\d{2})\b/iu;

// Source role metadata is an identity constraint, never résumé evidence. Only
// an exact captured title/employer heading may supply that context to a later
// résumé sentence, and the quote must retain that heading. A different or
// unrecognized heading clears the scope instead of borrowing the prior role.
function scopedResumeUnits(captured, careerEvidence) {
  const contexts = careerEvidence.map(item => item.roleContext).filter(item => item?.title && item?.employer);
  let active;
  return captured.map((text, index) => {
    const identity = words(text).replace(/^(?:professional experience|work experience|experience) /u, '');
    const nextIdentity = words(captured[index + 1]);
    const context = contexts.find(item => {
      const title = words(item.title); const employer = words(item.employer);
      return [
        `${title} ${employer}`, `${title} at ${employer}`, `${employer} ${title}`,
      ].includes(identity) || identity === title && nextIdentity === employer || identity === employer && nextIdentity === title;
    });
    if (context) {
      const single = identity.includes(words(context.title)) && identity.includes(words(context.employer));
      active = { roleContext: { title: context.title, employer: context.employer }, contextIndexes: single ? [index] : [index, index + 1] };
    } else if (!active?.contextIndexes.includes(index) && !DATE_HEADING.test(text)
      && (!ROLE_ACTION.test(text)
        || /\bat\s+\p{Lu}/u.test(text) && !words(text).includes(words(active?.roleContext.employer))
        || /\bas an?\s+/iu.test(text) && !words(text).includes(words(active?.roleContext.title)))) {
      // Unknown neutral blocks may be a new employer or section heading. Do
      // not guess their ownership or carry a previous employer across them.
      active = undefined;
    }
    return { text, index, ...active };
  });
}

function coveredClaim(claim, careerEvidence, quoted, included) {
  const originals = careerEvidence.filter(item => claim.evidenceIds.includes(item.id));
  for (const unit of quoted) {
    const grounded = { ...claim, evidenceIds: ['resume'] };
    if (!interviewClaimFailures(grounded, [{ id: 'resume', text: unit.text }]).length) return { ...unit, supportingContextIndexes: [] };
    const ownContext = originals.length === 1 && originals[0].roleContext;
    const capturedContext = ownContext && unit.roleContext
      && words(ownContext.title) === words(unit.roleContext.title) && words(ownContext.employer) === words(unit.roleContext.employer)
      && unit.contextIndexes.every(index => included.has(index)) ? unit.roleContext : undefined;
    if (capturedContext && !interviewClaimFailures(grounded, [{ id: 'resume', text: unit.text, roleContext: capturedContext }]).length) {
      return { ...unit, supportingContextIndexes: unit.contextIndexes };
    }
  }
  return undefined;
}

/** A quote may span wrapped PDF lines, but must retain whole sentence context.
 * Matching at sentence boundaries also supports text captures flattened onto
 * a single line; a line break is neither required nor an attribution boundary.
 */
export function resumeCoverage(quote, careerEvidence, resume, verifyResume, statements) {
  if (typeof quote !== 'string' || !quote.trim()) return false;
  const quoteUnits = units(quote);
  const captured = verifyResume && typeof resume === 'string' ? units(resume) : quoteUnits;
  const indexes = verifyResume && typeof resume === 'string' ? capturedExcerpts(quoteUnits, captured) : captured.map((_, index) => index);
  if (verifyResume && (typeof resume !== 'string' || !indexes)) return false;

  if (!Array.isArray(statements)) {
    const normalizedUnits = quoteUnits.map(normalized);
    return careerEvidence.every(item => contains(normalizedUnits, units(item.text).map(normalized)));
  }

  // Consistency concerns the claims actually spoken, rather than unused
  // details in an evidence note. Reuse the same quantity, attribution, candor
  // and content checks against each complete captured résumé sentence. A
  // favorable substring of a qualified sentence can never be its own source.
  const careerIds = new Set(careerEvidence.map(item => item.id));
  const claims = statements.filter(statement => Array.isArray(statement?.evidenceIds) && statement.evidenceIds.some(id => careerIds.has(id)));
  if (!claims.length) return false;
  const included = new Set(indexes);
  const quoted = scopedResumeUnits(captured, careerEvidence).filter(unit => included.has(unit.index));
  return claims.every(claim => !!coveredClaim(claim, careerEvidence, quoted, included));
}

/** Recover a genuine match even if a repair pessimistically reset the worker
 * flag. Only complete captured sentences passing the existing claim checks
 * can become a quote; unsupported entities, quantities and candor still fail.
 */
export function deriveInterviewResumeConsistency(statements, careerEvidence, resume) {
  if (typeof resume !== 'string' || !Array.isArray(statements) || !Array.isArray(careerEvidence)) return null;
  const careerIds = new Set(careerEvidence.map(item => item.id));
  const claims = statements.filter(statement => Array.isArray(statement?.evidenceIds) && statement.evidenceIds.some(id => careerIds.has(id)));
  if (!claims.length) return null;
  const captured = units(resume);
  const scoped = scopedResumeUnits(captured, careerEvidence);
  const available = new Set(scoped.map(unit => unit.index));
  const selected = new Set();
  for (const claim of claims) {
    const match = coveredClaim(claim, careerEvidence, scoped, available);
    if (!match) return null;
    selected.add(match.index);
    for (const index of match.supportingContextIndexes) selected.add(index);
  }
  const resumeQuote = [...selected].sort((left, right) => left - right).map(index => captured[index]).join('\u2029');
  if (resumeQuote.length > 2400 || !resumeCoverage(resumeQuote, careerEvidence, resume, true, statements)) return null;
  return { consistentWithResume: true, resumeQuote };
}
