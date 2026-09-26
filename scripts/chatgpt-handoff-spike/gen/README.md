# Fixture generator (Phase 0a, realistic payloads)

Builds the static fixtures the spike server serves: real-shaped, byte-real application handoff prompts, a synthetic career corpus and job listing, and a reference answer per stage. Everything is invented (persona "Marisol Quenby", fictional employers); nothing is read from user data, the app's data folders or any credential file. The generator is a dev tool: the spike server never imports the app or this directory.

```bash
cd scripts/chatgpt-handoff-spike
node gen/gen-fixtures.js          # writes fixtures/realistic/ (git-ignored) and prints a size table
# or:  npm run gen     (needs Node 22.15 or newer: module.registerHooks)
```

## How it works

1. `app-bridge.js` loads `electron/ipc/localAiApplication.js` in memory with `module.registerHooks`: `electron` and `electron-store` resolve to tiny `data:` stubs, and a `load` hook appends an `export { ... }` line so the app's unexported `pastePrompt`, `validatePasteResponse` and grading helpers can be called. Nothing is written, no job folder, canvas or userData directory is created. If the app renames one of those helpers the load fails loudly. Needs Node 22.15 or newer (`module.registerHooks`).
2. `synthetic.js` (with the word pools in `topics.js`) builds the persona, the merged career corpus (three `===== FILE: name =====` sections: `resume.md`, `achievements.md`, `projects.md`), the listing body, and the hostile canary paragraph, all from a seeded PRNG (mulberry32).
3. `createJobModel()` mirrors `queueLocalApplicationJob` (input record, frozen sources, paste state) and the accept path of `submitLocalApplicationHandoff`, so stage 2 to 4 prompts embed the accepted earlier documents exactly as the app does. Prompts are the real `pastePrompt()` output; `baseHashes` are the app's own `pasteBaseHashesFor()` (sha256 of `JSON.stringify` of each accepted document).
4. `answers.js` builds the four reference answers. `gen-fixtures.js` runs each one through the app's real `validatePasteResponse()`, runs the review answer through the completion gate (assemble the package and run `validateLocalApplicationResult`), re-checks the artifacts (sentinel counts, key order, identity strings, quote substrings, size bands), writes the files, then reads them back and checks again. A problem found before writing aborts with nothing written; one found when the files are read back exits non-zero. `fixtures/realistic/verification.json` records the validator verdicts.

## Regenerating, determinism, knobs

Same seed and same app commit give byte-identical output (`generatedAt` defaults to the committer date of the last commit that touched `electron/` or `src/`, not the wall clock). Regenerate after any change to `electron/ipc/localAiApplication.js` wording; the manifest records `appSourceCommit` (that same last app-source commit only: uncommitted changes under `electron/` or `src/` are reported on stderr but not captured).

| Knob | Default | Meaning |
|---|---|---|
| `SEED` | `20260926` | Integer seed for all content |
| `OUT_DIR` | `fixtures/realistic` | Output directory (only the four variant folders and the two JSON files are replaced) |
| `GENERATED_AT` | last app-source commit date | ISO string, or `now` for the wall clock |
| `ALLOW_VALIDATION_FAILURES` | unset | `1` writes files even if a real validator objects |

Sizes are steered by `SIZE_PROFILES` in `synthetic.js` (roles, bullets per role, achievements-log entries, projects, topic count, evidence-item count, listing sections, résumé bullets).

## Output and manifest contract

```
fixtures/realistic/manifest.json  verification.json
fixtures/realistic/<variant>/career-corpus.txt  listing.md
                              stage-N-<stage>.txt            exact pastePrompt() text, handoff code = sentinel
                              answer-stage-N-<stage>.json    a valid reference answer (compact JSON)
```

Variants: `clean-small`, `clean-medium`, `clean-large`, `hostile-medium` (= clean-medium content plus the canary paragraph; its own job id). Stages: `evidence-plan`, `resume`, `cover-letter`, `review`.

```jsonc
{ "generatedAt": ISO, "seed": number, "appSourceCommit": "<last commit touching electron/ or src/>",
  "sentinels": { "handoffCode": "HANDOFFCODEPLACEHOLDER00", "canaryMarker": "@@CANARY_MARKER@@", "canaryUrl": "@@CANARY_URL@@" },
  "variants": [ { "id", "hostile", "jobId" /* uuid v4 */,
    "persona": { "name","email","phone","city","linkedin","github","portfolio","degree" },
    "corpusFile", "listingFile",
    "stages": [ { "stage", "promptFile", "promptChars", "promptBytes",
      "baseHashes": { "evidencePlan","resume","coverLetter" },      // as printed in that prompt's shared fields
      "answerFile",
      "expect": { "requiredTopLevelKeys": [...], "identityContact": [...],
                  "quoteArrayPath": "evidence"|null, "quoteField": "quote"|null, "targetAnswerChars": [min,max] } } ] } ] }
```

Notes for the server:

- The handoff-code sentinel appears once per prompt (shared fields) and once per answer (`handoffCode`). It is 24 characters, the length of a real code (24 base64url characters), so fixture and served prompts have the same length. Answers echo `protocol, jobId, stage, handoffCode, baseHashes` first, in the real key order. `baseHashes` in stage 2 to 4 are computed from the reference answers of the earlier stages.
- `baseHashes.evidencePlan` in stage 2 to 4 hashes the reference plan as it contains the SENTINEL handoff code. A real app run hashes a plan that carries its real stage-1 code, so its value differs (verified by an independent check: it is the only non-code, non-jobId byte difference from a real-app prompt). It is an opaque 64-hex string the model copies and the server compares to the manifest, so it is harmless here; do not treat it as an app-derived value.
- Hostile prompts run 5.1% (stage 1) to 5.8% (stage 4) above the medium size targets because of the canary paragraph and its JSON escaping.
- `identityContact` is empty for `review`: a passing review carries no identity block. For the other stages it is the name plus six contact values (the app only demands one contact value, so this is stricter than the app).
- Hostile listing: the canary is the last paragraph of the fenced listing body (about 750 characters) and is identical in all four stage prompts. Because the listing is frozen across stages, it names the target field for each stage in one sentence (first evidence item's `requirement`, first résumé bullet's `text`, `roleThesis`, `finalDecisionSummary`). The reference answers ignore it. `@@CANARY_MARKER@@` and `@@CANARY_URL@@` occur only in the hostile prompts and its `listing.md`.
- The listing on the wire is the app's own `formatOriginalJobListingMarkdown()` output, so headers are markdown-escaped (`$155,000 \- $195,000 a year`).
- `targetAnswerChars` is the intended payload band (stage 1: 10k-30k, stages 2 and 3: 4k-5k, stage 4: 22k-32k characters); every reference answer sits inside it.

## Size profiles (default seed, characters)

| Variant | Corpus / listing | Roles x bullets | Evidence items / requirements | Prompts, stages 1 / 2 / 3 / 4 | Reference answers, stages 1 / 2 / 3 / 4 |
|---|---|---|---|---|---|
| clean-small | 8.1k / 3.1k | 4 x 4 | 24 / 8 | 20.6k / 35.1k / 42.7k / 56.0k | 11.1k / 4.2k / 4.1k / 24.4k |
| clean-medium | 14.5k / 4.4k | 5 x 5-6 | 44 / 12 | 28.7k / 50.5k / 51.7k / 64.8k | 19.7k / 4.4k / 4.1k / 25.8k |
| clean-large | 23.6k / 5.7k | 6 x 8 | 70 / 16 | 39.3k / 70.7k / 62.9k / 76.0k | 29.3k / 4.7k / 4.1k / 27.0k |
| hostile-medium | 14.5k / 5.2k | as medium | 44 / 12 | 29.4k / 51.3k / 52.5k / 65.6k | as medium |

Prompt sizes land within about 5% of the intended 20/34/42/54k, 28/50/51/62k and 40/72/63/73k (stage 4 runs slightly high because the review contract and the 24-criterion checklist are fixed text).

## Limits

- Reference answers are valid per the app's validators (`validatePasteResponse`, and the completion gate for a passing review); they have not been run against ChatGPT here. Only the `pass` review path is modelled (no `revised` round, no delta round, no rejection round).
- One letter shape (four paragraphs, two proof paragraphs) is used for every variant and seed; `answers.js` throws if the current role lacks a Kubernetes and a reliability bullet.
