// Saved boards must offer a refresh after a salary methodology correction,
// even when their source jobs and career snapshot are otherwise unchanged.
// 3: desired salary is bounded by the employer's posted band (2026-11-05).
// 4: verdict compares against typical researched pay (median source midpoint,
//    outliers dropped), research asks for typical bands, a card/market country
//    conflict withholds the verdict, and the desired-salary ceiling reaches the
//    posted midpoint (2026-11-08).
export const JOB_COMPENSATION_METHOD_VERSION = 4;

export function jobBoardSalaryNeedsRefresh(boardData, careerSnapshotId) {
  return String(careerSnapshotId || '') !== String(boardData?.salaryCareerSnapshotId || '')
    || (boardData?.resultCount !== 0 && boardData?.salaryMethodVersion !== JOB_COMPENSATION_METHOD_VERSION);
}
