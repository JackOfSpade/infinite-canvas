# Paste-back application workflow

New application bundles use a local AI chat through a copy and paste handoff.
Infinite Canvas supplies a self-contained prompt for each stage. Copy it into
the same chat when practical, then paste the AI's complete JSON response back
into the application handoff dialog. The app owns document markup, PDF
rendering, source validation, and final files.

The normal sequence is:

1. Evidence plan: source quotes, priorities, and stable evidence IDs.
2. Résumé: structured roles and bullets bound to accepted evidence IDs.
3. Cover letter: structured paragraphs and argument bound to those IDs.
4. Review and edit: the AI reviews both documents, makes every needed edit in
   that same JSON response, then the app presents another review prompt.

There is no fixed revision cap. A review cycle continues until the AI returns
its complete passing quality review and Infinite Canvas accepts all structural,
grounding, rendering, and measured layout checks. If a measured PDF fit check
requests a later revision, the next prompt includes the current structured
documents and the app repeats review after the edit.

A review cycle has one other ending. The app's own state — the career corpus
and job listing frozen when the job was queued, the evidence plan its first
stage accepted, the job's trusted identity and role list — is never supplied by
a response and never changes after the job is created. If a completion check
finds a defect there, no response can repair it, so the app does not ask for
one: it records the job as failed, states what it observed and that no response
repairs it, and names the one action that resolves it — generating the
application again from the job card. The job hands out no further prompt, and
its workspace keeps a `job-integrity-fault` event describing what was observed.

Every response must be one JSON object containing the prompt's handoff code,
job ID, stage, and base hashes. The app rejects stale, malformed, mismatched,
or unsupported responses without applying them. Closing the dialog only hides
it: the current prompt and pasted draft remain in the private job workspace and
can be reopened after restarting the app.

The private workspace appends one event for every accepted response to
`Generation Log.jsonl`. The final application bundle retains that full
append-only generation log alongside the app-authored `Generation Audit.json`.

Older application jobs created for a filesystem-capable coding agent remain
resumable. They retain their `LOCAL_AI_PROMPT.md` and `result.json` workflow;
the paste-back dialog is only used by newly generated paste-back jobs.
