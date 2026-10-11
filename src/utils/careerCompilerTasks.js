// The career-file compiler is a family of manual-AI stages: attachment
// inventory/transcription (`career-file-*`), the evidence-linked profile
// compile, its six independent audits and every repair round
// (`career-profile-*`), and the legacy `resume-parse`.  Renderer code that
// needs to know "is this handoff part of the career compiler?" must ask here
// rather than keep its own list: two separate hand-maintained lists silently
// fell behind when the attachment inventory and boundary-audit stages were
// added, so a saved marker at those stages stopped being recognised as career
// work and was routed down the job-search recovery path instead.
//
// Matching by family prefix means a new compiler stage is covered the moment
// it is added; scripts/tests/career-recovery-resume.js proves every task id the
// main process knows about is classified one way or the other.
export function isCareerCompilerTask(task) {
  return typeof task === 'string'
    && (task === 'resume-parse'
      || task.startsWith('career-file-')
      || task.startsWith('career-profile-'));
}
