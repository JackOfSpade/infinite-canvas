// Saved boards must offer a refresh after a salary methodology correction,
// even when their source jobs and career snapshot are otherwise unchanged.
export const JOB_COMPENSATION_METHOD_VERSION = 2;

export function jobBoardSalaryNeedsRefresh(boardData, careerSnapshotId) {
  return String(careerSnapshotId || '') !== String(boardData?.salaryCareerSnapshotId || '')
    || (boardData?.resultCount !== 0 && boardData?.salaryMethodVersion !== JOB_COMPENSATION_METHOD_VERSION);
}
