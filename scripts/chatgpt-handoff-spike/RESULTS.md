# ChatGPT MCP handoff spike: RESULTS

**Date:** 2026-09-25 · **Account:** ChatGPT Pro · **Surface:** macOS ChatGPT desktop app, ordinary **Chat** mode (not Work/Codex) · **Server:** this directory, `JOBS=2`, stateless Streamable HTTP with plain-JSON replies, through a Cloudflare quick tunnel, "No auth", secret path.

## Verdict: **conditional GO**

One continuous run drained the whole two-job queue (8 handoffs, 10 `submit_handoff` calls, both designed rejections fixed) in **one assistant reply, 3 min 33 s**, including a **14,407-byte** résumé accepted intact, twice. That is the mechanism working in ordinary Chat on the Mac app.

It is only *conditional* because the first write attempts of the two earlier conversations were blocked by ChatGPT, and I cannot yet say how often that happens (see "The blocks"). Two more fresh-chat runs decide it; the server is left armed for them. Until then, treat "no copy/paste" as demonstrated once, not as reliable.

## What happened (times local, from `spike-log.jsonl`)

| Time | Event |
|---|---|
| 21:12 | Server up, quick tunnel registered. |
| 21:38:17 | Plugin created at chatgpt.com/plugins → Add → **Create MCP App**. OpenAI's validator (`Python/3.14 aiohttp`) sent an empty POST (400) and 9 OAuth/OpenID discovery GETs (404, correct for "No auth"). |
| 21:38:31 | `openai-mcp/1.0.0` sent `server/discover` (unrecognised, 400), then `initialize` (protocol **2025-11-25**) ×2, `notifications/initialized`, `tools/list`. Both tools discovered. |
| 21:39:40 | **Chat A** (`@plugin test`): `get_handoff` served in 45 ms. The model said it would run the queue to completion, then reported `submit_handoff` was blocked: *"This tool call was blocked by OpenAI because we couldn't determine the safety status of the request."* **No submit reached the server**, and the server was up the whole time. |
| 21:50:48 | **Chat B**, the full instruction prompt: `get_handoff` served. The model then reported three blocked `submit_handoff` attempts and asked for a retry. None appear in the log, **but the server was down 21:59:17–22:00:06 because I stopped it to write a report** (my mistake), so these three cannot be cleanly attributed to OpenAI. |
| 22:00:18 | **Retry message in Chat B.** 22:00:22 → 22:03:51: 10 submits, 8 accepted, 2 designed rejections, queue drained. The model's final message: "Done. I worked through the full … queue … and the queue is now empty." ("Worked for 3m 39s"). |

Per-handoff results of the passing run:

| Job | Stage | Submits | Accepted size | Issued → accepted |
|---|---|---|---|---|
| 1 | evidence_plan | 1 | 376 B | ~4 s¹ |
| 1 | resume | 1 | **14,407 B** | 1 m 38 s |
| 1 | cover_letter | 2 (1 forced rejection) | 1,636 B | 34.5 s |
| 1 | review | 1 | 238 B | 6.6 s |
| 2 | evidence_plan | 1 | 418 B | 6.2 s |
| 2 | resume | 1 | **14,407 B** | 35.4 s |
| 2 | cover_letter | 2 (1 forced rejection) | 1,613 B | 21.6 s |
| 2 | review | 1 | 268 B | 7.2 s |

¹ The generated report says 16.2 s: my own `curl` check at 22:00:06 started that stage's clock. The model's `get_handoff` was at 22:00:18 and the accept at 22:00:22.

The only gap over 60 s is the first résumé (1 m 38 s), which is the model writing 14 KB of JSON, not a wait for the user. The second résumé had the identical size (14,407 B), so the model most likely reused the first one's text.

## The five checks

| # | Check | Result |
|---|---|---|
| 1 | Mac desktop app, or only chatgpt.com? | **Works in the desktop app's Chat.** The plugin was created on the web (**Create MCP App** is in the Add menu at chatgpt.com/plugins on Pro). It appears in the desktop app, can be @-mentioned, and its tools ran there. The desktop app's own Plugins → Add menu has **no** "Create MCP App" (only Create plugin, Add a marketplace, Upload plugin archive, Record a skill). Not tested in a chatgpt.com chat. |
| 2 | Codex/Work usage unchanged? | **No evidence of any charge, but not conclusively verified.** Live weekly bar: 33% left, resets in 5d 19h, identical before (21:14) and after (22:08). It only moves in whole percents. Settings → Usage → Analytics (per-chat, two decimals) is stamped "Usage as of Sep 25, 12:00 AM UTC", so it cannot show today's chats yet; the top chats were unchanged. **Re-check Analytics tomorrow** for "Plugin test result" and "Submit Handoff Request". The page says Chat conversations are not included in plan limits, but does not say whether plugin tool calls in Chat are. |
| 3 | Whole loop in one reply? Nudges? | **Yes once running: one reply, 3 m 33 s for 8 handoffs**, applying both rejection corrections with no prompting. But it needed **1 retry message** after the blocked attempts in Chat B (Chat A ended at the block). Confirmation clicks: *pending, Jack to fill in*. Total wall clock from first message to done: about 13 min including the blocks and my outage. |
| 4 | Large payload accepted intact? | **Yes.** 14,407 B, all 30 bullets ≥ 250 chars, total ≥ 12,000 B, validated by the server; the on-the-wire argument size equalled the accepted size, so nothing was truncated. Twice. |
| 5 | Which models? | **Not tested.** The composer showed reasoning effort "Extra High"; the model picker was not inspected. *Pending, Jack to fill in.* |

Other observations: the model never fabricated success when blocked ("I can't truthfully claim it was submitted"); after a designed rejection it once narrated it as a "safety/validation gate" yet still applied the correction; in the passing run OpenAI sent `tools/call` **without a preceding `initialize`** (stateless serving is the right call); the model rewrote no handoff code and produced no fenced JSON.

## The blocks (the open risk)

- **Clean evidence:** Chat A. Server up, exact OpenAI wording, no submit in the log.
- **Confounded:** Chat B's three blocked attempts overlap my server outage.
- **Not a plain "unknown domain" or "unknown tool" block:** `get_handoff` worked on the same origin, and 10 of 10 writes worked later, from the same plugin, tools and tunnel.
- **What the research found** (17-agent sweep, every claim re-checked against its page; full text not kept): OpenAI's help pages say risky actions may be blocked instead of prompted and that no permission or saved approval overrides the safety layer, but nothing defines "couldn't determine the safety status". Forum reports (incl. OpenAI Support) describe intermittent pre-dispatch blocks that never reach the MCP server, with no reason code, some clearing on retry. The help centre says Pro gets read/fetch only for MCP, contradicted by the developer docs and by the 10 writes that succeeded here.
- **One hypothesis fits the timeline and is untested:** a newly created connector is blocked for its first ~20 minutes (created 21:38, first write accepted 22:00), then works. Alternatives: per-conversation state (the working run was the second message of its chat), or a transient platform false positive.
- **Deciding runs (cheap):** two or three brand-new chats, same prompt, one message each, on a fresh queue (the server is re-armed on the same URL; use `[@Infinite Canvas Spike] call get_handoff, follow the prompt exactly, submit with submit_handoff, fix and resubmit anything rejected, and keep going until the queue is empty. Don't stop to ask me between steps.`). **Decision rule:** ≥ 2 of 3 succeed on the first message ⇒ GO. Blocks on most first messages but never mid-loop ⇒ still workable with a "retry once" protocol. A block mid-loop, or a block that persists for a fixed conversation ⇒ NO-GO. If it turns out a plain 0-argument write tool is also blocked, that would point to platform/plan rather than anything in this design.

## If it is a GO: constraints for the real bridge

1. **A public HTTPS URL is required, and the quick tunnel's URL changes on every start**, so the plugin URL would have to be re-entered each session. A stable named tunnel or a fixed-domain relay is needed, and it has no uptime guarantee.
2. **Secret-path-only is fine for fake data and not for real handoffs.** Real prompts carry career data. "No auth" ChatGPT plugins cannot send a header, so the real bridge needs OAuth (or another authenticated option ChatGPT offers) and short-lived, per-handoff tokens.
3. **It is a pull model.** The app cannot push; one user message starts a session that then drains the queue. The dock's concurrent handoffs would need either several chats or a single queue served in order.
4. Serve **stateless**, tolerate a missing `initialize`, and expect a probe of the OAuth/OpenID well-known paths at creation.
5. Keep building on `requestNonApiAi` / `getLocalApplicationHandoff`; the `HANDOFF-XXXXXX` code and the JSON `handoffCode` check already exist and worked unchanged as the transport-level match (no mismatches seen).

## Fallback (if it ends NO-GO)

One-hotkey relay: press a global hotkey when ChatGPT finishes; the app grabs the reply, matches it by handoff code, submits it, and pastes the next or correction prompt straight into ChatGPT. Keeps inference in ordinary Chat and needs no tunnel or public endpoint.

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
```

`spike-log.jsonl` and `spike-report.md` are git-ignored; the token is never written to disk (logs show `/mcp/<token>`).
