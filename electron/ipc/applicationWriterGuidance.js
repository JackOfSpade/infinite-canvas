// Writer GUIDANCE that is still printed: the source-verb fidelity rule.
//
// Since the write-then-verify v2 protocol (applicationWriteVerify.js) replaced the
// staged writer prompts (commit 37e3cde), the LIVE writer brief is
// WRITE_VERIFY_BRIEF there. The cover-letter and résumé guidance blocks and the
// unsupported-needs context this module used to supply were deleted with nothing
// left to print them; only RESUME_SUPPORT_VERB_RULE remains, printed by the paste
// repair brief in localAiApplication.js. Truth rules live with their checks; this
// module supplies positive writing guidance only.
//
// Everything here is generic. Nothing names a field of work, a tool, an employer, a
// phrase or a number from any candidate or posting.

// Source-verb fidelity. The class is closed and generic: it names the kinds of
// work a quote can describe that are not authorship, never a verb from a candidate.
export const RESUME_SUPPORT_VERB_RULE = 'A bullet keeps the candidate’s part in the cited work exactly as the quote words it: where the quote '
  + 'describes maintenance, support, monitoring, administration, operation or participation, state that support role with a matching verb '
  + 'and never present it as work the candidate performed, built or owned.';
