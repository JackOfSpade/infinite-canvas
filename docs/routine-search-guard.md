# Routine search guard (Parallel Search)

Paste the block below into the prompt of any cloud routine that uses the Parallel Search connector. Replace `{{NOTIFY_EMAIL}}` with the address that should be told (the Gmail account the connector sends from). The routine also needs the Gmail connector attached, limited to `send_message`.

## Why this exists

Parallel's free MCP (`https://mcp.parallel.ai/mcp`, no key; the older `search.parallel.ai/mcp` is announced for discontinuation, and the 2026-11-14 limit below was seen on it) publishes no rate limit or quota. The connector has only `web_search`, `web_fetch` and `send_feedback`, so there is no way to read remaining usage, and nothing is polled. The real error text for an exhausted quota is also unpublished, so the guard stops on any tool-level failure or limit wording instead of matching one message. Never run Parallel calls in bulk to find the limit.

## What the real limit looks like (seen 2026-11-14)

After about 170 anonymous calls in under three hours the free MCP answered with HTTP 200 and a JSON-RPC error, not a tool result: code `-32000`, message "You've hit the free-tier rate limit for Parallel MCP. To continue with higher limits, sign in by connecting https://mcp.parallel.ai/mcp?login, or add your own API key" (header `x-api-key` or `Authorization: Bearer`, key from platform.parallel.ai). The guard's "rate limit" wording catches it. Claude may relay it inside its own answer, so a routine can see it as text and not as a tool error.

## Higher limits (Parallel's own setup prompt, read 2026-11-14)

Signing in at `https://mcp.parallel.ai/mcp?login` adds higher rate limits, free monthly credits and a `web_research` tool. Anonymous keeps only `web_search`, `web_fetch` and `web_decisions`. A claude.ai marketplace connector for Parallel exposes only search and extract. Whether the routine's connector points at the old or the new server was not checked. A platform API key (platform.parallel.ai) is sent as `x-api-key` or a Bearer token and was accepted by both `api.parallel.ai` (REST) and `mcp.parallel.ai/mcp` on 2026-11-14.

## What a failure looks like

A failed `web_fetch` of one URL does not raise a tool error. It returns normally with `results: []` and an `errors` list such as `{"error_type": "fetch_error"}` (seen 2026-11-14). That is an ordinary dead or blocked page, so it must not pause the routine. Only the call itself failing, or limit wording, counts.

## Block to paste

```
SEARCH GUARD. Parallel Search tools (web_search, web_fetch) are the only web tools you may use.

Treat Parallel as UNAVAILABLE only when one of these happens:
- a Parallel tool call itself fails (the tool returns an error, not just one page missing from a fetch result);
- any result or error text mentions 429, rate limit, quota, too many requests, exceeded, usage limit or limit reached;
- two web_search calls in a row return zero results for queries that should clearly have results.
A single URL that fails or is blocked inside a web_fetch result is NOT unavailability; treat that page as missing and continue.

On the first such failure, retry that one call once immediately. Do not sleep, do not start background tasks and do not end your turn while waiting. If the retry fails too, or the text names a rate limit or quota, Parallel is UNAVAILABLE:
1. Stop calling every search and fetch tool. Do not use any other web tool as a substitute and do not invent or estimate results.
2. Finish only the parts of the task that need no web access. Mark every other part "not done".
3. Send exactly one email with the Gmail send_message tool to {{NOTIFY_EMAIL}}. Subject: "[Routine paused] Parallel Search unavailable". Plain-text body: the routine name, the current UTC time, the exact error text from Parallel, which step stopped, what is finished and what is not. If the email tool fails, skip it and do not retry.
4. Make the first line of your final message exactly PARALLEL_UNAVAILABLE, then the same details.
Never send any other email, and never put page content or secrets in the email.
```

## Limits

- It cannot be proven against a real quota without exhausting the free service, so the test simulates a 429 and checks that the routine stops, sends one email and prints `PARALLEL_UNAVAILABLE`.
- A routine does not know its own name, so put it in the prompt (for example "This routine is called X") or the email will say it is unnamed (seen in the 2026-11-14 simulated run).
- A recurring routine is not disabled by the guard. The run stops and the next scheduled run tries again.
- The guard does not fall back to Tavily or built-in search. That is a deliberate choice; change step 1 if it should.
- First test (2026-11-14) worked but slowly: the routine started a background `sleep 60`, its log looked finished after 8 seconds, and it resumed when the sleep ended and sent the email. Waiting in the background is fragile, so the retry is now immediate.
