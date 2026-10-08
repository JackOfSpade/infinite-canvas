# Real-data career-profile candidate

This artifact is for the career-snapshot acceptance test, not application
generation. It reads the user-owned source file at
`/Users/jack/Desktop/Job Search/Work Experience.md` without changing it,
builds the production corpus with the verbatim-transcription receipt, and runs
the production JSON-schema plus deterministic `validateCareerProfile` check.

Run:

```bash
node .test-artifacts/blackbox-run/validate-candidate.mjs
```

For the exact production corpus or compile prompt reconstructed from that
source, use `--corpus` or `--compiler-prompt`, respectively. These remain
runtime artifacts rather than a copied transcript so a final-byte difference
cannot quietly make the candidate look valid against a different corpus.

`candidate-profile.json` contains the complete evidence-linked profile. The
harness emits the input/source fingerprints, snapshot ID, immutable compilation
contract, exact production segment count, compiler-prompt digest, coverage
count, and validator result. The source file is deliberately not duplicated:
the harness reads the exact user-owned corpus, including its final-byte
newline state. `validation-report.json` records the successful current run and
`ambiguities.md` records source gaps intentionally left unresolved.

`approved-snapshot.json` is the approved-format artifact. Its corresponding
`final-approval-report.json` records the source/snapshot hashes, production
schema and profile checks, all six empty typed audit outcomes, and successful
writer/reader round trip in an isolated temporary directory. Recheck it with:

```bash
node .test-artifacts/blackbox-run/assemble-approved-snapshot.mjs --verify-file .test-artifacts/blackbox-run/approved-snapshot.json
```

`--verify` (or no argument) verifies the existing approved artifact; it never
creates a replacement snapshot or derives a new `approvedAt`. It also fails if
the report's `snapshotSha256` differs from the actual approved-snapshot bytes.
