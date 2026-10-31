/** Dedicated, Prepare-generated optional claims. Like the memorized lines,
 * every point is bound to complete cited evidence before it can be sealed.
 * The live window only exposes that approved prose; it never creates claims.
 */
import { interviewClaimContent, interviewClaimFailures,
  interviewSpokenWordCount, interviewStandaloneFailures } from './interviewSpokenClaims.js';
import { isInterviewWhyQuestion, interviewResearchInterestText } from './interviewQuestionFit.js';

export const INTERVIEW_EXTENSION_MAX_CHARACTERS = 220;
export const INTERVIEW_EXTENSION_MAX_WORDS = 18;
export const INTERVIEW_EXTENSION_MAX_POINTS = 4;
const EVIDENCE_ID = /^(?:career|research)-[a-f0-9]{64}$/u;
const POINT_ID = /^[A-Za-z0-9_-]{1,96}$/u;
const POINT_KEYS = ['id', 'text', 'evidenceIds', 'quotes'];

function plain(value) {
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value, keys) {
  return plain(value) && Reflect.ownKeys(value).length === keys.length
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));
}
function sourceLabel(sources) { return [...new Set(sources.map(source => source.sourceLabel))].join(' · '); }
function extensionFailure(rule) {
  const error = new Error('The optional interview extension is not grounded in additional prepared evidence.');
  error.code = rule;
  throw error;
}

/** Hooks are source navigation, never AI-authored facts. Keep the project name
 * when available and otherwise the documented role/employer or research label.
 * The full source label and exact quotation remain independently inspectable.
 */
function exampleHook(sources) {
  const labels = sources.map(source => {
    if (source.kind === 'research') return source.sourceField === 'roleContext' ? 'Prepared role research' : source.sourceUrl || source.sourceLabel;
    const label = source.sourceLabel.split(' · ').at(-1);
    if (label && !/^Saved (?:achievement|career evidence)$/u.test(label)) return label;
    return [source.roleContext?.employer, source.roleContext?.title].filter(Boolean).join(' · ') || label;
  });
  const hook = [...new Set(labels.filter(Boolean))].join(' · ');
  return hook.length <= 120 ? hook : `${hook.slice(0, 117).trimEnd()}…`;
}

/** Mechanical checks run on each extension just as on headline/bullet claims.
 * Prepare also submits surviving points to the same digest-bound semantic
 * entailment review; vocabulary overlap is never a substitute for that review.
 * Unsealed drafts may defer sibling-detail comparison until semantic review
 * has removed bad citation bindings. Stored points always use the default.
 */
export function validateInterviewExtensionPoint(point, { evidence = [], card, previousPoints = [], compareSiblingDetails = true } = {}) {
  if (!exact(point, POINT_KEYS) || !POINT_ID.test(point.id || '')
    || previousPoints.some(previous => previous.id === point.id)
    || typeof point.text !== 'string' || !point.text.trim()
    || point.text.length > INTERVIEW_EXTENSION_MAX_CHARACTERS
    || /[\p{Cc}\p{Cf}]/u.test(point.text)
    || interviewSpokenWordCount(point.text) > INTERVIEW_EXTENSION_MAX_WORDS) extensionFailure('INTERVIEW_EXTENSION_SHAPE');
  if (!Array.isArray(point.evidenceIds) || point.evidenceIds.length < 1 || point.evidenceIds.length > 4
    || new Set(point.evidenceIds).size !== point.evidenceIds.length
    || point.evidenceIds.some(id => typeof id !== 'string' || !EVIDENCE_ID.test(id))
    || !Array.isArray(point.quotes) || point.quotes.length !== point.evidenceIds.length
    || new Set(point.quotes.map(quote => quote?.evidenceId)).size !== point.quotes.length
    || point.quotes.some(quote => !exact(quote, ['evidenceId', 'quote']) || !point.evidenceIds.includes(quote.evidenceId))) extensionFailure('INTERVIEW_EXTENSION_CITATION');
  const sources = point.evidenceIds.map(id => evidence.find(source => source.id === id));
  if (sources.some(source => !source || !['career', 'research'].includes(source.kind))
    || sources.some(source => point.quotes.find(quote => quote.evidenceId === source.id)?.quote !== source.text)) extensionFailure('INTERVIEW_EXTENSION_SOURCE');
  const researchOnly = sources.every(source => source.kind === 'research');
  if (sources.some(source => source.kind === 'research') && (!researchOnly || !isInterviewWhyQuestion(card?.question))) extensionFailure('INTERVIEW_EXTENSION_RESEARCH');
  const researchFact = interviewResearchInterestText(point.text);
  const interest = researchOnly && researchFact !== undefined && !/\b(?:I|we|my|our|me|us)\b/iu.test(researchFact);
  if (researchOnly && /\b(?:I|we|my|our|me|us)\b/iu.test(point.text) && !interest) extensionFailure('INTERVIEW_ANSWER_RESEARCH_AGENCY');
  const grounded = interest ? { ...point, text: researchFact } : point;
  const failures = interviewClaimFailures(grounded, sources);
  if (failures.length) extensionFailure(failures[0].rule);
  if (interviewStandaloneFailures(point.text).length || interviewClaimContent(grounded.text).length < 2) extensionFailure('INTERVIEW_EXTENSION_CONCRETE');
  const prepared = [card?.headline, ...(Array.isArray(card?.bullets) ? card.bullets : []), card?.example];
  const known = new Set(prepared.flatMap(statement => interviewClaimContent(statement?.text || '')));
  // Merely adding the employer/title to an existing bullet is attribution,
  // not an additional angle. Those names already serve as the example hook.
  const roleNames = new Set(sources.flatMap(source => interviewClaimContent([
    source.roleContext?.title, source.roleContext?.employer,
  ].filter(Boolean).join(' '))));
  const content = interviewClaimContent(grounded.text);
  if (!content.some(token => !known.has(token) && !roleNames.has(token))) extensionFailure('INTERVIEW_EXTENSION_NEW_DETAIL');
  // A sibling can still fail semantic review. Do not combine its vocabulary
  // with the memorized answer and thereby suppress another, safe proposition.
  // Check repetition against each sibling independently instead.
  if (compareSiblingDetails) {
    for (const previous of previousPoints) {
      const previousContent = new Set(interviewClaimContent(previous.text));
      if (!content.some(token => !previousContent.has(token) && !roleNames.has(token))) extensionFailure('INTERVIEW_EXTENSION_NEW_DETAIL');
    }
  }
  return structuredClone(point);
}

/** Sparse preparation: a failing optional claim cannot invalidate its card or
 * displace another valid point. No missing point is invented to fill a quota.
 * Sealed-bank readers separately require every stored point to validate.
 * Before semantic review only, compareSiblingDetails:false keeps alternative
 * citation bindings; full comparison runs again after semantic sparse drops.
 */
export function sanitizeInterviewExtensions(card, evidence = [], { compareSiblingDetails = true } = {}) {
  const points = [];
  if (!Array.isArray(card?.extensions)) return points;
  for (const point of card.extensions) {
    if (points.length === INTERVIEW_EXTENSION_MAX_POINTS) break;
    try { points.push(validateInterviewExtensionPoint(point, { evidence, card, previousPoints: points, compareSiblingDetails })); }
    catch { /* Drop only this point; keep safe siblings and the memorized card. */ }
  }
  return points;
}

/** Read the separately prepared points, never promote the memorized example.
 * Attribution and tiny hooks are derived from the same sealed sources.
 */
export function prepareInterviewExtensionCandidates(bank) {
  const result = Object.create(null);
  for (const card of Array.isArray(bank?.cards) ? bank.cards : []) {
    if (!POINT_ID.test(card?.id || '')) continue;
    result[card.id] = sanitizeInterviewExtensions(card, bank.evidence).map(point => {
      const sources = point.evidenceIds.map(id => bank.evidence.find(source => source.id === id));
      return { ...point, sourceLabel: sourceLabel(sources), exampleHook: exampleHook(sources) };
    });
  }
  return result;
}
