// Saved boards must offer a refresh after a salary methodology correction,
// even when their source jobs and career snapshot are otherwise unchanged.
// 3: desired salary is bounded by the employer's posted band (2026-11-05).
// 4: verdict compares against typical researched pay (median source midpoint,
//    outliers dropped), research asks for typical bands, a card/market country
//    conflict withholds the verdict, and the desired-salary ceiling reaches the
//    posted midpoint (2026-11-08).
// 5: official posting location is used only when it resolves; grad/early-career
//    titles price as entry level; research reports against targetCurrency with
//    a sourced exchange rate when a source's currency differs (2026-11-08).
// 6: the verdict uses every confirmed comparable source instead of at most five, and the card no longer lists research links (2026-11-09).
// 7: the market range is the typical band (median of source lows to median of source highs) instead of the union, and typical pay is clamped into it; the union is kept as reportedSpan for diagnosis (2026-11-09).
export const JOB_COMPENSATION_METHOD_VERSION = 7;

export function jobBoardSalaryNeedsRefresh(boardData, careerSnapshotId) {
  return String(careerSnapshotId || '') !== String(boardData?.salaryCareerSnapshotId || '')
    || (boardData?.resultCount !== 0 && boardData?.salaryMethodVersion !== JOB_COMPENSATION_METHOD_VERSION);
}
