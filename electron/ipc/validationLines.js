import { validationFailure } from './validationFailure.js';

// Code-authored teaching sentences. Variable values are formatted below.
export const VALIDATION_TEMPLATES = Object.freeze({
  "research.coverage": "assessments has {raw} rows; return exactly one assessment for the requested preferenceId",
  "research.identity": "preferenceId {value} or outcome is invalid; copy the requested preferenceId and use confirmed, conflicts or unverified",
  "scoring.score-invalid": "rows {ids} have a matchScore that is not an integer from 0 to 100",
  "scoring.logistics-gap": "work authorization, citizenship, sponsorship or location, onsite or relocation is listed as a material gap at {ids}; these are informational logistics, so remove them and give them zero penalty in matchScore",
  "scoring.scores-missing": "scores is missing or not an array; return a JSON object with a scores array holding one row for each of the {total} jobs",
  "scoring.index-duplicate": "row indexes {ids} appear more than once; each index from 0 to {max} may appear once",
  "scoring.index-invalid": "row indexes {ids} are not integers from 0 to {max}",
  "scoring.no-usable-row": "no row has an integer index from 0 to {max}; return one row per job",
  "scoring.row-missing": "rows {ids} are missing; return one row for every index from 0 to {max}",
  "scoring.no-requirement-rows": "rows {ids} list no requirementAssessments and no materialGaps; list every distinct professional requirement of the posting",
  "scoring.evidence-blank": "jobEvidence is blank, or a required candidateEvidence is blank, at {ids}; every requirement row needs its verbatim posting span, and direct, adjacent or contradicted rows also need a verbatim candidate span",
  "scoring.evidence-reuse": "the same jobEvidence span is cited for different requirements at {ids}; give each distinct requirement its own shortest verbatim posting span instead of reusing a compound sentence",
  "scoring.no-grounded-requirement": "rows {ids} have no professional requirement whose jobEvidence appears verbatim in the supplied posting; work authorization and location rows do not count, so copy each span exactly as written in the listing",
  "inventory.empty": "requirements is empty; list every distinct professional requirement of the listing",
  "inventory.row-fields": "requirements {ids} have a blank requirementText or a priority that is not one of required, important, preferred or contextual",
  "inventory.quote-not-verbatim": "requirements {ids} cite a jobEvidence span that is not found verbatim in the listing",
  "inventory.quote-duplicate": "requirements {ids} repeat the jobEvidence of an earlier requirement; use one requirement per distinct listing clause",
  "inventory.logistics": "requirements {ids} are work authorization or location logistics, which are excluded from professional requirements",
  "evidence.count": "assessments has {raw} rows for {total} requirements; return exactly one row per requirementId",
  "evidence.id-unknown": "requirementId {value} is not one of the supplied requirement ids; copy ids exactly",
  "evidence.id-duplicate": "requirementIds {ids} appear more than once",
  "evidence.id-missing": "requirementIds {ids} have no assessment",
  "evidence.status-invalid": "status is not one of direct, adjacent, not_documented, contradicted or unclear for {ids}",
  "evidence.quote-required": "direct, adjacent and contradicted rows {ids} must quote candidateEvidence exactly from this approved page",
  "evidence.quote-not-on-page": "candidateEvidence is not present on this approved page for {ids}",
  "evidence.absence-with-quote": "not_documented rows {ids} must have an empty candidateEvidence",
  "synthesis.absence-contradicts-support": "requirementIds {ids} are marked not_documented although an approved page documented support; use direct or adjacent",
  "synthesis.absence-with-quote": "a not_documented requirement {ids} must have an empty candidateEvidence",
  "synthesis.quote-not-retrieved": "candidateEvidence for {ids} is not quoted from the evidence retrieved for that requirement in the ledger",
  "gap.reviews-missing": "reviews is not an array; return an object with a reviews array holding one entry per job index",
  "gap.index-invalid": "review index {value} is not an integer from 0 to {max}",
  "gap.index-duplicate": "job indexes {ids} are reviewed more than once",
  "gap.job-missing": "job indexes {ids} have no review",
  "gap.rows-not-array": "rows is not an array for job indexes {ids}",
  "gap.row-unlisted": "row ids {ids} are not among the listed gap row ids of their job",
  "gap.row-duplicate": "row ids {ids} appear more than once within their job",
  "gap.row-missing": "listed gap rows {ids} are missing from their job review; return every listed row id exactly once",
  "gap.verdict-invalid": "verdict {value} is not one of confirmed, priority, evidence or duplicate at {ids}",
  "gap.priority-invalid": "priority {value} is not one of required, important or preferred at {ids}",
  "gap.priority-not-lower": "priority {value} is not lower than the listed priority at {ids}; a priority can only be lowered",
  "gap.quote-empty": "jobEvidence (verdict priority) or candidateEvidence (verdict evidence) is empty at {ids}",
  "gap.status-invalid": "status {value} is not one of direct or adjacent at {ids}",
  "gap.duplicate-of-invalid": "duplicateOf at {ids} is empty, is the id of the row itself, or is not another listed row id of the same job",
  "plan.shape": "the plan does not match the response schema: a field is missing, has the wrong type, is blank or is over its limit; return every field of the schema",
  "plan.id-duplicate": "preference ids {ids} are repeated; each id must be unique across softPreferences and strictRequirements",
  "plan.criterion-duplicate": "criterion text {value} (ignoring case) appears more than once across softPreferences and strictRequirements at {ids}; keep each criterion in exactly one list",
  "plan.direction-unmatched": "direction entries {ids} do not match the criterion text of any preference with category role, ignoring case; copy the text of a role preference exactly or add a matching role preference; first unmatched: {value}",
  "research.batch-coverage": "assessments has {raw} rows for {total} requested researchIds; missing researchIds {list}",
  "research.batch-id-unknown": "researchIds {ids} are not requested ids; first returned {value}",
  "research.batch-id-duplicate": "researchIds {ids} appear more than once",
  "research.batch-preference-mismatch": "preferenceId does not match the preference requested for researchIds {ids}; copy each researchId together with its own preferenceId",
  "research.batch-outcome": "outcome is not one of confirmed, conflicts or unverified for researchIds {ids}",
  "research.batch-quote": "evidenceQuote is not one contiguous passage of the section that has the same researchId for {ids}; use outcome unverified with an empty evidenceQuote when that section has no such passage",
  "research.batch-url": "no sourceUrls entry appears in the section that has the same researchId for {ids}; use outcome unverified with an empty sourceUrls array when that section has none",
  "listing.row-count": "assessments has {raw} rows; return exactly {total} listing rows, one per local listing index",
  "listing.index-invalid": "row positions {ids} carry an index that is not an integer from 0 to {max}, or that repeats an earlier row; return every local listing index exactly once",
  "listing.listing-id": "listingId does not match the listingId shown for the same local index at listing indexes {ids}; copy each listingId exactly with its index; first returned {value}",
  "listing.matches-count": "listing indexes {ids} return {raw} matches where {expected} are required; return exactly one match per preferenceId",
  "listing.preference-missing": "listing indexes {ids} omit preferenceIds; for the first of them the omitted ids are {list}",
  "listing.preference-unknown-or-duplicate": "listing indexes {ids} include a preferenceId that is not in the plan or is repeated; first offending value {value}",
  "listing.outcome-invalid": "outcome is not one of confirmed, conflicts or unverified at {ids}",
  "listing.quote-missing": "confirmed or conflicts outcomes at {ids} need a short evidenceQuote copied verbatim from that listing; use unverified when none exists",
  "taxonomy.role-count": "roleFamilies has {raw} labels; return 1 to {max} non-empty labels",
  "taxonomy.role-blank": "roleFamilies has blank labels at {ids}",
  "taxonomy.role-duplicate": "roleFamilies repeats a label (case-insensitive) at {ids}",
  "taxonomy.role-other": "roleFamilies must include one family labeled exactly Other",
  "taxonomy.range-count": "salaryRanges has {raw} entries; return 2 to 5 including exactly one Unspecified (minSalary 0, maxSalary 0)",
  "taxonomy.range-bounds": "salaryRanges bounds at {ids} must be non-negative integers",
  "taxonomy.range-unspecified-position": "the Unspecified range (0, 0) is at {ids}; it must be the last entry",
  "taxonomy.range-zero-min": "salaryRanges {ids} use minSalary 0 but are not Unspecified; a real range needs minSalary of at least 1",
  "taxonomy.range-top-open": "salaryRanges.0 is the top range and must be open-ended (maxSalary 0); it has maxSalary {raw}",
  "taxonomy.range-contiguity": "salaryRanges {ids} do not end where the range listed before them begins; each maxSalary must equal the minSalary of the range before it (first offender: maxSalary {raw} against that minSalary {value})",
  "taxonomy.range-order": "salaryRanges {ids} have a minSalary that is not below the minSalary of the range before them; order ranges from highest to lowest",
  "taxonomy.range-inverted": "salaryRanges {ids} have a maxSalary that is not above their minSalary",
  "taxonomy.range-unspecified-count": "salaryRanges has {raw} Unspecified entries; exactly one is required",
  "taxonomy.direction-count": "directionRoleIndexes has {raw} mappings; return 1 to 24, one per commonSuggestedDirections entry",
  "taxonomy.direction-blank": "directionRoleIndexes {ids} have a blank direction",
  "taxonomy.direction-index": "directionRoleIndexes {ids} have a roleIndex outside 0 to {familyMax}",
  "taxonomy.direction-duplicate": "directionRoleIndexes {ids} repeat a direction; first repeated value {value}",
  "taxonomy.direction-unknown": "directionRoleIndexes {ids} name a direction that is not in commonSuggestedDirections; first offending value {value}",
  "taxonomy.direction-missing": "commonSuggestedDirections entries {ids} have no mapping; return exactly one mapping for each",
  "taxonomy.chunk-count": "roleByIndex has {raw} entries; return exactly {total} integers in chunk input order",
  "taxonomy.chunk-missing": "roleByIndex positions {ids} are missing",
  "taxonomy.chunk-non-integer": "roleByIndex positions {ids} are not integers",
  "taxonomy.chunk-out-of-range": "roleByIndex positions {ids} are outside 0 to {max}; the roleFamilies list has {families} entries",
  "taxonomy.chunk-extra": "roleByIndex has {raw} extra entries beyond position {max}",
  "sections.preface": "text outside the sections was found; put nothing before the first BEGIN marker or after the last END marker, and no code fences",
  "sections.marker-malformed": "{raw} marker lines are malformed, nested or unmatched; each marker is on its own line in the exact form BEGIN {label} <id> and END {label} <id>, with one END for every BEGIN and no trailing spaces",
  "sections.unknown": "sections {ids} use ids that were not requested",
  "sections.duplicate": "sections {ids} appear more than once",
  "sections.empty": "sections {ids} are empty; every requested section needs content",
  "sections.missing": "requested sections {ids} are missing; return exactly one section for every requested id",
  "sections.order": "sections are not in the requested order",
  "lookup.result-line": "sections {ids} need a RESULT line that says FOUND or NOT FOUND",
  "lookup.found-fields": "FOUND sections {ids} omit required fields {list}; give every field or answer NOT FOUND",
  "text.official-research-empty": "official posting research is empty; return one candidate section or NOT FOUND section for every requested id",
  "text.official-research-length": "official posting research exceeds {max} characters; shorten candidate lists without omitting any requested id",
  "text.official-research-row": "official posting sections {ids} need only NOT FOUND or 1 to 6 CANDIDATE JSON lines; do not return a verdict or commentary",
  "text.official-research-json": "official posting candidate lines at {ids} are not valid JSON objects; use one complete object per CANDIDATE line",
  "text.official-research-fields": "official posting candidates at {ids} need exactly careersPageUrl, postingUrl, employer, employerDomain and ats as bounded strings",
  "text.official-research-url": "official posting candidates at {ids} need an absolute HTTPS careers or posting URL without credentials, whitespace or control characters",
  "text.official-research-domain": "official posting employerDomain at {ids} must be empty or an absolute HTTPS domain root without credentials, a query or a fragment",
  "text.official-research-duplicate": "official posting sections {ids} repeat a candidate; return each candidate URL combination once",
  "lookup.official-match-json": "official posting comparison is not a JSON object; return only the requested choice, evidence, distinguishing and conflicts object",
  "lookup.official-match-length": "official posting comparison is over its response bound; retain at most 12 evidence pairs, bounded distinguishing entries and no conflicts",
  "lookup.official-match-fields": "official posting comparison needs exactly choice, evidence as at most 12 pairs, distinguishing as at most 8 entries and conflicts as at most 8 bounded strings",
  "lookup.official-match-choice": "official posting comparison choice must be one supplied option id or none; do not invent an option",
  "lookup.official-match-none": "official posting comparison choice none requires empty evidence, distinguishing and conflicts arrays",
  "lookup.official-match-pair": "official posting comparison pairs {ids} need exactly scrapedQuote and officialQuote as nonblank strings of at most 4000 characters",
  "lookup.official-match-verbatim": "official posting comparison pair and side {ids} contain a quote absent from that supplied text; copy each span verbatim",
  "lookup.official-match-short": "official posting comparison pairs {ids} need at least 8 words in each quote; quote complete duties or requirements",
  "lookup.official-match-count": "a chosen option needs at least 3 counted quote pairs; use none if the supplied descriptions cannot support enough evidence",
  "lookup.official-match-parts": "a chosen option needs distinct quote pairs from at least 2 disjoint parts of both texts; do not split or repeat one passage",
  "lookup.official-match-boilerplate": "company copy, benefits, EEO and board-wide boilerplate do not count as role evidence; supply at least 3 pairs about the chosen job",
  "lookup.official-match-distinctive": "the choice lacks unique role evidence or contradicts a verbatim role passage in the scraped text that belongs only to another option; reassess the choice and provide distinctive evidence",
  "lookup.official-match-distinguishing": "distinguishing entries {ids} are invalid or missing; for each other live option supply its id, a verbatim chosen quote absent from that option, and a short reason",
  "lookup.official-match-conflicts": "a valid official posting comparison requires an empty conflicts array; choose none if conflicting facts prevent a match",
  "comp.assess-count": "assessments for {ids} do not cover every listing index of that cohort exactly once (received {raw}; missing indexes {list})",
  "comp.range-values": "comparable=true ranges at {ids} need min above 0 and max not below min",
  "comp.range-currency": "comparable=true ranges at {ids} must use the currency of the listings in that cohort; first used {value}",
  "comp.range-source": "comparable=true ranges at {ids} need a non-blank sourceName and a sourceUrl that appears in the research section of that cohort",
  "comp.cohort-count": "cohorts has {raw} entries for {total} requested researchIds; missing researchIds {list}",
  "comp.cohort-id": "researchIds {ids} are unknown or repeated; each requested researchId appears exactly once; first offending value {value}",
  "comp.range-quote": "comparable=true ranges at {ids} need an evidenceQuote of at least 8 characters found verbatim in the section with the same researchId",
  "comp.range-date": "comparable=true ranges at {ids} need a sourceDate of at least 3 characters found verbatim in the section with the same researchId (not stated is allowed only if that section says so)",
  "ladder.bands-empty": "bands is empty while sources are present; return both empty when no auditable ladder exists, or a complete ladder",
  "ladder.label": "bands {ids} have a blank label",
  "ladder.years-integer": "bands {ids} must use whole-number minYears and maxYears with maxYears not below minYears",
  "ladder.start": "the first band must start at minYears 0; it starts at {raw}",
  "ladder.contiguous": "bands {ids} must start exactly one year after the previous band ends (previous maxYears + 1)",
  "ladder.end": "the last band must end at maxYears 99; it ends at {raw}",
  "ladder.sources-missing": "sources is empty, or none of its URLs appears in the research section of {ids}; use only URLs written in that section",
  "ladder.source-invalid": "sources {ids} need a name and an http(s) URL",
  "ladder.evidence-quote": "evidenceQuote must be at least 8 characters and found verbatim in the section with the same researchId for {ids}",
  "ladder.evidence-date": "sourceDate must be at least 3 characters and found verbatim in the section with the same researchId for {ids} (not stated is allowed only if that section says so)",
  "rolefam.count": "ladders has {raw} entries for {total} requested researchIds; missing researchIds {list}",
  "rolefam.id": "researchIds {ids} are unknown or repeated; first offending value {value}",
  "rolefam.role-mismatch": "roleFamily does not match the role family requested for researchIds {ids}; copy it exactly as shown in the request; first returned {value}",
  "rolefam.cached-not-inert": "cached identities {ids} must return empty reusedFrom, bands, sources, evidenceQuote and sourceDate",
  "text.empty": "the response is empty; return the full research text",
  "text.too-long": "the response has {raw} characters and at most {max} are allowed; return a shorter answer that keeps the facts, direct URLs and quotes",
  "locconf.rows": "confirmations has {raw} entries for {total} pairs; return one confirmation per pairId",
  "locconf.pair-unknown": "pairIds {ids} are not supplied pair ids; first returned {value}",
  "locconf.pair-duplicate": "pairIds {ids} appear more than once",
  "locconf.pair-missing": "pairIds {ids} are missing; return one confirmation for every supplied pairId",
  "locconf.same-job-type": "sameJob must be a JSON boolean (true or false, not a string) for pairIds {ids}",
  "liveness.rows": "rows has {raw} entries for {total} supplied pages; return exactly one verdict per supplied id",
  "liveness.id-unknown": "response row positions {ids} use an id outside the supplied ids; copy a supplied id exactly",
  "liveness.id-duplicate": "supplied ids {ids} appear more than once in rows; return each id once",
  "liveness.id-missing": "supplied ids {ids} have no verdict row; cover every supplied id",
  "liveness.row-fields": "rows {ids} must contain exactly id, verdict and quote",
  "liveness.verdict": "rows {ids} need verdict open, closed or unclear",
  "liveness.quote-type": "rows {ids} need quote as JSON text, including an empty string for unclear",
  "liveness.quote-too-long": "quotes for rows {ids} exceed 240 characters; choose a shorter contiguous page passage",
  "liveness.quote-required": "open or closed rows {ids} need a nonempty page quote; only closed with isListed false may leave quote empty",
  "liveness.quote-not-on-page": "quotes for rows {ids} must be one contiguous passage from their own page title, h1, chrome text or outside-description hit context",
  "liveness.quote-in-description": "quotes for rows {ids} occur in description text; use page status evidence outside the description",
  "liveness.open-mismatch": "open rows {ids} refer to a redirected or title-mismatched page; use unclear unless a gone-job quote proves closed",
  "liveness.unclear-quote": "unclear rows {ids} must have an empty quote",
  "interview.not-object": "the answer is not a JSON object; return the brief object defined by the response schema",
  "interview.fact": "fact must be non-blank text copied exactly from RAW RESEARCH at {ids}",
  "interview.quote": "evidenceQuote must be non-blank text copied exactly from RAW RESEARCH at {ids}",
  "interview.url": "sourceUrl must be an http(s) URL copied exactly from RAW RESEARCH at {ids}",
  "interview.date": "sourceDate must be exactly unknown, or date text of at most 80 characters copied exactly from RAW RESEARCH and never a URL, at {ids}",
  "interview.positioning-kind": "documentKind must be resume or coverLetter at {ids}",
  "interview.positioning-point": "point must be text copied exactly from the APPLICATION POSITIONING of the same documentKind at {ids}",
  "interview.positioning-quote": "evidenceQuote must be text copied exactly from the APPLICATION POSITIONING of the same documentKind at {ids}",
  "price.rows": "items has {raw} rows for {total} requested itemIds; return exactly one row per itemId",
  "price.item-unknown": "itemIds {ids} are not requested ids; first returned {value}",
  "price.item-duplicate": "itemIds {ids} appear more than once",
  "price.item-missing": "requested itemIds {ids} have no row",
  "price.item-malformed": "rows {ids} lack a pricing object, a compSourceUrls array or a compSources array",
  "price.url-foreign": "compSourceUrls entries at {ids} are not listing URLs from the section of their own item, or repeat an entry; first offending value {value}",
  "price.source-foreign": "compSources entries at {ids} are not source ids from the section of their own item, or repeat an entry; first offending value {value}",
  "price.sold-count": "market_summary.sold_count at {ids} exceeds the {raw} sold listings supplied for that item",
  "price.active-count": "market_summary.active_count at {ids} exceeds the {raw} currently-active listings supplied for that item",
  "price.breakdown-sum": "comp_breakdown anchor_count + adjusted_count + bound_count at {ids} exceeds the {raw} listings supplied for that item",
  "hub.rows": "platforms has {raw} rows for {total} requested scanIds; return exactly one row per scanId",
  "hub.scan-unknown": "scanIds {ids} are not requested ids; first returned {value}",
  "hub.scan-duplicate": "scanIds {ids} appear more than once",
  "hub.scan-missing": "requested scanIds {ids} have no row",
  "hub.attention-malformed": "attention is not an array for scanIds {ids}",
  "hub.url-foreign-section": "sourceUrl at {ids} is a page of a different scanId; use a HUB PAGE url from the section of the same scanId, or omit sourceUrl",
  "research.quote": "evidenceQuote is not one contiguous passage of the supplied research; use outcome unverified with an empty evidenceQuote when no such passage exists",
  "research.url": "no sourceUrls entry appears in the supplied research; use outcome unverified with an empty sourceUrls array when no source exists",
  "synthesis.count": "final assessments has {raw} rows for {total} requirements; return exactly one row per requirementId",
  "synthesis.id-unknown": "final requirementId {value} is not one of the supplied requirement ids; copy ids exactly",
  "synthesis.id-duplicate": "final requirementIds {ids} appear more than once",
  "synthesis.id-missing": "final requirementIds {ids} have no assessment",
  "synthesis.status-invalid": "final status is not one of direct, adjacent, not_documented, contradicted or unclear for {ids}",
  "synthesis.score": "matchScore must be an integer from 0 to 100 and confidence one of high, medium or low"
});

export function templatesFor(...prefixes) {
  return Object.freeze(Object.fromEntries(Object.entries(VALIDATION_TEMPLATES).filter(([id]) => prefixes.some(prefix => id.startsWith(prefix)))));
}
export const SECTION_CORRECTION_TEMPLATES = templatesFor('sections.');
export const TEXT_CORRECTION_TEMPLATES = templatesFor('text.');

export function quoted(value, max = 80) {
  let text = String(value ?? '').replace(/\p{Cc}/gu, ' ').replace(/\s+/gu, ' ').trim().replace(/'/g, String.fromCharCode(8217));
  if (text.length > max) text = `${text.slice(0, Math.max(0, max - 1))}${String.fromCharCode(8230)}`;
  return JSON.stringify(text);
}
export function bracket(items, max = 8, maxChars = 120) {
  const all = [...new Set((Array.isArray(items) ? items : []).filter(value => typeof value === 'string' || typeof value === 'number')
    .map(value => String(value).replace(/[[\]"'\p{Cc}]/gu, '').replace(/\//g, ':').trim().slice(0, 40)).filter(Boolean))];
  const kept = [];
  for (const value of all) {
    if (kept.length >= max || [...kept, value].join(', ').length > maxChars) break;
    kept.push(value);
  }
  if (kept.length < all.length) {
    let suffix = `+${all.length - kept.length} more`;
    while (kept.length && [...kept, suffix].join(', ').length > maxChars) {
      kept.pop(); suffix = `+${all.length - kept.length} more`;
    }
    kept.push(suffix);
  }
  return `[${kept.join(', ')}]`;
}
const legacyRuleIds = Object.freeze({
  'scoring.row-missing': 'SCORING_ROWS_MISSING', 'scoring.logistics-gap': 'SCORING_LOGISTICS_PENALTY',
  'gap.reviews-missing': 'GAP_REVIEW_NOT_ARRAY', 'gap.index-invalid': 'GAP_REVIEW_INDEX_INVALID',
  'gap.index-duplicate': 'GAP_REVIEW_INDEX_DUPLICATE', 'gap.job-missing': 'GAP_REVIEW_JOB_MISSING',
  'gap.rows-not-array': 'GAP_REVIEW_ROWS_NOT_ARRAY', 'gap.row-unlisted': 'GAP_REVIEW_ROW_ID_UNKNOWN',
  'gap.row-duplicate': 'GAP_REVIEW_ROW_ID_DUPLICATE', 'gap.row-missing': 'GAP_REVIEW_ROW_MISSING',
  'gap.verdict-invalid': 'GAP_REVIEW_VERDICT_INVALID',
});
export const correctionRuleId = id => legacyRuleIds[id] || id.replace(/[.-]/g, '_').toUpperCase();

export function collector() {
  const entries = [];
  const api = {
    add(ruleId, entity, extra = {}) { entries.push({ ruleId, entity, ...extra }); },
    get size() { return entries.length; },
    first() { return entries[0] || null; },
    render(templates, vars = {}) {
      const grouped = new Map();
      for (const entry of entries) {
        if (!Object.hasOwn(templates, entry.ruleId)) throw new TypeError(`Missing validation template ${entry.ruleId}`);
        if (!grouped.has(entry.ruleId)) grouped.set(entry.ruleId, []);
        grouped.get(entry.ruleId).push(entry);
      }
      const problems = [...grouped].slice(0, 12).map(([ruleId, group]) => {
        const first = group[0];
        const values = { ...vars, ids: bracket(group.map(entry => entry.entity)), value: quoted(first.value), raw: String(first.raw), list: bracket(first.list || []), count: String(group.length) };
        const line = templates[ruleId].replace(/\{([A-Za-z]+)\}/g, (_match, name) => {
          if (!Object.hasOwn(values, name)) throw new TypeError(`Unknown validation placeholder ${name}`);
          return String(values[name]);
        });
        return { ruleId, correctionRuleId: correctionRuleId(ruleId), line };
      });
      return { problems, first: api.first() };
    },
    fail({ templates, vars, error, message = error?.message, code = error?.code ?? null, validationDiagnostic = error?.validationDiagnostic } = {}) {
      if (!entries.length) return;
      const { problems, first } = api.render(templates, vars);
      throw validationFailure({ error, message: message ?? first.message, code,
        validationDiagnostic: validationDiagnostic ?? first.diagnostic,
        details: problems.map(problem => problem.line), ruleIds: problems.map(problem => problem.correctionRuleId) });
    },
  };
  return api;
}

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function diagnoseMarkedSections(raw, {
  expectedIds = [], label, idPattern = '[a-f0-9]{24}', trimLines = false,
  caseInsensitive = true, outsideTextAllowed = false, ordered = false, decoratedLookalikes = false,
} = {}) {
  if (!Array.isArray(expectedIds) || !expectedIds.length || new Set(expectedIds).size !== expectedIds.length) return [];
  const normalize = id => caseInsensitive ? String(id).toLowerCase() : String(id);
  const expected = expectedIds.map(normalize);
  const flags = caseInsensitive ? 'i' : '';
  const exact = new RegExp(`^(BEGIN|END) ${escapeRegex(label)} (${idPattern})$`, flags);
  const lookalike = decoratedLookalikes
    ? new RegExp(`^[ \\t>*#\\x60~_-]*(?:BEGIN|END)\\s+${escapeRegex(label)}\\b[^\\n]*$`, 'i')
    : new RegExp(`^(?:BEGIN|END) ${escapeRegex(label)}\\b`, flags);
  let input = String(raw || '').replace(/\r\n?/g, '\n');
  if (outsideTextAllowed) input = input.trim();
  const problems = collector();
  const completed = new Set(), order = [];
  let open = null, body = [], malformed = 0;
  for (const [index, sourceLine] of input.split('\n').entries()) {
    const line = trimLines ? sourceLine.trim() : sourceLine;
    const match = line.match(exact);
    if (match) {
      const id = normalize(match[2]);
      if (match[1].toUpperCase() === 'BEGIN') {
        if (open) malformed++;
        if (!expected.includes(id)) problems.add('sections.unknown', id);
        open = id; body = [];
      } else if (!open || open !== id) malformed++;
      else {
        if (!body.join('\n').trim()) problems.add('sections.empty', id);
        if (completed.has(id)) problems.add('sections.duplicate', id);
        completed.add(id); order.push(id); open = null; body = [];
      }
    } else if (lookalike.test(line)) malformed++;
    else if (open) body.push(line);
    else if (line.trim() && !outsideTextAllowed) problems.add('sections.preface', index);
  }
  if (open) malformed++;
  if (malformed) problems.add('sections.marker-malformed', '', { raw: malformed });
  for (const id of expected) if (!completed.has(id)) problems.add('sections.missing', id);
  if (ordered && order.length === expected.length && order.some((id, index) => id !== expected[index])) problems.add('sections.order', '');
  return problems.render(SECTION_CORRECTION_TEMPLATES, { label }).problems;
}
