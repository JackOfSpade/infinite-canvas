// Legacy unpinned application jobs may freeze one raw source block. Snapshot-
// pinned jobs page their structured authority instead, so this is deliberately
// not a career-snapshot approval or compilation limit.
export const MAX_FROZEN_SOURCE_CHARS = 240_000;

// Project projection detail rows are evidence-plan quote targets as well as
// frozen source. Keeping this beside the frozen-source ceiling prevents a
// schema-sized description from becoming an uncitable line.
export const MAX_SOURCE_GROUNDING_QUOTE_CHARS = 2_000;
