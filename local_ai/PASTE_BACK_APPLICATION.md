# Paste-back application workflow

New application bundles use a local AI chat through a copy and paste handoff.
Infinite Canvas supplies a self-contained prompt for each stage. Copy it into
the same chat when practical, then paste the AI's complete JSON response back
into the application handoff dialog. The app owns document markup, PDF
rendering, source validation, and final files.

The normal sequence is:

1. Evidence plan: source quotes, priorities, and stable evidence IDs. Large
   listings are acquired as cursor-bound pages: each reply is bounded, quotes
   only its assigned frozen listing slice, and uses `complete:false` until the
   final slice. The app durably merges unique page IDs, so reopening after a
   restart continues at the next slice rather than discarding prior evidence.
2. Résumé: structured roles and bullets bound to accepted evidence IDs.
3. Cover letter: structured paragraphs and argument bound to those IDs.
4. Review and edit: the AI reviews both documents, makes every needed edit in
   that same JSON response, then the app presents another review prompt.

For newly queued snapshot-authority jobs, an internal passing review is not
completion. The host first freezes the exact accepted document hashes and
starts five independent blind checks (fact fidelity, résumé quality, letter
editorial quality, tailoring/ATS, and cross-document coherence). Each handoff
contains one UTF-8-bounded, host-projected scope only; it never includes the
authoring rules, a prior reviewer’s findings, or another track’s conclusion.
Finding pages continue without a total-page limit and are stored as immutable
receipt pages. A full bounded finding page must explicitly continue; it cannot
declare the scope complete. Before the normal repair review opens, Infinite
Canvas presents every host-signed correction page in turn and requires an
exact acknowledgement of each finding ID. A clean, digest-bound receipt for
every scope is required before assembly/import. Findings return through the
ordinary typed review revision; any document change reruns requirement
dispositions and all five blind tracks.

The acknowledgement chat and the repair review are different chats, so the
repair review does not rely on the acknowledgement: it carries a bounded,
clustered, de-duplicated brief of every blind finding that the app rebuilds
from the signed correction stream on each open (never read from a mutable
field). Each cluster names the unit it concerns, the reviewer wording as quoted
data, the fields it concerns that the app copies verbatim from the approved
career snapshot or insists stay (`pinnedFields`, empty for a finding about the
mutable text beside such a field) and the edits a response may legally make. A revision must
change at least one named unit, not merely any word elsewhere; the demand is
limited to units in a document the round may replace and to units not already
rewritten since the brief opened, so it can always be met. Each cluster also
carries `unitRaisedCycles`, how many consecutive review cycles raised its unit
however the reviewers worded it: a unit raised in two or more cycles is
answered by deleting or shortening the flagged sentence, unless a function the
app requires of that paragraph would be lost, and never by reusing the previous
wording. Among the functions the app requires of a cover-letter paragraph are
these: a claim phrase and a sentence relating its proof to the job need in the
first proof-bearing paragraph of the letter, a proof sentence in every
proof-bearing paragraph, an opening that leads with the target work, with the
candidate's role stated wherever a prior employer or named project is first
named, the closing's asset, action and target parts, and paragraphs long enough
to stay within the letter's proportion limits; a later proof-bearing paragraph
owes no claim and no relevance span, so a sentence in it that only echoes the
posting's vocabulary can be cut. `issueTruncated` and `fixTruncated` say that
the quoted reviewer wording was shortened on a sentence or clause boundary (the
sentences that say what must stay unchanged are kept first) while the whole
finding stays recorded. Blind reviewers themselves receive a short host-signed conventions clause listing the forms the
app mandates (for example the target-first opening and the one
claim-and-proof paragraph whose own sentence, in the writer's own natural
wording, says why its proof matters to the target: the first proof-bearing
paragraph of the letter) and the fields it owns. The clause says those forms are never
themselves a defect and never a reason to ask for their removal, and that a
claim inside one is still judged against its cited evidence: an unsupported
claim may be qualified, rephrased or removed, but the form stays. The reviewers
that read the cover letter also receive a second signed clause, the letter
conventions, built from the same rule the app enforces: the first proof-bearing
paragraph of the letter must carry one phrase naming the capability its proof
shows and one sentence relating that proof to the job need, so carrying them is
not a defect. Such a phrase or sentence is still reported when it claims more
than that paragraph's own proof supports, restates the proof without adding
information, or only echoes the posting's vocabulary, and any other defect in it
is reported as in any sentence; a correction rewords, shortens or merges into
the proof sentence the claim phrase, rewords or shortens the relevance sentence
while keeping it a sentence, or part of one, apart from the proof sentence (the
app refuses to merge it into the proof sentence), and never deletes the only
span that performs a required function. The letter-reading reviewers also see,
for each paragraph on their page, the posting span the writer bound the
paragraph to (`jobNeedQuote`, labelled as posting text and not as proof of fit)
and the career quotes it cites: a sentence grounded in a cited career quote is
not an abstraction defect merely for being general, but one that adds nothing to
the cited quotes, or only echoes the `jobNeedQuote` about the candidate, is
reportable. The clause waives nothing: every finding still needs a correction.
A skill group label is not among the fields the app owns, so an overclaiming
label stays reportable (the fix is a neutral label), and a wholly unsupported
entry may be reported for removal; the app keeps any entry it requires.

The drafting and review prompts also carry writer guidance that the independent
reviewers read for after the app's checks pass. A letter paragraph adds what its
résumé bullet cannot, the reason, constraint, decision or outcome its cited
quote states, and never says the bullet again; the number of proof paragraphs
follows the evidence (two suffice when the cited quotes are one-line
achievements); the opening names the target role and the employer from the job
record alone (when the record gives no usable title or employer it names the one
it gives and invents neither) and speaks from the candidate's side; the close
ties one concrete item the letter has already shown to the role (in the
authorship form `the <artifact> I built`, an artifact the letter has already
used for the candidate's own work, in an earlier sentence or a cited quote), and
a closing that invites a conversation is stated directly in the present tense
(an invitation opened with `would` is rejected), says what the item does for
the target work with one verb from the closed list the app reads, and reaches
the employer's side; because an authorship clause names a past action of the
candidate, a closing that uses one is itself a proof-bearing paragraph whose
argumentMapping (a proof span and a `jobNeedQuote` no other paragraph uses) the
review records, so a possessive asset is preferred unless the artifact is the
strongest item the letter showed; when a cited quote states nothing beyond its
bullet the paragraph says the proof plainly and a letter whose evidence is all
of that kind uses fewer, plainer paragraphs; a posting phrase is bound to at
most one paragraph's `jobNeedQuote` (the review is rejected when two
proof-bearing paragraphs bind the same span); and no sentence echoes the posting
as filler. A bullet keeps the candidate's part exactly as its source words it, so
maintenance, support, monitoring, administration, operation or participation
is never written as work the candidate built or owned. When the approved career
evidence does not support a highest- or high-priority requirement, the prompt
lists it in `context.unsupportedPostingNeeds` (derived by the app from the
verified evidence, bounded, and read as fact rather than as an instruction), and
neither document claims, implies or approximates it.

Host-owned identity fields are written by the app, not matched against the
model's copy. A role's title, company, dates and location, a project's name, and
an education or certification record's name, institution, issuer and dates are
copied from the approved career snapshot. When a response restates one of them in
another surface form (letter case, Unicode composition, spacing, a dash or hyphen
variant, or typographic quotes) the app replaces it with the approved text before
it validates, hashes or stores that response, so every later stage and every
document hash reads exactly what a verbatim copy would have carried. Each
replacement is recorded on that round's `paste-accepted` Generation Log event as a
`host-field-canonicalized` entry (unit, field, and the SHA-256 of the text written
and of the text stored, never the text itself) beside the hash of the response as
the model sent it. A value that still differs after that normalization is a
different value and is refused; the entity is never chosen by its name (a project,
education item or certification is the one its cited evidence resolves to, and
evidence that resolves to two is not rewritten), and the refusal states the exact
approved text (`expected exactly: "..."`), so the repair is a copy and not a guess.

There is no fixed revision cap. A review cycle continues until the AI returns
its complete passing quality review and Infinite Canvas accepts all structural,
grounding, rendering, and measured layout checks, or until the app can show it
will not converge (see the human stop below). If a measured PDF fit check
requests a later revision, the next prompt includes the current structured
documents and the app repeats review after the edit.

A review cycle can also end in a human stop. The app remembers each finding
across consecutive blind cycles, matching the same unit and the same defect
however the reviewer rephrases it: the words a finding calls its own, once the
unit's text and the reviewer's boilerplate are set aside. Two different
complaints about one unit are two findings, never one streak. A finding that
comes back in a third consecutive cycle (a fourth, for an unanchored
document-wide theme) ends the job instead of opening another hour-long cycle.
A finding that is about a field the app copies exactly from the approved career
snapshot (the project's own name, for example: "the project name", never a bare
"name" or "title"), or that says an entry the app requires is unneeded as a
whole, ends the job one cycle sooner, after the writer was shown every legal
edit; so does a finding about a unit with no legal edit at all. A finding that an
entry merely repeats or is redundant with another unit ("redundant with the
first bullet") is not that: giving the entry content of its own, or changing the
other unit, answers it, so it gets the ordinary three cycles, as does a finding
about the mutable text beside a pinned field (a project's description, a skill
group's label). The job is recorded as failed with a sentence naming the
finding and the unit as a person would (a project by its name, a bullet by its
role and position, a paragraph by its number, never by an internal id) and, for
a pinned field, the exact snapshot path to edit (such as
`profile.projects[<id>].name`); for a required entry said to be unneeded, that
the app requires it because the host selected it as proof of a top requirement
of the posting, that either that selection or the finding is wrong, and which
snapshot entry (`profile.projects[<id>]`) or posting to change if it does not
belong; press Generate again after editing. The stop never waives a finding or
suggests accepting a flagged claim: every correction packet and receipt stays in
the job's immutable store.

Reviewers that re-word every complaint never build a streak, so a second bound
does not depend on wording; it reads how many findings each consecutive blind
cycle reported, and ends the job in the same typed stop in two cases. From the
fifth consecutive cycle that reported at least one finding (the first draft's
review plus four repair rounds) the job stops when the findings have stopped
falling: the latest cycle reported at least three findings and not fewer than
the lowest of the two cycles just before it (7, 6, 6, 7, 6 stops at the fifth;
7, 2, 5, 6, 3 does not, because 3 is below both 5 and 6). Whatever the trend, the
job stops at the eighth consecutive cycle that reported something. The stop says
the review keeps finding defects, gives the per-cycle counts and says whether the
findings were still trending down or had stopped, lists the units and themes
reported in the most of those cycles, and waives nothing. A clean cycle
completes the job and starts the count over. The stop never competes with the
others: a stop that can name its cause (a pinned field, a recurring defect) is
reported first.

In the ChatGPT bridge a job that ended in this stop shows as needing you with
the reason "independent review stopped this job" instead of the generic broken
state; the bridge's status is a closed vocabulary, so the sentence itself, with
the snapshot path or the units to check, is on the job card.

A review cycle has one other ending. The app's own state — the career corpus
and job listing frozen when the job was queued, the evidence plan its first
stage accepted, the job's trusted identity and role list — is never supplied by
a response and never changes after the job is created. If a completion check
finds a defect there, no response can repair it, so the app does not ask for
one: it records the job as failed, states what it observed and that no response
repairs it, and names the one action that resolves it — generating the
application again from the job card. The job hands out no further prompt, and
its workspace keeps a `job-integrity-fault` event describing what was observed.

An approved career snapshot can contain more roles than one résumé layout can
show. The frozen job retains the whole catalog. Its final evidence-plan page
must explicitly select the job-relevant role IDs that fit the layout and give
a concise reason for every omitted ID; later résumé and review stages use that
frozen selection exactly. Skill catalogs are likewise retained in full: the
final skills block is a traceable layout selection, not deletion from the
career record.

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
