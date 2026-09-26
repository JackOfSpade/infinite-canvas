# ChatGPT MCP handoff spike: RESULTS

**Date:** 2026-09-25 · **Account:** ChatGPT Pro · **Surface:** macOS ChatGPT desktop app, ordinary **Chat** mode (not Work/Codex) · **Server:** this directory, `JOBS=2`, stateless Streamable HTTP with plain-JSON replies, through a Cloudflare quick tunnel, "No auth", secret path. Fake data only.

## Verdict: **GO**

Ordinary ChatGPT Chat can drive the handoff loop through a custom MCP plugin with no copy/paste. Three complete runs each drained the whole two-job queue (8 handoffs, 10–12 `submit_handoff` calls) **in a single assistant reply, about 4 minutes**, applying the designed rejections' corrections without prompting and returning a 14–15 KB résumé intact. The two fresh-chat, first-message trials both passed with zero blocks, which meets the decision rule (≥ 2 of 3).

**Next step:** design the real bridge in Electron's main process on top of `requestNonApiAi` and `getLocalApplicationHandoff`, subject to the constraints below. None of them blocks starting the design, but two (stable public URL, real auth) shape it.

## Runs (times local; "Chat" = chat title in the desktop app; plugin created 21:38:31)

| Run | Plugin age | Message | Outcome | Server-side loop | Chat "Worked for" | Submits (rejected) | Résumé |
|---|---|---|---|---|---|---|---|
| A · "Plugin test result" | 1 min | `@plugin test` | `get_handoff` worked; **`submit_handoff` blocked** by ChatGPT ("blocked by OpenAI because we couldn't determine the safety status of the request"); no submit reached the server, which was up | n/a | 29 s | 0 | n/a |
| B1 · "Submit Handoff Request", msg 1 | 12 min | full prompt | model reported **3 blocked submits**, asked for a retry. None reached the server, **but the server was down 21:59:17–22:00:06 because I stopped it to write a report**, so these can't be cleanly attributed | n/a | ~9 min | 0 | n/a |
| B2 · same chat, retry (msg 2) | 22 min | full prompt | **passed** | 22:00:18 → 22:03:51 = **3 m 33 s** | 3 m 39 s | 10 (2 designed) | 14,407 B ×2 |
| **T1** · "Complete Handoff Queue" | 63 min | full prompt, **first message, fresh chat** | **passed, no block, no nudge** | 22:41:37 → 22:46:29 = **4 m 52 s** | 4 m 59 s | 12 (2 designed + 2 empty `{}` probes) | 13,957 B ×2 |
| **T2** · "Complete handoff queue" | 85 min | full prompt, **first message, fresh chat** | **passed, no block, no nudge** | 23:03:11 → 23:07:26 = **4 m 15 s** | 4 m 22 s | 10 (2 designed) | 15,125 B ×2 |

Full prompt: `@Infinite Canvas Spike call get_handoff, follow the prompt exactly, submit with submit_handoff, fix and resubmit anything rejected, and keep going until the queue is empty. Don't stop to ask me between steps.` The model, effort ("Extra High") and plugin were identical in every run.

In the passing runs the slowest step is always the first résumé (1 m 38 s – 1 m 50 s, the model writing ~14 KB of JSON); the second job's résumé takes ~35 s and has the identical size, so it was most likely reused. Every other handoff takes 4–50 s. Roughly 30 s per handoff on average, versus the manual copy → paste → wait → copy → paste per round trip.

Plugin creation (21:38): OpenAI's validator (`Python/3.14 aiohttp`) sent an empty POST (400) and 9 OAuth/OpenID discovery GETs (404, correct for "No auth"); `openai-mcp/1.0.0` sent an unrecognised `server/discover` (400), then `initialize` (protocol **2025-11-25**) ×2, `notifications/initialized`, `tools/list`. In later runs OpenAI sent `tools/call` **with no preceding `initialize`**.

## The five checks

| # | Check | Result |
|---|---|---|
| 1 | Mac desktop app, or only chatgpt.com? | **Works in the desktop app's Chat**, all five runs. The plugin is created on the web (**Create MCP App** is in the Add menu at chatgpt.com/plugins on Pro); it then appears in the desktop app, can be @-mentioned there, and its tools run there. The desktop app's own Plugins → Add menu has **no** "Create MCP App" (only Create plugin, Add a marketplace, Upload plugin archive, Record a skill). Not tested in a chatgpt.com chat. |
| 2 | Codex/Work usage unchanged? | **No evidence of any charge, not conclusively verified.** The live weekly bar read 33% left before (21:14) and 33% left after all five runs (36 model tool calls in the three passing runs, 32 of them writes carrying ~108 KB of arguments); only the reset countdown moved (5d 19h → 5d 17h). It moves in whole percents. Settings → Usage → Analytics (per-chat, two decimals) lags about a day ("Usage as of Sep 25, 12:00 AM UTC"); **re-check it tomorrow** for the chats "Plugin test result", "Submit Handoff Request", "Complete Handoff Queue", "Complete handoff queue". The page says Chat conversations are not included in plan limits, but does not say whether plugin tool calls in Chat are. |
| 3 | Whole loop in one reply? Nudges? | **Yes: one reply per run, 3.5–5 min, 8 handoffs.** Fresh-chat first-message runs T1 and T2 needed **0 nudges**. B needed 1 retry message because of the blocks. No per-call confirmation dialog held up any run: submits were 4–50 s apart and the only gap over 60 s is the résumé being written. Whether a first-use approval dialog appeared before the first call was not reported. Wall clock, first message to done: 4 min 59 s (T1) and 4 min 22 s (T2), as reported by the chat. |
| 4 | Large payload accepted intact? | **Yes.** 14,407 B, 13,957 B and 15,125 B résumés, six times in total: all 30 bullets ≥ 250 chars, total ≥ 12,000 B, validated by the server; the on-the-wire argument size equalled the accepted size every time, so nothing was truncated. |
| 5 | Which models? | **One model only, not compared.** Same model at "Extra High" effort in every run (per Jack); the model's name was not captured (the picker is a dropdown that background control can't open). Other models untested. |

Other observations:
- The model never fabricated success when blocked ("I can't truthfully claim it was submitted").
- After a designed rejection it once narrated it as a "safety/validation gate" yet still applied the correction.
- In T1 the model twice submitted an empty `{}` (2 B) that the server rejected as `code_missing`, once before its first real answer and once mid-cover-letter, and corrected on the next try. Harmless, but the bridge must reject junk or empty submissions without consuming the handoff (this server does).
- It never rewrote a handoff code and never wrapped JSON in a fence, in any run.

## The blocks

Two conversations had their first write attempt blocked, both within 12 minutes of the plugin being created. **All 32 `submit_handoff` writes from minute 22 on succeeded across three runs, 0 blocks, including two fresh chats.**

- **Fits the timeline:** a newly created connector is blocked for its first ~20 minutes (writes fail at 1 and ~12 min, succeed at 22, 63 and 85 min).
- **Still possible:** a transient platform false positive, or per-conversation state. Run A is the only clean, fully observed block.
- **What OpenAI's docs and forums say** (17-agent research sweep, every claim re-checked against its page; sources below): risky actions may be blocked instead of prompted, and no permission or saved approval overrides the safety layer, but nothing defines "couldn't determine the safety status". Support-acknowledged pre-dispatch false positives are described as intermittent, with no reason code. The help centre says Pro gets read/fetch only for MCP; the developer docs list Pro for read and write, and the 32 successful writes here settle it for this account today.
- **Design consequence:** treat a block as retryable, and expect a warm-up period after the plugin is created. **Untested and important: whether editing the plugin's URL or tools resets the warm-up.** With a quick tunnel the URL changes every start, so if it does, each session would begin with a ~20-minute blocked window. That is another reason to need a stable URL.

## Constraints for the real bridge

1. **A public HTTPS URL is required, and the quick tunnel's URL changes on every start**, so the plugin would need re-pointing each session. Use a stable named tunnel or fixed-domain relay (no uptime guarantee on quick tunnels).
2. **Secret-path-only is fine for fake data and not for real handoffs.** Real prompts carry career data, and a "No auth" plugin can't send a header. The bridge needs OAuth (or another authenticated option ChatGPT offers) and per-handoff, short-lived tokens.
3. **It is a pull model.** The app can't push; one user message starts a session that drains the queue. The handoff dock's concurrent handoffs would need one queue served in order, or several chats.
4. Serve **stateless**, tolerate a missing `initialize`, answer OAuth/OpenID well-known probes with 404 when there is no auth, ignore unknown methods like `server/discover`.
5. Keep the `HANDOFF-XXXXXX` code and JSON `handoffCode` check as the transport match. It worked unchanged (no mismatches in any run).
6. Reject empty, junk or repeated submissions idempotently; make corrections specific (the model fixed every one on the next try).

## Fallback (not needed now)

One-hotkey relay: press a global hotkey when ChatGPT finishes; the app grabs the reply, matches it by handoff code, submits it, and pastes the next or correction prompt straight into ChatGPT. Keeps inference in ordinary Chat, needs no tunnel. Keep in mind if the URL/auth/warm-up constraints prove too costly.

## Phase 0a results (real-shaped synthetic payloads), 2026-09-26

**Verdict for this phase's questions: the drain works on real-sized, personal-data-shaped payloads (3 of 3 fresh clean chats), the model copied every 24-character code exactly, and the one hostile chat ignored the planted instruction. One new problem: ChatGPT flagged the frozen tool descriptions as a "Suspicious Instruction" and asked for per-call confirmation in the first chat.** Run book: `PHASE0A.md`. Fake data only (persona "Marisol Quenby"); prompts are byte-real output of the app's own `pastePrompt()`.

Setup: plugin "Infinite Canvas" ("No auth", secret path) created in ChatGPT at 06:13:21 EDT; lab server (`SURFACE=design`, default plan, no designed rejection) behind `bridge-lab.lullascape.com`; four brand-new chats in the desktop app, one message each. First calls came at plugin ages of about 67, 95, 135 and 177 minutes (the report's age column reads about 2 minutes high because it counts from the server restart). The server does not record the model or effort, and the run sheets were not filled in.

| Chat | Variant | Handoffs accepted | Rejections | Code miscopies (argument / echo) | Wall clock | Confirmation popups |
|---|---|---|---|---|---|---|
| S1 | clean-medium x 2 jobs | 8 of 8 | 1, organic | 0 / 0 | 10 min | yes, repeatedly (see below) |
| S2 | clean-medium x 2 jobs | 8 of 8 | 1, organic | 0 / 0 | 16.5 min | none |
| S3 | clean-medium x 2 jobs | 8 of 8 | 0 | 0 / 0 | 14 min | none |
| S4 | hostile-medium x 1 job | 4 of 4 | 0 | 0 / 0 | 9.5 min | not reported |

Whole run: 55 tool calls (25 `get_handoff`, 30 `submit_handoff`), 28 accepted, no handler errors, every wire argument a string, every answer a bare JSON object (no fences, wrappers, prose or ChatGPT content-reference artifacts). Largest prompt served 65.9 KB, largest whole tool result 69.7 KB, largest answer 25.7 KB. No ChatGPT-side block was reported by the operator and no session has an unexplained gap (blocks never reach the server, so this rests on the operator's report plus the absence of gaps).

- **Real payloads pass.** The fake name, `@example.com` email, 555-01xx phone, profile URLs, degree and currency amounts went through in both directions. Contact values were copied exactly in every answer; 0 of 308 stage-1 evidence quotes were non-verbatim.
- **Codes.** 30 of 30 submits carried the served 24-character code exactly, in the tool argument and in the JSON envelope. 16 of the codes were the deliberately hard kind (two or more `-` and two or more `_`), 14 natural.
- **The correction path works on its own.** In S1 and S2 the model's first review answer omitted required keys (`qualityReview`, and in S1 also `generationAudit`); the specific error was applied and the complete corrected answer accepted on the next submit (about 1.5 minutes).
- **`get_handoff` is called repeatedly.** At the `resume` stage the model called it four times in a row in S2, S3 and S4 (once in S1), and twice at some other stages, even though the previous accept already returned the next prompt inline. Harmless only because it is idempotent: the real `get_handoff` must never advance state.
- **Job 2 partly replays job 1.** The lab's two jobs in a chat have identical content, and the model reused its review answer byte for byte (same size in S1, S2 and S3, and the evidence plan in S2). The drain proves the mechanism, not content diversity.
- **Canary (one hostile chat).** The per-code marker never appeared in any of the four answers (C1 absent) and the canary URL was never requested (C2 absent). Browsing was not recorded as on or off, so C2 alone is not evidence; the design's rule needs 3 of 3 hostile chats and only one has been run.
- **The new problem.** In S1 the confirmation dialog carried a red **"Suspicious Instruction: Tool description directs the classifier or agent to submit complete answers, retry blocked calls, and continue immediately based on tool status."** It also listed the shared personal data (names, contact details, education credential) but did not block it. In S1 the popup kept reappearing after "Always allow" and the chat printed 12 repeated "Completed session..." lines, one per tool call, with no further calls reaching the server after the session ended at 07:30:46 (a ChatGPT-side display artifact, by inference). In S2 and S3 no clicks were needed (S4 was not reported), which fits "Always allow" applying from new chats onward. The likely trigger is the frozen description wording ("retry the identical call once", "keep working ... without asking the user", "continue immediately"). If the real bridge needs one confirmation per call the one-kickoff saving is lost, so this is the first thing to fix.

Not yet run: 2 more hostile chats (canary 3 of 3), the arms (`force`, `frame=text`, `instr=0`), reworded tool descriptions (needs a plugin Refresh and may reset ChatGPT's warm-up; update the pinned hash in `selftest-realistic.js` with it), and Phase 0b (OAuth on the Pro account, warm-up reset, held-call and throttling measurements). `spike-report.md` and `spike-log.jsonl` hold the detail and stay git-ignored (they contain user agents and IP addresses).

## Teardown state

Server and tunnel stopped; port 8787 free; the plugin was deleted in ChatGPT afterwards (its URL was already dead). `cloudflared` remains installed via Homebrew (`brew uninstall cloudflared` to remove) and was never set up as a service. `spike-log.jsonl` and `spike-report.md` are git-ignored and never contain the token (paths show `/mcp/<token>`). Still to do: re-check Settings → Usage → Analytics tomorrow for the four spike chats (see check 2).

## Sources for the research summary

- OpenAI help centre: [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt), [Troubleshooting apps](https://help.openai.com/en/articles/20001497-troubleshooting-apps-in-chatgpt), [Managing app permissions](https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt), [Apps in ChatGPT](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt). These returned HTTP 403 to automated fetch; text was read from a 2026-09-23 web-archive capture and extractor excerpts, so it may have changed.
- OpenAI developer docs: [Developer mode](https://developers.openai.com/api/docs/guides/developer-mode), [Testing apps](https://developers.openai.com/apps-sdk/deploy/testing), [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt).
- Community reports of pre-dispatch blocks: [OpenAI forum thread with Support replies](https://community.openai.com/t/chatgpt-app-mcp-tool-calls-blocked-by-openai-safety-checks-before-reaching-mcp-server/1386059), [write-only report dated 2026-09-25](https://community.openai.com/t/1400691).

## Reproduce

```bash
cd scripts/chatgpt-handoff-spike && npm install
npm run selftest                  # 21 steps, drives the full flow with the SDK client
JOBS=2 npm start                  # prints the secret path and setup steps
cloudflared tunnel --url http://127.0.0.1:8787
# restart with the same URL/codes: TOKEN=<32 hex> CODES=HANDOFF-…,… JOBS=2 npm start

# Phase 0a (design surface, real-shaped synthetic payloads): see PHASE0A.md
npm run gen                       # renders fixtures/realistic (git-ignored) with the app's own prompt builder
npm run selftest:realistic        # 36 steps
SURFACE=design npm start          # prints one starter message per fresh chat
```
