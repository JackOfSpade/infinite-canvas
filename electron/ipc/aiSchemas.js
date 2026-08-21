/**
 * Response schemas for AI calls.
 *
 * Passed to callLLM*({ responseSchema }) — Gemini uses them as
 * `generationConfig.responseSchema`, Claude uses them as tool input_schema.
 * Both providers then guarantee the model output matches the schema exactly:
 * valid JSON, required fields present, enums respected, types correct.
 *
 * Format: standard JSON Schema (lowercase types, properties, required, enum,
 * items). Gemini's converter (in gemini.js) lifts to its UPPERCASE format.
 * Claude consumes as-is.
 *
 * Keep these schemas in sync with the prompt's described shape. The schema
 * is the authoritative contract — if the prompt mentions a field the schema
 * doesn't, the field won't make it into the output.
 */

// Marketplace condition tiers — the single source of truth (labels + the
// human/AI-facing definitions) lives in src/utils/productConditions.js, shared
// with the renderer dropdown and the photo-analysis / price-synthesis prompts.
import { CONDITION_VALUES } from '../../src/utils/productConditions.js';
import { SELL_PLATFORMS } from '../../src/utils/constants.js';

// The platform-id enum for recommended_platforms is DERIVED from SELL_PLATFORMS
// (the single source of truth for selling platforms) so adding/removing a
// platform there can't silently leave the AI schema out of sync — the synthesis
// model would otherwise be unable to recommend a newly-added platform.
const SELL_PLATFORM_IDS = SELL_PLATFORMS.map(p => p.id);

// ── Vision: photo → product identification ──────────────────────────────────
export const VISION_PRODUCT_ANALYSIS_SCHEMA = {
  type: 'object',
  required: ['brand', 'model', 'category', 'condition', 'color', 'notable_features', 'generated_title', 'generated_description', 'search_query'],
  properties: {
    brand:             { type: 'string', description: "Brand name, or 'Unknown'" },
    model:             { type: 'string', description: "Model name/number, or 'Unknown'" },
    category:          { type: 'string', description: "Category > Subcategory (e.g. 'Electronics > Headphones > Over-Ear')" },
    condition:         { type: 'string', enum: CONDITION_VALUES, description: 'Item condition tier' },
    color:             { type: 'string' },
    notable_features:  { type: 'string', description: 'Accessories, damage, special features' },
    generated_title:   { type: 'string', description: 'Identification-only selling title (~80 chars); exclude condition/wear descriptors unless part of the official brand, model, or product name' },
    generated_description: { type: 'string', description: 'Buyer-friendly description, 3-4 sentences' },
    search_query:      { type: 'string', description: 'Marketplace-search query for the SINGLE primary product — brand + model + 1-2 price-driving specs; no condition keywords, no bundle/lot/second-product terms' },
  },
};

// ── Pricing: synthesize price recommendation from comps ────────────────────
export const PRICE_SYNTHESIS_SCHEMA = {
  type: 'object',
  required: ['recommended_price', 'quick_sell_price', 'max_profit_price', 'justification', 'match_quality', 'comp_breakdown', 'market_summary', 'recommended_platforms'],
  properties: {
    recommended_price: { type: 'number', description: 'Best single price (1-2 week sale)' },
    quick_sell_price:  { type: 'number', description: 'Price likely to sell in 1-3 days' },
    max_profit_price:  { type: 'number', description: 'Highest reasonable price (3-4 week patience)' },
    justification:     { type: 'string', description: 'Item-only reasoning shown under this individual valuation: market evidence, adjustments, and caveats' },
    match_quality: {
      type: 'string',
      enum: ['strong', 'moderate', 'weak'],
      description: 'Confidence in recommendation based on how well listings matched the item spec',
    },
    comp_breakdown: {
      type: 'object',
      required: ['anchor_count', 'adjusted_count', 'bound_count'],
      properties: {
        anchor_count:   { type: 'integer', description: 'Same-spec listings weighted heaviest' },
        adjusted_count: { type: 'integer', description: 'Similar-but-different listings used with adjustment' },
        bound_count:    { type: 'integer', description: 'Loosely related listings used as ceilings/floors only' },
      },
    },
    market_summary: {
      type: 'object',
      required: ['sold_count', 'active_count'],
      properties: {
        sold_count:    { type: 'integer' },
        sold_median:   { type: 'number' },
        sold_low:      { type: 'number' },
        sold_high:     { type: 'number' },
        active_count:  { type: 'integer' },
        active_lowest: { type: 'number' },
      },
    },
    recommended_platforms: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'reason', 'estimated_fee_pct', 'net_payout'],
        properties: {
          id:                { type: 'string', enum: SELL_PLATFORM_IDS },
          name:              { type: 'string' },
          reason:            { type: 'string', description: 'Why optimal for this item (1 sentence)' },
          estimated_fee_pct: { type: 'number', description: 'Total fee % including processing' },
          net_payout:        { type: 'number', description: 'Recommended price minus fees' },
        },
      },
    },
  },
};

// ── Bundle pricing: combine independently-priced items into one asking price ──
// A SellHub listing can package several independent items (kayak + paddle); each
// is priced on its own from real comps, then THIS call returns attributable
// pricing factors. Code sums those factors and derives every dollar value,
// relationship badge, and explanation from them.
export const BUNDLE_PRICE_SCHEMA = {
  type: 'object',
  required: ['bundle_factors', 'quick_sell_factors', 'max_profit_factors'],
  properties: {
    bundle_factors: {
      type: 'array',
      description: 'Attributable factors that change the bundle value versus the sum. Empty means neutral.',
      items: {
        type: 'object',
        required: ['direction', 'percent', 'reason'],
        properties: {
          direction: { type: 'string', enum: ['premium', 'discount'], description: 'Whether this factor adds to or subtracts from separate value' },
          percent: { type: 'number', description: 'Non-negative magnitude from 0 to 50' },
          reason: { type: 'string', description: 'Specific reason this factor applies to these items; do not state dollar prices' },
        },
      },
    },
    quick_sell_factors: {
      type: 'array',
      description: 'Attributable reductions from Best for a likely sale in 1-3 days. Empty means no reduction.',
      items: {
        type: 'object',
        required: ['percent', 'reason'],
        properties: {
          percent: { type: 'number', description: 'Non-negative reduction from 0 to 75' },
          reason: { type: 'string', description: 'Specific liquidity reason for this reduction; do not state dollar prices' },
        },
      },
    },
    max_profit_factors: {
      type: 'array',
      description: 'Attributable increases from Best for a patient 3-4 week sale. Empty means no increase.',
      items: {
        type: 'object',
        required: ['percent', 'reason'],
        properties: {
          percent: { type: 'number', description: 'Non-negative increase from 0 to 100' },
          reason: { type: 'string', description: 'Specific reason the market may support this increase; do not state dollar prices' },
        },
      },
    },
  },
};

// ── Platform-fit assessment: per-platform good/unfit verdict ────────────────
// Built per-call from the caller's platform list because the key set is
// dynamic and Gemini's responseSchema doesn't support `additionalProperties`.
// Each platform id becomes an explicit required property so the model can't
// silently skip platforms or invent new ids.
export function buildPlatformFitSchema(platformIds) {
  const properties = {};
  for (const id of platformIds) {
    properties[id] = {
      type: 'object',
      required: ['fit'],
      properties: {
        fit:    { type: 'string', enum: ['good', 'unfit'] },
        reason: { type: 'string', description: 'Required for unfit; short sentence. May be empty for good.' },
      },
    };
  }
  return {
    type: 'object',
    required: platformIds.slice(),
    properties,
  };
}

// ── Marketplace hub scan (Marketplace Status Module) ───────────────────────
// NOT listing-specific. Fed the seller's aggregate hub page(s) for ONE platform
// (dashboard / notifications / activity center) and asked to surface anything
// actionable + useful FYI across ALL their listings at once. No per-listing
// state — the platform-level read status (ok / needs-login / error) is derived
// from transport, not the model; the model only produces the attention list.
export const MARKETPLACE_HUB_SCAN_SCHEMA = {
  type: 'object',
  required: ['attention'],
  properties: {
    summary: { type: 'string', description: 'One short line summarizing the hub state, e.g. "2 offers, 1 buyer message, no policy issues"' },
    attention: {
      type: 'array',
      items: {
        type: 'object',
        required: ['urgency', 'category', 'headline', 'evidence'],
        properties: {
          urgency:  { type: 'string', enum: ['high', 'low'] },
          category: { type: 'string', enum: ['engagement', 'offer', 'question', 'policy', 'payout', 'pricing', 'time-sensitive', 'other'] },
          headline: { type: 'string' },
          evidence: { type: 'string' },
          sourceUrl: { type: 'string', description: 'The exact url of the HUB PAGE this item was found on, copied verbatim from that page\'s header above — lets the seller jump straight to it.' },
        },
      },
    },
  },
};

// ── Job bucketing: scored jobs → results taxonomy metadata ──────────────────
// Runs after job-scoring. Likelihood bands are fixed to the scorer's rubric;
// the model creates only the remaining taxonomy metadata:
//   1. salaryRanges    — salary bands fitted to the distribution; renderer
//      places jobs by parsed salary. Always include an "Unspecified" range.
//   2. roleByIndex     — exactly one role-family label per input job. The
//      server groups matching labels into the persisted `{ name, jobIndices }`
//      shape. This turns complete index coverage from an advisory prompt rule
//      into a provider-visible structural constraint.
//
// The count is input-specific, so this must be built at the call site rather
// than exported as one static schema. Gemini's adapter preserves min/maxItems;
// Claude receives the same standard JSON Schema as its forced tool input.
export function buildJobBucketingSchema(jobCount = 0) {
  const count = Math.max(0, Math.floor(Number(jobCount) || 0));
  return {
    type: 'object',
    required: ['salaryRanges', 'roleByIndex'],
    properties: {
      salaryRanges: {
        type: 'array',
        // One Unspecified-only range is legitimate when every input lacks
        // parseable compensation; the semantic sanitizer still supplies real
        // ranges when a model misses them despite observed pay.
        minItems: 1,
        maxItems: 5,
        items: {
          type: 'object',
          required: ['label', 'minSalary', 'maxSalary'],
          properties: {
            label:     { type: 'string', minLength: 1, description: 'Annual display label, e.g. "$120k+/yr", "$80k–$120k/yr", "Unspecified". The server canonicalizes it from the numeric bounds.' },
            minSalary: { type: 'integer', description: 'Lower bound USD/yr; 0 for the Unspecified range' },
            maxSalary: { type: 'integer', description: 'Upper bound USD/yr; 0 if open-ended ("$200k+") or Unspecified' },
          },
        },
      },
      roleByIndex: {
        type: 'array',
        minItems: count,
        maxItems: count,
        items: {
          type: 'string',
          minLength: 1,
          description: 'A concise non-empty role-family label for the job at this exact input index. Reuse exactly the same label for jobs in the same family.',
        },
      },
    },
  };
}

// ── Resume parse: file → structured profile ────────────────────────────────
export const RESUME_PARSE_SCHEMA = {
  type: 'object',
  required: ['titles', 'skills', 'experience_years', 'soft_skills', 'industries', 'locations', 'education', 'summary'],
  properties: {
    titles:           { type: 'array', items: { type: 'string' }, description: 'Exact job titles held, most recent first' },
    skills:           { type: 'array', items: { type: 'string' } },
    experience_years: { type: 'number', description: 'Total years of professional experience' },
    soft_skills:      { type: 'array', items: { type: 'string' } },
    industries:       { type: 'array', items: { type: 'string' } },
    locations:        { type: 'array', items: { type: 'string' } },
    education:        { type: 'array', items: { type: 'string' } },
    summary:          { type: 'string', description: '2-sentence professional summary' },
  },
};

// ── Career-file extract: one dropped file → faithful plain text ────────────
// First pass of parse-career-data. The user can drop ANY number/type of files
// (résumé, portfolio, project write-ups, brag doc); each is transcribed to
// faithful text, then all are merged into one "career data" blob that drives
// query generation, scoring, and the application generator.
export const CAREER_FILE_EXTRACT_SCHEMA = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string', description: "A faithful, complete plain-text representation of this document's career-relevant content: roles, employers, dates, bullet points, projects, skills, education, certifications, and contact info. Preserve every fact, number, and the original structure using simple line breaks and \"- \" bullets. Do not summarize away detail and do not invent anything." },
  },
};

// ── Job-query generation: profile → search query bundles ──────────────────
// No target role: the model explores — titleQueries/suggestedRoleQueries/
// skillsOnlyQueries are populated and targetRoleQueries is empty.
// A target-role run does not use this schema: its only query is constructed
// directly from the user-supplied role. The schema keeps all four arrays
// required for the exploratory, no-target-role flow.
// A target-role run uses this narrower response shape: it may still need AI to
// correct/infer location, but it does not ask the model to generate any query.
export const JOB_LOCATION_RESOLUTION_SCHEMA = {
  type: 'object',
  required: ['canonicalLocation'],
  properties: {
    canonicalLocation: {
      type: 'object',
      required: ['city', 'stateCode', 'region', 'country', 'isRemote', 'display'],
      properties: {
        city:      { type: 'string' },
        stateCode: { type: 'string' },
        region:    { type: 'string' },
        country:   { type: 'string' },
        isRemote:  { type: 'boolean' },
        display:   { type: 'string' },
      },
    },
  },
};

export const JOB_QUERY_GENERATION_SCHEMA = {
  type: 'object',
  required: ['titleQueries', 'suggestedRoleQueries', 'skillsOnlyQueries', 'targetRoleQueries', 'canonicalLocation'],
  properties: {
    titleQueries:         { type: 'array', items: { type: 'string' } },
    suggestedRoleQueries: { type: 'array', items: { type: 'string' } },
    skillsOnlyQueries:    { type: 'array', items: { type: 'string' } },
    targetRoleQueries:    { type: 'array', items: { type: 'string' } },
    // The user's free-form preferred location, parsed + typo-corrected into a
    // STRUCTURED object. Job boards reject free-form prose in their location
    // field (USAJobs LocationName, Dice location, Indeed `l=`, ZipRecruiter
    // `location=`, Glassdoor `locKeyword=`, LinkedIn `location=`), so the model
    // MUST split the input into discrete fields plus one clean `display` string
    // that is safe to send verbatim as a location filter. Role/keyword queries
    // stay free-form (boards don't enforce a structure there) — only LOCATION is
    // structured. All keys are required; an absent/unresolvable location returns
    // the all-empty object (display: "").
    canonicalLocation: {
      type: 'object',
      description: 'Preferred search location parsed into a structured, board-ready form (NOT prose). Typos corrected, abbreviations expanded.',
      required: ['city', 'stateCode', 'region', 'country', 'isRemote', 'display'],
      properties: {
        city:      { type: 'string', description: 'Corrected city name ONLY (no state), e.g. "Denver" from "denvr". Empty if remote-only, a bare state/region, or unresolvable.' },
        stateCode: { type: 'string', description: 'State/province subdivision for the city: the 2-letter code for a US state/territory (e.g. "CO"); the full province/region NAME for non-US (e.g. "Ontario"). Empty if none/unknown.' },
        region:    { type: 'string', description: 'Broader area when no single city applies, e.g. "Midwest", "Bay Area", "Colorado". Empty when a city resolves.' },
        country:   { type: 'string', description: 'Country name, e.g. "United States" or "Canada". Always set it when any place resolves (it decides US vs non-US formatting). Empty only if truly unknown.' },
        isRemote:  { type: 'boolean', description: 'true if the user asked for remote / work-from-anywhere.' },
        display:   { type: 'string', description: 'The full board-ready place string passed VERBATIM to a job board filter: "City, ST" for a US city (e.g. "Denver, CO"); "City, Province, Country" for non-US (e.g. "Whitby, Ontario, Canada"); else the region/country; "" for remote-only (do NOT put "Remote"). Strictly a place, never a sentence.' },
      },
    },
  },
};

// ── Application skill opportunities: honest adjacent-skill analysis ────────
// Runs before application generation. This is deliberately NOT résumé content:
// `verify` items are small, evidence-adjacent inferences that need the
// candidate's confirmation, while `learn` items are worthwhile gaps that must
// stay out of the résumé. The caller supplies existing histogram role/skill ids
// so semantically equivalent names can be consolidated across applications.
// `resumeCategory` is what lets a verified skill land in the right Skills
// group deterministically, with no extra model call.
export const APPLICATION_SKILL_OPPORTUNITY_SCHEMA = {
  type: 'object',
  required: ['role', 'items'],
  properties: {
    role: {
      type: 'object',
      required: ['canonicalName', 'matchedRoleId', 'sourceTitle'],
      properties: {
        canonicalName: { type: 'string', description: 'A concise canonical role/category name for this job. Deduplicate title variants into the same semantic role (for example, "Backend Engineer" rather than separate names for each seniority/company variation).' },
        matchedRoleId: { type: 'string', description: 'Reuse an existing role id supplied by the caller ONLY when it is a true semantic equivalent of canonicalName; otherwise return an empty string.' },
        sourceTitle: { type: 'string', description: 'The job title as supplied for this particular application.' },
      },
    },
    items: {
      type: 'array',
      description: 'Only opportunities where possessing the skill would significantly increase this candidate\'s odds for THIS job. Return [] when none qualify. Never use this list to claim, invent, or exaggerate experience or proficiency.',
      items: {
        type: 'object',
        required: ['id', 'canonicalSkillName', 'matchedSkillId', 'kind', 'jobImportance', 'jobEvidence', 'candidateEvidence', 'adjacencyReason', 'suggestedResumeText', 'resumeCategory', 'verificationQuestion', 'learningAction'],
        properties: {
          id: { type: 'string', description: 'Stable item id within this response, e.g. "skill-1".' },
          canonicalSkillName: { type: 'string', description: 'One normalized, canonical skill name. Deduplicate aliases/spelling variants; do not return separate entries for equivalent skills.' },
          matchedSkillId: { type: 'string', description: 'Reuse an existing skill id supplied by the caller ONLY when it is a true semantic equivalent of canonicalSkillName; otherwise return an empty string.' },
          kind: { type: 'string', enum: ['verify', 'learn'], description: 'verify = a small, plausible inference from concrete candidate evidence but still unverified; learn = too distant to claim today, yet reasonably actionable and high-value. Neither kind is proof of proficiency.' },
          jobImportance: { type: 'string', enum: ['critical', 'high'], description: 'Importance to THIS job only. Include no medium/low-value skills; a verified possession must significantly improve the candidate\'s odds.' },
          jobEvidence: { type: 'string', description: 'Specific requirement, responsibility, or repeated signal from this job description that makes this skill materially important.' },
          candidateEvidence: { type: 'string', description: 'Specific evidence from the candidate data. For learn, state the nearest demonstrated foundation and make clear it does not establish the missing skill. Never invent experience.' },
          adjacencyReason: { type: 'string', description: 'Why this is a small inference (verify) or a reasonably learnable next step (learn), including the boundary that prevents overstating the candidate.' },
          suggestedResumeText: { type: 'string', description: 'For verify only: the concise skill label/phrase that may be added to the Skills section ONLY after the candidate confirms it; never write an experience bullet or imply unsupported proficiency, years, projects, or outcomes. For learn, return an empty string because learn items must never go on the résumé.' },
          resumeCategory: { type: 'string', description: 'For verify only: the Skills-section heading this skill would be filed under on the candidate\'s own résumé, phrased in the candidate\'s professional domain vocabulary — the same kind of label a human would write for a skills group (e.g. "Safety & Response", "Certifications", "Infrastructure", "Clinical Skills"). 1-3 words, Title Case, a noun phrase naming the skill\'s domain. Never describe provenance, verification, fit, or the tool itself — never "Verified", "Role-fit", "Additional Skills", "Other", "Suggested". Prefer the broadest natural grouping the candidate\'s résumé would plausibly already contain, since an exact match to an existing heading lets the skill merge in rather than start a new row. For learn, return an empty string.' },
          verificationQuestion: { type: 'string', description: 'For verify only: one precise yes/no or short-answer question that can confirm the skill before any résumé use. For learn, return an empty string.' },
          learningAction: { type: 'string', description: 'A concrete, bounded first learning action tied to this job-relevant skill. For learn, this is the primary recommendation. For verify, this is the fallback shown only if the candidate says the plausible skill is not actually theirs.' },
        },
      },
    },
  },
};

// ── Application cover letter: needs, argument plan, then prose ─────────────
// The needs pass deliberately has no candidate input; the plan selects
// résumé-grounded evidence; prose receives only the plan. Code owns the
// letterhead/envelope so the model cannot drift from the final résumé identity.
export const LETTER_NEEDS_SCHEMA = {
  type: 'object',
  required: ['needs'],
  properties: {
    needs: {
      type: 'array',
      maxItems: 6,
      description: 'Three to six requirements, ranked most decisive first; empty only when the posting and research have no usable requirements.',
      items: {
        type: 'object',
        required: ['need', 'quote', 'source', 'decisiveness', 'kind', 'emphasisReason'],
        properties: {
          need: { type: 'string', description: 'One clause describing what the employer needs someone to be able to do.' },
          quote: { type: 'string', description: 'Verbatim supporting span from the posting or research.' },
          source: { type: 'string', enum: ['posting', 'research'] },
          decisiveness: {
            type: 'integer', minimum: 1, maximum: 100,
            description: 'How much failing this requirement disqualifies a candidate, from 1 to 100.',
          },
          kind: { type: 'string', enum: ['capability', 'domain', 'scale', 'logistics', 'credential', 'disposition'] },
          emphasisReason: { type: 'string', description: 'Concise explanation of why this need is prominent or decisive, using structural signals such as repetition, opening placement, unusual specificity, explicit priority, scope ownership, or a hard screen. Treat signals as evidence, not automatic ranking rules.' },
        },
      },
    },
  },
};

export const LETTER_PLAN_SCHEMA = {
  type: 'object',
  required: ['roleThesis', 'mappings', 'companyHook', 'logistics', 'droppedNeeds'],
  properties: {
    roleThesis: { type: 'string', description: 'One-sentence, single-claim angle at the intersection of an emphasized employer need and a distinctive supported candidate capability. It organizes the entire letter and is never a generic expression of interest.' },
    mappings: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      description: 'The minimum one or two need-to-résumé mappings required to prove the same roleThesis. Use one by default. Include a second only when it adds a distinct foundation, corroboration, deepening, or extension the primary proof cannot supply; never use it merely to cover another requirement.',
      items: {
        type: 'object',
        required: ['needIndex', 'need', 'evidence', 'evidenceRole', 'achievementIds', 'resumeStatus', 'inference', 'narrativeRole', 'relationToPrevious'],
        properties: {
          needIndex: { type: 'integer', minimum: 0, description: 'Zero-based index into the ranked needs array.' },
          need: { type: 'string', description: 'Restatement of the employer need in one clause.' },
          evidence: { type: 'string', description: 'Near-quote of specific final-résumé text.' },
          evidenceRole: { type: 'string', description: 'Role block containing the evidence.' },
          achievementIds: { type: 'array', items: { type: 'string' }, description: 'Ledger receipt ids carried by the cited résumé evidence.' },
          resumeStatus: { type: 'string', enum: ['stated', 'implied', 'absent'], description: 'Whether the résumé already says the mapped conclusion.' },
          inference: { type: 'string', description: 'The so-what: name the mechanism that makes this evidence relevant and explicitly explain how it supports the shared roleThesis; do not merely assert portability.' },
          narrativeRole: { type: 'string', enum: ['primary', 'foundation', 'corroborates', 'deepens', 'extends', 'qualifies'], description: 'Its argumentative role. The first and usually only mapping is primary; a second must provide a foundation, corroboration, deepening, extension, or honest qualification, never another primary argument.' },
          relationToPrevious: { type: 'string', description: 'State why this evidence follows the previous proof in the reader’s argument. For the primary mapping, state how it establishes the thesis; for a second, name the specific foundation, corroboration, deepening, extension, or qualification it supplies that the primary evidence cannot.' },
        },
      },
    },
    companyHook: {
      type: 'object',
      required: ['detail', 'source', 'whyItMattersToCandidate'],
      properties: {
        detail: { type: 'string', description: 'Specific research detail; empty when research is unavailable.' },
        source: { type: 'string', description: 'Research source or empty string when unavailable.' },
        whyItMattersToCandidate: { type: 'string', description: 'Why the detail matters given the candidate trajectory; empty when no hook applies.' },
      },
    },
    logistics: { type: 'string', description: 'The only field allowed to use career-data facts: explicit logistics or stated motivation. Empty when not applicable.' },
    droppedNeeds: {
      type: 'array',
      items: {
        type: 'object',
        required: ['needIndex', 'reason'],
        properties: {
          needIndex: { type: 'integer', minimum: 0, description: 'Zero-based index into the ranked needs array.' },
          reason: { type: 'string', description: 'Why this need is deliberately not argued.' },
        },
      },
    },
  },
};

// Independent final-pass audit for cover-letter prose. The writer receives
// only the argument plan, so every concrete factual claim must be traceable to
// it, and every evidence shift must still serve its one controlling argument.
// Exact quoted spans make both factual and cohesion defects useful to the
// convergent revision call and saved workspace's human-review notice.
export const LETTER_GROUNDING_AUDIT_SCHEMA = {
  type: 'object',
  required: ['violations', 'cohesionObservations'],
  properties: {
    violations: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        required: ['claim', 'reason'],
        properties: {
          claim: { type: 'string', description: 'Exact verbatim span from the cover-letter paragraphs containing the unsupported factual claim.' },
          reason: { type: 'string', description: 'Concise explanation of what the allowed factual source does not support.' },
        },
      },
    },
    cohesionObservations: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        required: ['kind', 'claim', 'reason', 'repair'],
        properties: {
          kind: { type: 'string', enum: ['unclear-antecedent', 'unexplained-shift', 'chronological-backtracking', 'inventory-paragraph', 'overloaded-sentence', 'faulty-parallelism', 'repeated-metaphor', 'detached-synthesis', 'volunteered-gap', 'delayed-relevance', 'second-thesis', 'unnecessary-evidence'], description: 'The cohesion, grammar, or persuasive-prose defect found in the letter.' },
          claim: { type: 'string', description: 'Exact verbatim span from the cover-letter paragraphs containing the cohesion defect.' },
          reason: { type: 'string', description: 'Why this span weakens clarity, grammatical flow, or the reader’s ability to follow one controlling argument.' },
          repair: { type: 'string', description: 'Concise editorial action: make coordinated syntax parallel, replace an unclear reference, ground a synthesis in the preceding evidence, establish the relationship before details, consolidate, cut, or explicitly tie the span to the thesis.' },
        },
      },
    },
  },
};

export const APPLICATION_COVER_LETTER_SCHEMA = {
  type: 'object',
  required: ['paragraphs'],
  properties: {
    paragraphs: { type: 'array', items: { type: 'string' }, description: 'Body paragraphs only: plain prose derived from the approved argument plan, with no markdown or envelope fields.' },
  },
};

// The direct fallback intentionally avoids a precomputed plan, but it still
// returns this ephemeral contract so the same independent cohesion audit can
// evaluate the writer's claimed through-line. The host never renders it.
export const APPLICATION_DIRECT_COVER_LETTER_SCHEMA = {
  type: 'object',
  required: ['paragraphs', 'argumentContract'],
  properties: {
    paragraphs: { type: 'array', items: { type: 'string' }, description: 'Body paragraphs only: plain prose, with no markdown or envelope fields.' },
    argumentContract: {
      type: 'object',
      required: ['roleThesis', 'primaryEvidence', 'primaryRelationToThesis', 'secondaryNarrativeRole', 'secondaryEvidence', 'secondaryRelationToPrimary'],
      properties: {
        roleThesis: { type: 'string', description: 'One controlling claim for the entire letter.' },
        primaryEvidence: { type: 'string', description: 'Near-quote of the one primary résumé anchor supporting roleThesis.' },
        primaryRelationToThesis: { type: 'string', description: 'How the primary evidence establishes roleThesis.' },
        secondaryNarrativeRole: { type: 'string', enum: ['none', 'foundation', 'corroborates', 'deepens', 'extends', 'qualifies'], description: 'none when no secondary evidence is necessary; otherwise its one supporting narrative role.' },
        secondaryEvidence: { type: 'string', description: 'Near-quote of the optional secondary résumé anchor; empty when secondaryNarrativeRole is none.' },
        secondaryRelationToPrimary: { type: 'string', description: 'Why the optional secondary evidence follows the primary proof; empty when secondaryNarrativeRole is none.' },
      },
    },
  },
};

// ── Achievement ledger: derive accomplishments by joining career-data facts ──
// career-achievement-mining, run once per jobhub (job-independent, see
// docs/resume-achievement-mining-design.md §3.2). The model's job is to FIND
// the join (e.g. a 2019 balance sheet + a 2023 balance sheet + a tenure span)
// and describe it in prose — it never authors the derived number. `claim` is
// deliberately figure-less; code computes `computed.display` from `metric`
// (src/utils/achievementLedger.js) and the résumé call weaves the two
// together. This is what makes an arithmetic slip structurally unable to
// reach the output: the model that reasons about the join is never the model
// that emits the digits.
export const ACHIEVEMENT_LEDGER_SCHEMA = {
  type: 'object',
  required: ['achievements', 'gaps'],
  properties: {
    achievements: {
      type: 'array',
      description: 'At most ~40, ranked by strength. Weak joins are dropped here, not filtered — the post-refute ~30 cap is applied by code after the refute pass, not by this call.',
      items: {
        type: 'object',
        required: ['id', 'claim', 'kind', 'roleAnchor', 'strength', 'attribution', 'confidence', 'caveats', 'derivation', 'metric', 'evidence'],
        properties: {
          id:         { type: 'string', description: 'Stable id within this ledger, e.g. "a1", "a2" — referenced later by the refute pass and by résumé receipts.' },
          claim:      { type: 'string', description: 'Résumé-voice prose stating the accomplishment. MUST NOT contain the derived figure (no percentages, no dollar amounts, no computed numbers) — code authors the number from `metric` and the résumé call inserts it. Writing the figure here would let an arithmetic slip reach the final document.' },
          kind:       { type: 'string', enum: ['delta', 'scale', 'scope', 'first', 'turnaround', 'efficiency', 'recognition', 'breadth'], description: 'Shape of the accomplishment: delta = before/after change, scale = size/volume, scope = breadth of responsibility, first = novel/pioneering, turnaround = recovered a bad situation, efficiency = did more with less, recognition = external validation, breadth = range of skills/domains.' },
          roleAnchor: { type: 'string', description: 'The employer / role this achievement belongs under, matching how it appears in the career data.' },
          strength:   { type: 'integer', description: '1-100. Used to rank achievements and, after the refute pass, to truncate the ledger to the top ~30.' },
          attribution: {
            type: 'string',
            enum: ['sole', 'led', 'contributed', 'context'],
            description: 'The load-bearing honesty field. The dominant risk in achievement mining is not inventing a number, it is stealing credit — "revenue grew 40% while I was there" is NOT "I grew revenue 40%". sole = the candidate alone drove it; led = the candidate directed a team/effort that drove it; contributed = the candidate was one of several drivers; context = the change happened during the candidate\'s tenure but their causal role is uncertain — declare this honestly rather than inflating to sole/led. When uncertain, prefer contributed or context and explain why in caveats.',
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Confidence in the join itself (evidence quality, date alignment) — independent of attribution.' },
          caveats:    { type: 'string', description: 'Confounders that could explain the change other than the candidate\'s work (e.g. a divestiture, a market tailwind, a headcount change). Empty string when none — do not omit the field.' },
          derivation: { type: 'string', description: 'Human-readable account of the join, e.g. "debt $4.2M (2019 balance sheet) -> $1.1M (2023 balance sheet); CFO tenure Mar 2019-present". Kept separate from `claim` so it can be audited and shown as a receipt without being résumé prose.' },
          metric: {
            type: 'object',
            required: ['isNumeric', 'baselineValue', 'baselineLabel', 'endpointValue', 'endpointLabel', 'unit', 'direction'],
            description: 'Raw endpoints only — never a computed delta or percentage. Code performs all arithmetic from these fields.',
            properties: {
              isNumeric:     { type: 'boolean', description: 'False when this achievement has no numeric endpoints to join (e.g. a qualitative "first" or "scope" claim). When false, baselineValue/endpointValue are ignored by code and must be set to 0.' },
              baselineValue: { type: 'number', description: 'The "before" numeric value. 0 when isNumeric is false.' },
              baselineLabel: { type: 'string', description: 'Human label for the baseline, e.g. "2019 balance sheet".' },
              endpointValue: { type: 'number', description: 'The "after" numeric value. 0 when isNumeric is false.' },
              endpointLabel: { type: 'string', description: 'Human label for the endpoint, e.g. "2023 balance sheet".' },
              unit:          { type: 'string', enum: ['USD', '%', 'ms', 'people', ''], description: 'Unit of baselineValue/endpointValue. Empty string when isNumeric is false or the unit does not fit these categories.' },
              direction:     { type: 'string', enum: ['increase', 'decrease', 'flat'], description: 'Whether the change from baseline to endpoint is an increase, decrease, or flat — must agree with the sign of endpointValue minus baselineValue; code demotes confidence when it does not.' },
            },
          },
          evidence: {
            type: 'array',
            description: 'One or more source spans supporting this achievement. Must be verbatim so code can substring-match them against the career data.',
            items: {
              type: 'object',
              required: ['file', 'quote'],
              properties: {
                file:  { type: 'string', description: 'MUST name one of the "===== FILE: <name> =====" section headers the quote was taken from, exactly as it appears in the career data.' },
                quote: { type: 'string', description: 'A VERBATIM span copied from that file\'s section of the career data — not a paraphrase. Enables a free substring check; a quote that cannot be found is demoted, never deleted.' },
              },
            },
          },
        },
      },
    },
    gaps: {
      type: 'array',
      description: 'Non-blocking suggestions/tips only — places the miner suspects an accomplishment exists but could not find a real join for. Never gates mining or generation.',
      items: {
        type: 'object',
        required: ['roleAnchor', 'note'],
        properties: {
          roleAnchor: { type: 'string', description: 'The employer / role the gap relates to.' },
          note:       { type: 'string', description: 'What might be missing and what evidence would close the gap, e.g. "no headcount figures found for the 2021 reorg mentioned in the brag doc".' },
        },
      },
    },
  },
};

// ── Achievement refute: independent adversarial pass over the ledger ───────
// career-achievement-refute, run by a DIFFERENT model than the miner
// (independence is the point — see design doc §3.5). Given the checked
// ledger, attacks each item: is the join real, is attribution overstated, is
// there a confounder that explains the delta better than the candidate's own
// work? This is the one failure class neither deterministic code nor a light
// human wording glance can catch.
export const ACHIEVEMENT_REFUTE_SCHEMA = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      description: 'One verdict per achievement id in the ledger passed in.',
      items: {
        type: 'object',
        required: ['id', 'verdict', 'reason', 'suggestedAttribution', 'suggestedCaveat'],
        properties: {
          id:      { type: 'string', description: 'Must match an achievement id from the ledger passed in.' },
          verdict: { type: 'string', enum: ['stands', 'weaken', 'drop'], description: 'stands = the join and attribution hold up; weaken = the claim survives but attribution/caveat should change (apply suggestedAttribution/suggestedCaveat); drop = the join is not real or the claim is not defensible and the item is removed entirely.' },
          reason:  { type: 'string', description: 'Why this verdict — the specific confounder, overstatement, or weak join identified. Empty prose is not useful here; be concrete.' },
          suggestedAttribution: {
            type: 'string',
            enum: ['sole', 'led', 'contributed', 'context', 'unchanged'],
            description: 'What attribution the item should carry after this verdict. "unchanged" when the original attribution is correct as-is (used for stands, and for weaken verdicts that only add a caveat without changing attribution).',
          },
          suggestedCaveat: { type: 'string', description: 'A confounder or qualifier to add/replace on the item\'s caveats field. Empty string when none is needed.' },
        },
      },
    },
  },
};

// ── Job scoring: per-job match + categorization ────────────────────────────
// Wrapped in an object envelope because Claude's tool input_schema requires
// type: 'object' at the top level. Consumer reads parsed.scores.
export const JOB_SCORING_SCHEMA = {
  type: 'object',
  required: ['scores'],
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'matchScore', 'reasoning', 'careerDirection'],
        properties: {
          index:           { type: 'integer', description: 'Position in input batch (0-based)' },
          matchScore:      { type: 'integer', description: '0-100 fit score' },
          reasoning:       { type: 'string', description: 'Complete, specific justification of the fit — as long as it needs to be (usually 2-4 sentences), citing concrete signals from both the JD and the candidate. No filler.' },
          careerDirection: { type: 'string', description: 'Free-form 1-3 word job-family label that fits THIS job and candidate\'s field (e.g. "Brand Marketing", "Growth", "Backend Engineering", "Data Science"). Reuse the same label across similar jobs. Not a fixed list — the bucketer consolidates these into the final categories.' },
        },
      },
    },
  },
};
