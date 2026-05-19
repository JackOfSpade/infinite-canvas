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

// Marketplace condition tiers — used by the photo-analysis prompt's
// condition dropdown AND the price-synthesis adjustment logic.
const CONDITION_VALUES = [
  'New', 'Like New', 'Used - Excellent', 'Used - Good', 'Used - Fair', 'For Parts',
];

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
    generated_title:   { type: 'string', description: 'Optimized selling title (~80 chars)' },
    generated_description: { type: 'string', description: 'Buyer-friendly description, 3-4 sentences' },
    search_query:      { type: 'string', description: 'Marketplace-search-friendly query — brand + model + 1-2 price-driving specs, no condition keywords' },
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
    justification:     { type: 'string', description: '3-5 sentences with reasoning + adjustments + caveats' },
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
          id:                { type: 'string', enum: ['ebay', 'facebook', 'mercari', 'poshmark', 'depop', 'swappa', 'reverb', 'whatnot'] },
          name:              { type: 'string' },
          reason:            { type: 'string', description: 'Why optimal for this item (1 sentence)' },
          estimated_fee_pct: { type: 'number', description: 'Total fee % including processing' },
          net_payout:        { type: 'number', description: 'Recommended price minus fees' },
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

// ── Page-status classify (single URL) ──────────────────────────────────────
export const PAGE_STATUS_SINGLE_SCHEMA = {
  type: 'object',
  required: ['status', 'message'],
  properties: {
    status: {
      type: 'string',
      enum: ['live', 'sold', 'ended', 'needs-login', 'unknown'],
      description: 'Listing/posting state on this page',
    },
    message: { type: 'string', description: 'One sentence quoting the evidence' },
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
        },
      },
    },
  },
};

// ── Page-status classify (multi-URL) ───────────────────────────────────────
export const PAGE_STATUS_MULTI_SCHEMA = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['pageIndex', 'status', 'message'],
        properties: {
          pageIndex: { type: 'integer' },
          status: {
            type: 'string',
            enum: ['live', 'sold', 'ended', 'needs-login', 'unknown'],
          },
          message: { type: 'string' },
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
              },
            },
          },
        },
      },
    },
  },
};

// ── Job bucketing: scored jobs → categories with salary buckets ────────────
// Runs after job-scoring. Input is the array of scored jobs (each already has
// careerDirection + salary text). The model groups by careerDirection then
// picks salary bucket boundaries that fit the distribution within each
// category — small categories may get 1-2 buckets; large/varied categories
// get 3-4. Indices reference the original input ordering so the renderer can
// map back to spawned job cards.
export const JOB_BUCKETING_SCHEMA = {
  type: 'object',
  required: ['categories'],
  properties: {
    categories: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'buckets'],
        properties: {
          name: { type: 'string', description: 'careerDirection value (Engineering, Leadership, etc.)' },
          buckets: {
            type: 'array',
            items: {
              type: 'object',
              required: ['label', 'jobIndices'],
              properties: {
                label:     { type: 'string',  description: 'Display label, e.g. "$60-80k" or "Unspecified"' },
                minSalary: { type: 'integer', description: 'Lower bound USD/yr; 0 if no minimum or salary unknown' },
                maxSalary: { type: 'integer', description: 'Upper bound USD/yr; 0 if open-ended (e.g. "$200k+")' },
                jobIndices: { type: 'array', items: { type: 'integer' }, description: '0-based indices into the input job array' },
              },
            },
          },
        },
      },
    },
  },
};

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

// ── Job-query generation: profile → search query bundles ──────────────────
// targetRoleQueries is populated only when the caller supplies a targetRole.
// The schema keeps it required so providers can't silently omit it; an
// absent target role results in an empty array.
export const JOB_QUERY_GENERATION_SCHEMA = {
  type: 'object',
  required: ['titleQueries', 'suggestedRoleQueries', 'skillsOnlyQueries', 'targetRoleQueries'],
  properties: {
    titleQueries:         { type: 'array', items: { type: 'string' } },
    suggestedRoleQueries: { type: 'array', items: { type: 'string' } },
    skillsOnlyQueries:    { type: 'array', items: { type: 'string' } },
    targetRoleQueries:    { type: 'array', items: { type: 'string' } },
  },
};

// ── Interview prep: profile + job → question bundle ────────────────────────
export const INTERVIEW_PREP_SCHEMA = {
  type: 'object',
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'question', 'tip'],
        properties: {
          type:     { type: 'string', enum: ['behavioral', 'technical', 'company'] },
          question: { type: 'string' },
          tip:      { type: 'string', description: 'Coaching tip referencing the candidate’s actual background' },
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
        required: ['index', 'matchScore', 'reasoning', 'careerDirection', 'strengthLabel', 'isTargetRoleMatch'],
        properties: {
          index:           { type: 'integer', description: 'Position in input batch (0-based)' },
          matchScore:      { type: 'integer', description: '0-100 fit score' },
          reasoning:       { type: 'string', description: '1-2 sentences explaining the fit' },
          careerDirection: { type: 'string', enum: ['Engineering', 'Leadership', 'Product', 'DevRel', 'Consulting', 'Design', 'Data', 'Operations', 'Teaching', 'Other'] },
          strengthLabel:   { type: 'string', enum: ['strong', 'exploring', 'stretch', 'unexpected'] },
          isTargetRoleMatch: { type: 'boolean', description: 'True if this job fits the caller-supplied target/pivot role. False (and ignored) when no target role was supplied.' },
        },
      },
    },
  },
};
