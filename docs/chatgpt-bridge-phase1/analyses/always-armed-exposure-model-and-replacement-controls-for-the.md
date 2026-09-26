# Always-armed exposure model and replacement controls for the ChatGPT bridge (decision D5)

With D5 the loopback listener and cloudflared stay up for as long as the bridge is enabled, so uptime stops being a control. The spec makes exposure a function of four things that are opened only by native-confirmed user actions and that expire by count or age rather than by session timers: the release set (which jobs or runs ChatGPT may see), the chat epoch (which chat holds the key, at most 2 jobs, 24 h), the link (one OAuth grant, idle 7 d, absolute 30 d) and the serving state (live or paused). It defines sixteen controls (C1 to C16), each with exact state, IPC, UI hook and test, plus the replacement threat model (17 scenarios, capability ladder), the fixed public route table, the anomaly auto-pause rules (triggerable only by authenticated credentials, never by anonymous noise), the logging rules and the residual risk. New findings from the code and the lab log that the design did not have: ChatGPT's real client document lists ONE redirect shared by every ChatGPT user, so OAuth cannot tell Jack's ChatGPT from a stranger's and the pairing code plus a same-network check are the only human binding; the lab pairing code is 40 bits and any live code approves any pending request; the lab CIMD allowlist is host-level, not URL-level; the lab access-token default (300 s) is below the measured 1 h floor; every measured ChatGPT connector request came from one /28; macOS keeps the app alive with zero windows; there is no Tray, dock badge, notification or powerMonitor code anywhere; push handoff codes are 6-char deterministic hashes, not capabilities. Literal D5 is still available by setting three limits to 0, each with a native confirm, and the spec states what that profile gives up.

## Verified facts

- Repo state: no CLAUDE.md exists in the repo; git status is clean; no bridge code exists in electron/ or src/ (grep for handoffBridge and cloudflared hits only scripts/chatgpt-handoff-spike/server.js). Electron is ^42.2.0 (package.json:78).
- Line references in the design doc still match: getLocalApplicationHandoff at localAiApplication.js:3863, submitLocalApplicationHandoff at :3959, localApplicationStatus at :8861, application codes crypto.randomBytes(18).toString('base64url') at :706-708 (144 bits, case-sensitive, rotated at :723-731), stale-code throw at :3963-3971, MAX_RESULT_BYTES 1_000_000 at :58, quit Promise.allSettled at main.js:1361-1365 inside the 25 s race at :1375-1378, registerNonApiAiHandlers at main.js:1178.
- Every served application prompt carries PII: pastePrompt embeds careerData at the evidence-plan stage (localAiApplication.js:1138-1147) and the resume stage (:1155), later stages carry the accepted resume with identity and contact; each job folder freezes its own context/career-data.txt (:3657). Per-job release therefore limits listing and draft exposure, not career-corpus exposure. pasteHandoffRecord returns `draft` (the human's unsent paste, or on rejection the rejected response) at :2642-2645, so the bridge must project a whitelist and never forward the record.
- Push handoff codes are HANDOFF- plus 6 characters (30 bits) derived deterministically from SHA-256 of prompt, task, nodeId, batch, itemCount and attachments (nonApiAi.js:439-501): an echo check, not a capability, and they recur across re-runs. Push accept is bound to the originating renderer: requestNonApiAi throws without a sender (nonApiAi.js:1975-1979), the submit handler compares event.sender to record.sender (:2386-2391), and replay is deliberately sender-scoped 'so it never exposes another window's career data' (:2370-2376; ipcUtils.js:9-13). Bridging push relaxes that rule, so it must be an explicit per-run release.
- macOS keeps the process alive after the last window closes: window-all-closed quits only on non-darwin (main.js:1236-1238) and activate recreates a window (:1229-1233). The app also runs a fixed loopback listener at every launch (startApplicationSyncServer, main.js:1172; applicationSync.js:28-33, 1105) whose capability tokens are stored in plaintext in a 0600 file (applicationSync.js:305-320), and takes a single-instance lock (main.js:246).
- There is no Tray, dock badge, Notification, powerMonitor, powerSaveBlocker, login-item or clipboard-clearing code anywhere in electron/ or src/ (only app.dock.hide for E2E at main.js:926), and the test stub exports none of them (scripts/test-stubs/electron.mjs:139-141); its dialog.showMessageBox returns {response:0} (:63), so native confirms must use button 0 = Cancel to make the stub default safe. Everything new needs dependency injection.
- The renderer is untrusted by the app's own assumptions and by construction: index.html has no CSP; IPC handlers validate no sender (ipcUtils.js handleSafe; settings.js:187-212 returns decrypted secrets to the renderer); localAiApplication.js:5262-5264 says a path must never come from the renderer because of 'a compromised or buggy renderer'; canvasFilePath is renderer-reported (main.js:1197-1200). Any IPC that raises exposure must be main-native-confirmed.
- Lab authorization server (oauth.js): pairing code is 8 symbols of a 32-symbol alphabet = 40 bits (:963-968), not the design's 10 chars/50 bits; up to 200 live codes (:47, :972-981) and consumePairing accepts any live code for ANY pending transaction (:984-995, selftest-oauth.js:1119); CIMD allowlist is host-level, any path on chatgpt.com passes cimdRefusal (:502-519, :567); default access TTL 300 s (:576) versus the measured 1 h floor (RESULTS.md:159,162); default grace 120 s (:563) versus design 60 s; only an ABSOLUTE refresh lifetime exists, default 7 d (:577, selftest :1450), no sliding idle clock; static-client and DCR paths and registration_endpoint exist (:935-959, :1115, :1292) although ChatGPT used CIMD.
- ChatGPT's real client document, captured byte for byte on 2026-09-26 (selftest-oauth.js:801-804): client_id https://chatgpt.com/oauth/client.json, ONE redirect_uri https://chatgpt.com/connector_platform_oauth_redirect for every ChatGPT user, token_endpoint_auth_method private_key_jwt with methods_supported [none, private_key_jwt], RS256, jwks_uri https://chatgpt.com/oauth/jwks.json. The consent page can therefore only say 'chatgpt.com is asking' (oauth.js:373-378); nothing binds a grant to Jack's ChatGPT account. The lab AS advertises only none/client_secret_* (oauth.js:64,1120) and accepts an UNSIGNED client_assertion solely to name the public client (:1204-1217); no client_assertion_ignored event appears in the 27 OAuth events of the retained log, so ChatGPT most likely authenticated as a public client. A refresh token is a bearer credential.
- Refresh reuse outside the grace window revokes the family (oauth.js:1611-1617); inside the window a replay returns the identical pair (:1620-1636), so a thief and ChatGPT holding the same pair is invisible. Authorize is armed-only: 403 with no work while no pairing session exists (:1407-1415). authenticate() scans every live access-token digest in constant time (:1739-1762) and server.js answers 401 before reading any body (:439-461).
- Retained lab log (scripts/chatgpt-handoff-spike/spike-log.jsonl, about 12 h, 654 lines): every request carrying the openai-mcp, openai-connectors-oauth or Python aiohttp validator user agent came from 52.255.111.0 to 52.255.111.15 (16 addresses, one /28); browser and curl came from the operator's own address; three requests with the openai-mcp user agent from the operator's own address (a spoofed-UA test) received the same 200/200/401 as ChatGPT, so the user agent is not a control. Legitimate load: 247 tool calls, at most 4 in 5 s, 6 in 10 s, 11 in 30 s, 16 in 60 s, 28 in 120 s across up to 5 concurrent chats. Only 1 of 334 HTTP events was an unsolicited route, so nothing was learned about real-world scanning.
- Measured ChatGPT behaviour that constrains the controls (RESULTS.md): discovery, consent, exchange as in :150-153; refresh before every call on 2-minute tokens and never within a 1 h token (:159); Disconnect calls POST /oauth/revoke (:167); an expired refresh token yields an inline Reconnect card that opens our authorize page, which failed once with 'No pairing session is open' because none was armed (:169); a call is abandoned after about 60 s and retried (:170); one intermittent safety block after a reconnect (:168); 8 duplicate re-submissions in 2 of 6 chats (:128); get_handoff re-read up to 4 times in a row (:83); hostile canary ignored in 9 of 9 chats (:183), which bounds the failure rate only to about 28% at 95% confidence (exact one-sided bound for 0 of 9) and never recorded whether browsing was on.
- Lab-only public routes that must not ship: /healthz (server.js:421-424), /canary/<nonce> (server.js:425-430), near-miss session-code logging with edit distance (realistic.js:399-413), DCR route and registration_endpoint advertisement (oauth.js:1115, :1292), CORS * on well-known documents is fine because they are public (:1160-1169).
- The lab tunnel is a locally-managed tunnel: credential file ~/.cloudflared/<tunnel-id>.json (mode 0400), ~/.cloudflared/config.yml (0600) with hostname to http://127.0.0.1:8787 and a catch-all 404, cert.pem deleted afterwards (docs/chatgpt-bridge-hostname-chrome-prompts.md:134-139). docs/chatgpt-bridge-hostname-runbook.md:63-68 still describes the dashboard token method (`cloudflared tunnel run --token <TOKEN>`); a token in argv is visible to every local user through ps, so an app-spawned tunnel must use credentials-file mode.
- Bug reports keep origin+pathname of every URL (bugReport/helpers.js:13-27) and read the main logger ring buffer (logger.js:8-38), so the bridge hostname and any logger line reach the reports Jack pastes to Claude unless the bridge logs only enums and the hostname is added to redaction.
- Design-tools.js v2s is the frozen surface: get_handoff has only a `session` argument (design-tools.js:107), so the model cannot choose a job; submit_handoff takes session, handoffCode, response (:141-145) and its description already allows 'another status with a short note' (:46), so new result statuses (paused, session_expired and so on) need no tool-surface change.

## Design claims that no longer hold

- Design section 5 topology, section 8 last sentences, section 9 STATES ('ready ... NO listener') and T1 ('listener exists only while a session or pairing window is open; never at launch'): false under D5. The listener and tunnel run for as long as the bridge is enabled; only the pairing surface (/oauth/authorize) stays time-boxed.
- Design section 2 item 9, section 9 START/END, decision D5 text (idle 30 min, 10 after queue_empty, hard 2 h, 'a session ends only on credential-attack evidence', 'a stolen token only works while a session is live' in T10): there is no session. Replaced by release lapse, chat-key expiry, idle PAUSE and anomaly auto-pause (C2, C3, C8, C9).
- Design section 8 'the app never spawns, supervises ... cloudflared ... a crash or force-quit leaves nothing exposed', section 9 KILL ('the app spawns no process'), section 14 item 2 and the Phase 1 exit criterion 'Force Quit leaves no listener': false under D6. A killed app can leave cloudflared running; C13 adds a parent-death watchdog, a launch-time reaper, an ephemeral port bound before the tunnel starts, and credentials-file mode.
- Design section 8 item 2 (one pre-registered client, else DCR, CIMD deferred): superseded by measurement. ChatGPT uses CIMD (RESULTS.md:151) and its document lists one redirect. The design's second redirect pattern https://chatgpt.com/connector/oauth/<id> (also oauth.js:71-74) was never observed. Static client and DCR should not ship.
- Design section 8 item 4 lifetimes (refresh idle 14 d, absolute 90 d, grace 60 s) versus the lab code (absolute only, 7 d default, grace 120 s, access 300 s): the design values cannot be met by porting oauth.js as is, and under always-armed the design's 14 d and 90 d are too long (this spec uses 7 d idle, 30 d absolute, 60 s grace, 3600 s access).
- Design section 8 item 5 says the pairing code is 10 characters (50 bits) and 'compare two codes' was reversed so a racing attacker cannot approve; the lab code is 8 characters, accepts any code for any pending request and allows many live codes. Because ChatGPT's redirect is identical for all users, the pairing code plus a same-network check are the only human binding; C5 hardens this.
- Design section 8 item 6 (10 wrong chat keys with a valid token ends the session) and item 4 ('reuse ... does not by itself end the session'): with no session, refresh reuse, code replay and wrong-key bursts become auto-PAUSE triggers with native-confirmed resume (C8).
- Design section 9 START (native confirm at Start names the fixed job set) and section 7 MEMBERSHIP (job set fixed at Start): there is no Start under D5. The one main-owned native confirm moves to each RELEASE of jobs or push runs (C2, C14); this is the click that replaces Start and is what keeps always-armed acceptable.
- Design section 9 SLEEP/WAKE ('suspend ends the session'): no session to end; suspend counts as idle time and resume re-runs the tunnel health probe (C16). Design section 10 INTEGRITY says the audit ledger stores an HMAC of the source address: for authenticated calls store the /24 (IPv4) or /48 (IPv6) prefix in clear, because the measured egress is one /28 and Jack needs to read the prefix in an alarm.
- Design section 8 CLOUDFLARE RUNBOOK says Bot Fight Mode reportedly 403s connector traffic; measured: Cloudflare let every discovery request through, including four other user agents (RESULTS.md:150). The runbook also still describes the token method although a locally-managed tunnel was built (see verified facts).
- Design section 4 D6 and section 8 treat 'a binary to trust' and 'PATH lookup under a GUI launch' as risks to avoid by not spawning; with D6 accepted they become requirements: absolute-path resolution with no PATH, owner and mode checks, a recorded SHA-256 re-approved by native confirm on change (C13).
- Design section 6 says a token alone is useless because of the per-chat key, which holds, but under always-armed the key is long-lived, appears in ChatGPT history (which OpenAI also holds together with the token) and passes through the clipboard (Universal Clipboard, clipboard managers): the key needs a maximum age, a per-epoch job cap and clipboard clearing (C3).
- Design section 12 and Phase 1 exit treat OAuth negative tests as a security-review item only; the lab already has a 100-step suite (selftest-oauth.js) that should be ported as the base of the product suite, with new tests for the changed behaviour (single grant, CIMD pin, pairing binding, idle/absolute clocks).

## Specification

# Always-armed exposure model and replacement controls (D5)

Status: specification only. Nothing here is built. It replaces design doc section 8 items 1, 2, 4, 5, 6; section 9 STATES, START, END, SLEEP/WAKE, KILL; section 10 T1, T2, T5, T10 and INTEGRITY; and decision D5. Everything else in the design (tool surface v2s, engine, queue integration, UI panel, tests) stands unless a section below says otherwise. This spec does not argue with D4, D5 or D6; it contains their risks.

Evidence tags used below: [M] measured (RESULTS.md, spike-log.jsonl, lab selftests), [C] read in current code (path:line), [D] design doc statement, [U] unmeasured or unverified (a Phase 1 gate, see section 10).

## 0. Decision summary

1. D5 keeps the transport (loopback listener + cloudflared) up while the bridge is enabled. That changes how long the anonymous surface exists. It does not change what a credential holder can read. The organizing rule of this spec: career-data exposure is the intersection of (released items) AND (live chat epoch) AND (valid link) AND (serving live) AND (not lapsed). None of those terms is a function of app uptime, and each is opened only by a main-owned native confirmation.
2. Session timers are gone. Time survives in three places only: per-release lapse (default 24 h), chat-key max age (default 24 h) and an idle PAUSE (default 180 min) that pauses serving, never disables or unlinks, and is lifted by any native-confirmed release, New chat or one Resume click. Each can be set to 0 (off) with a native confirm; setting all three to 0 plus autoServeOnLaunch is literal D5 (section 11 states what that gives up).
3. Sixteen controls, C1 to C16 (section 6). The four that matter most: C2 release set (replaces Start), C3 chat epochs (key, at most jobsPerChat jobs, expiry), C5 pairing binding (the only human binding, because ChatGPT's OAuth identity is the same for every user), C8 anomaly auto-pause (only authenticated-credential events can pause; a stranger who knows the hostname can never hold a kill switch).
4. New facts that change the design are in section 1.4 (N1 to N16).

## 1. What D5 changes

### 1.1 Meaning of always armed

Four planes with different lifetimes:

| Plane | What it is | Lifetime under D5 |
|---|---|---|
| Transport | loopback listener + cloudflared + public hostname | while enabled (process-scoped; off after every launch unless autoServeOnLaunch) |
| Link | the single OAuth grant to ChatGPT (hashed tokens) | access 1 h; refresh idle 7 d sliding; absolute 30 d |
| Release | which application jobs / push runs ChatGPT may ever see | until lapse (24 h) or removal |
| Epoch | which chat holds the current key and which released jobs it has been assigned | until New chat, key max age (24 h) or jobsPerChat jobs (2) |

### 1.2 Before and after

| Property | Armed session (design) | Always-armed with this spec |
|---|---|---|
| Listener and tunnel up | at most 2 h per session, mostly 0 | whole time the bridge is enabled |
| Anonymous surface (discovery, 401, 403) | only during sessions | continuous |
| New grants possible (pairing) | 10-minute window | unchanged: 10-minute window, single code, single request, same-network |
| Access token | 60 min | 3600 s [M floor] |
| Link life | idle 14 d, absolute 90 d (not implemented in lab) | idle 7 d, absolute 30 d, one grant only |
| Chat key life | session, at most 2 h | at most 24 h, at most 2 jobs, rotated by New chat |
| Data a token+key holder can read | job set fixed at Start (up to 10 jobs) | at most jobsPerChat (2) released jobs, each released at most 24 h ago |
| Unattended exposure | none (needs a Start) | none unless Jack released work and started a chat within the lapse windows and idle pause has not fired |
| Force-quit | no listener, no process | watchdog kills cloudflared within about 2 s; launch-time reaper (C13) |

### 1.3 Rule

Uptime affects only three things: (a) how long strangers can fingerprint and flood the public surface, (b) how long a stolen credential keeps working, (c) how long a forgotten release stays readable. Controls C4, C7 and C9 bound (b) and (c) by count and age; C6 and C7 bound (a).

### 1.4 Findings that change the design

- N1 [M/C] ChatGPT's real client document lists one redirect for every user (selftest-oauth.js:801-804). OAuth cannot distinguish Jack's ChatGPT from a stranger's plugin pointed at the same hostname. The consent page can only say 'chatgpt.com is asking' (oauth.js:373-378). The pairing code (plus a same-network check) is the only human binding.
- N2 [C] Lab pairing is weaker than the design says: 40 bits, up to 200 live codes, any code approves any pending request (oauth.js:963-995).
- N3 [C] CIMD allowlist is host-level: any chatgpt.com path passes (oauth.js:502-519). Pin the exact URL.
- N4 [C] Lab defaults contradict measurements and design: access 300 s versus the 1 h floor; grace 120 s versus 60 s; only an absolute 7 d refresh clock.
- N5 [M/C] A refresh token is a bearer credential: ChatGPT is a public client here; the AS accepts an unsigned assertion only to name the client (oauth.js:1204-1217). ChatGPT's document supports RS256 private_key_jwt; whether it would sign if the AS advertised it is [U] (gate G1).
- N6 [C] Refresh grace replay hides theft: inside the window both parties hold the identical pair (oauth.js:1620-1636).
- N7 [M] Every measured ChatGPT connector request came from one /28 (52.255.111.0 to .15) over about 12 h; user agent is spoofable (three spoofed requests got identical answers). A source-prefix signal is usable; a user-agent rule is not.
- N8 [M] Legitimate load is tiny: at most 16 tool calls in any 60 s across 5 concurrent chats.
- N9 [C] macOS keeps the app alive with zero windows (main.js:1236-1238) and jobs finish only in a renderer, so an always-armed bridge outlives every canvas.
- N10 [C] No Tray, dock badge, Notification, powerMonitor or clipboard-clear code exists and the test stub has none: the indicator and all its tests need injection.
- N11 [C] The renderer is hostile by the app's own assumption (localAiApplication.js:5262-5264), has no CSP and no IPC sender checks: exposure-raising IPC needs a main-owned native confirm.
- N12 [C] Push codes are 6-char deterministic hashes (nonApiAi.js:439-501), not capabilities; bridging push relaxes the app's sender-scoped privacy rule (ipcUtils.js:9-13, nonApiAi.js:2370-2376).
- N13 [C] Lab-only public routes must not ship: /healthz, /canary, near-miss session logging, DCR route and registration_endpoint.
- N14 [C] Every job folder freezes the full career corpus; per-job release does not shrink career-data exposure.
- N15 [C] Bug reports keep origin+pathname and read the logger ring: the hostname and any bridge log line reach pasted reports.
- N16 [C] D6 argv: a tunnel token on the command line is visible to all local users; use the credentials file.

## 2. Assets, actors, capability ladder

Assets: (A) career corpus, contact details, employment history (in every stage prompt); (B) job listings and generated drafts; (C) integrity of accepted answers (the application documents Jack sends to employers, and push scores that rank jobs); (D) availability of the app's main thread; (E) the tunnel credential, hostname and domain; (F) Jack's ChatGPT account.

Capability ladder (each row includes the rows above it):

| Level | Attacker holds | Can read | Can write | Bounded by |
|---|---|---|---|---|
| L0 | the hostname | discovery documents, 401 challenge | nothing | C6, C7 |
| L1 | + own ChatGPT account and plugin pointed at the host | can start an authorize request only while a pairing window is open and (enforced) from Jack's network | nothing | C5 |
| L2 | + pairing code (shoulder surf, screen share, phish) | a grant (link) | nothing until a key exists | C4, C5, C10 |
| L3 | access token or refresh token | tools/list; every tools/call returns `unauthorized` without the key | nothing | C3, C4 |
| L4 | + chat key of the active epoch | prompt of the epoch's at most 2 released jobs (career corpus, listing, accepted drafts), re-readable | submit for the served code | C2, C3, C9 |
| L5 | + current handoff code (application) | same | validated answers for that lane; 6 rejections or 5 junk then the lane is held | app validators, C2 |
| L6 | code execution as Jack | everything on disk (already includes career-data.txt, browser profile, application-sync tokens) | everything | outside the bridge |
| L7 | tunnel credential, Cloudflare account or DNS control | plaintext of every call while connected (token, key, prompts, answers) | arbitrary tool results injected into Jack's chats | C13 runbook; residual |
| L8 | Jack's ChatGPT account | drive the plugin as Jack within an epoch; read starter messages (keys) in chat history | same as L4/L5 | C3, C9 |

## 3. Scenario analysis

| ID | Scenario | What the actor gets, using measured behaviour | Always-armed delta | Controls | Residual |
|---|---|---|---|---|---|
| S1 | Someone learns the hostname (DNS enumeration of a guessable label like bridge., a screenshot, the plugin URL) | Discovery 200, /mcp 401, /oauth/authorize 403 unless pairing is open; Cloudflare passes any user agent [M]. A public PRM reveals scope `handoff`. No data. | Surface now continuous and fingerprintable; flood possible any time the app is open. | C6 route table, C7 shedding, C5 authorize closed, C12 counters only, C13 random production label | Fingerprinting; availability loss under flood; a Cloudflare rate rule is [U] |
| S2 | A stranger creates their own ChatGPT MCP app pointed at the hostname | ChatGPT's backend probes discovery and sends the stranger's browser to /oauth/authorize; same client_id and redirect as Jack's [M/C], so OAuth cannot tell them apart. Closed (403) unless Jack opened a pairing window. In a window they still need the code. | Unchanged in kind, but a successful pairing now yields a weeks-long link. | C5 (single 10-char code, single request, same-network, native display, 5 wrong codes closes), C4 (single grant, replaced-link notice), C10 | Screen sharing, shoulder surfing, a housemate on the same NAT |
| S3 | Access token stolen or leaked | Valid 60 min; without the key every tools/call is `unauthorized`. | Same, but the app is reachable all the time. | C3 key, C8 source-new, C4 | Token plus key both sit at OpenAI |
| S4 | Refresh token stolen (OpenAI side, Cloudflare, memory) | Bearer: public client, no client authentication [C]. Refresh yields fresh access tokens for up to 7 d idle / 30 d absolute. Theft detected only on reuse outside the 60 s grace; inside grace the pair is identical and invisible. | Longer-lived target than a session. | C4 rotation, reuse to revoke + auto-pause + epoch retire (C8), idle 7 d, absolute 30 d, source prefix policy, optional signed client assertion (G1) | A thief who refreshes once per grace-free interval before ChatGPT does is detected only when ChatGPT next refreshes |
| S5 | Chat key exposed (clipboard history, Universal Clipboard, screenshot, ChatGPT history, OpenAI compromise) | Key alone useless; with a token it opens the epoch's at most 2 jobs. | Long-lived key would be a standing credential. | C3: max age 24 h, at most 2 jobs per epoch, New chat rotates, clipboard cleared after 120 s if unchanged, retired keys answer `session_replaced` | Clipboard managers that already captured it; OpenAI holds token and key together |
| S6 | Prompt-injected model (hostile listing) | Measured: canary ignored 9 of 9, marker never in answers, canary URL never requested; browsing state never recorded; one model and effort [M]. get_handoff has no job selector, so an injected chat cannot ask for other jobs; it can only read the served lane and advance by producing validator-passing answers. Job A's hostile text stays in context while job B is served. | More chats over time means more hostile listings met. | C3 jobsPerChat cap (2), C2 release, v2s frozen surface, starter clause, C8 lane-probe counter | Another tool in the chat (browsing, memory, other apps) is an exfiltration path the app cannot police; canary bound about 28% at 95% confidence; poisoned but grounded answers |
| S7 | A second or stale chat | Same key in two chats gets the same lane (no chat identity server-side; whether ChatGPT sends a conversation id in _meta is [U], gate G2). Old key after New chat gets `session_replaced`. | Old chats linger for days. | C3 rotation, retired keys not counted as anomalies, max age | Duplicate dispatch in two chats sharing a key; costs generation, not data |
| S8 | Replay of a submit | ChatGPT re-sends after its own 60 s abandon or on its own (8 duplicates in 2 of 6 chats [M]). An attacker with token+key+code can replay too. | None. | Engine: single-flight, verdict cache, tombstones keyed per lane, accepted code rotates so replay is `duplicate`; extend the verdict cache for REJECTED bytes until the code rotates so replays cannot inflate the rejection streak; per-job cap 6 | A valid, current, correct answer replayed is harmless |
| S9 | Malicious client-metadata document or redirect | Ported fetcher: exact URL, HTTPS, no port or userinfo, no redirects, JSON only, 16 KB, 3 s, public IPs only, guarded DNS lookup; redirect exact match; never redirects on unvalidated input. | Fetch happens only while a pairing window is open. | C4 pin to https://chatgpt.com/oauth/client.json and its single redirect; cache per window | OpenAI's own document changing (fails closed, needs a code update) |
| S10 | Local processes and browsers | Same-user malware already has everything (L6). Bridge-specific: any local process can reach 127.0.0.1; a web page can attempt DNS rebinding or a simple cross-origin POST; a squatter can bind a stale port. | New permanent local listener next to the existing one at 43192. | C6 (Host pin, Origin reject, JSON content type, no CORS), C13 (ephemeral port bound BEFORE the tunnel starts, unix socket if supported, watchdog, reaper) | Same-user malware |
| S11 | Renderer compromise (hostile generated HTML, no CSP, no IPC sender check) calls bridge IPC | Could try to enable, release, resume, loosen limits. Cannot read key, tokens or pairing code (never cross IPC). | New IPC surface. | C15 native-confirm matrix, C2 input validation, C1 | The user approving a native confirm they did not initiate |
| S12 | App left running for days, laptop asleep, all windows closed | Nothing is released after 24 h; key expired after 24 h; idle pause after 3 h; refresh dead after 7 d idle; with zero windows lanes answer `app_unavailable`. | This is the scenario D5 creates. | C9, C2, C3, C4, C16, C11 (Tray visible with no window) | Anonymous surface is up the whole time |
| S13 | Tunnel, Cloudflare account or DNS compromised, or a rogue connector on the same tunnel | Sees token, key, prompts and answers in cleartext for calls it receives; can also return arbitrary tool results into Jack's chats (inverse prompt injection). Not detectable from the origin. | App now holds and spawns the tunnel (D6). | C13 (credentials file 0400/0600, no token in argv, cert.pem warning, no PATH), runbook (2FA, registrar lock, delete cert.pem), C10 Revoke-all, random production label | Cloudflare reads plaintext by design; rogue connector undetectable |
| S14 | Jack's ChatGPT account taken over | Can drive the plugin as Jack and read old starter messages. | Longer-lived link. | C3 max age and job cap, C2 lapse, C4 idle/absolute; Revoke-all | Anything inside the current epoch and releases |
| S15 | Load or DoS through the hostname | Only unauthenticated O(1) routes reachable; body never read before auth; authenticated work needs token+key. | Main thread is shared with the UI all day. | C7 (in-flight cap, aggregate bucket, timeouts), C6, Cloudflare rule [U]. No listener-closing circuit breaker (it would hand strangers a kill switch) | Flood can degrade or deny ChatGPT calls |
| S16 | Push handoffs (D4) | Scoring prompts carry candidate evidence (career-derived) plus scraped listings; codes are not capabilities; accepted scores steer job ranking without Jack reviewing each batch. | Push records appear whenever any run parks one, independent of any chat. | C14 (default-deny allowlist, per-run release, no attachments/grounded/marketplace, sender-alive check), C3 caps | Integrity: schema-valid but wrong scores from a credential holder |
| S17 | Local leaks: logs, bug reports, ledger, clipboard, notifications | logger ring feeds bug reports; URLs keep origin+pathname; notification text can show on a lock screen. | More lines over more time. | C12, C11 generic notification text | Pairing dialog contents are visible on screen by design |

## 4. Threat model v2 (replaces design sections 8 to 10 headings)

| ID | Statement | Status versus design |
|---|---|---|
| T1 | Exposure: transport up while enabled; data exposure bounded by release, epoch, link, serving state; unauthenticated surface exactly the C6 table; new grants only through a 10-minute pairing window | rewritten |
| T2 | Authentication: OAuth 2.1 (CIMD pinned, PKCE S256, resource-bound opaque hashed tokens, rotation, reuse detection) plus chat key; refresh token is a bearer; optional signed assertion (G1) | updated |
| T3 | Data minimisation: whitelist projection; nothing served that is not released; draft, localJob, folder, canvasFilePath never served | kept + release |
| T4 | Consent: main-owned native confirm at Enable, at each Release, at resume from anomaly, at any exposure-raising setting; renderer never holds key, tokens or pairing code | rewritten (Start removed) |
| T5 | Kill: Pause, Resume, Revoke all, Disable, Quit; usable from Tray without the renderer | rewritten |
| T6 | Prompt injection: caps by count (jobsPerChat), frozen v2s surface, starter-message rules, honest residual | kept + caps |
| T7 | Logging: enum-only private logger, hostname redaction, sentinel tests, audit ledger without content | kept + audit fields |
| T8 | Secrets at rest: hashes only, 0600, fsync before acknowledging issuance or revocation | kept |
| T9 | Process: narrow import-restricted pre-auth code | kept |
| T10 | Tunnel trust root: D6 controls plus runbook; captured bearer works whenever the bridge is live, bounded by key/epoch/release | rewritten |
| T11 | Credential-theft detection: reuse outside grace, code replay, unknown-key bursts, source prefix, rate bursts, all pause | new |
| T12 | Renderer as attacker: native-confirm matrix | new |
| T13 | Availability under permanent exposure: shedding without a stranger-held kill switch | new |
| T14 | Push integrity: allowlist, per-run release, no attachment/grounded tasks | new |

## 5. Runtime model

### 5.1 State

Persisted: `<userData>/handoff-bridge/state.json` (mode 0600, tmp file created with 'wx', fsync, rename, `{v:2}`, unknown version means unpaired, pid lock as in oauth.js:597-663). Never in electron-store, never in node.data, never returned by IPC.

```
PersistedState = {
  v: 2,
  config: { hostname, tunnelUuid, credentialsPath, cloudflaredPath|null, cloudflaredSha256|null },
  limits: Limits,                    // section 5.2
  prefs: { autoServeOnLaunch:false, pairingNetworkCheck:'enforce'|'off', sourcePolicy:'off'|'alert'|'enforce' },
  link: null | { familyId, createdAt, idleExpiresAt, absoluteExpiresAt, allowedSources:[prefix strings], lastSource },
  as: { families, refresh, access, codes }   // hashed, ported from oauth.js snapshot() with the changes in C4
}
```

Volatile (memory only, gone at quit, never written):

```
Volatile = {
  serving: 'off'|'starting'|'live'|'paused'|'error',
  pause: null | { reason: PauseReason, by:'user'|'auto', at, resume:'click'|'confirm' },
  hold: null | 'no-window',
  pairing: null | { openedAt, expiresAt, codeHash, wrongLeft, ownEgress:{v4?,v6?}, txn:null|{id, createdAt} },
  epochs: { active: Epoch|null, retired: [Epoch x3] },
  releases: Map<jobId, Release>, pushReleases: Map<runId, PushRelease>,
  windows: { anomaly sliding counters, rate buckets }, lastCall, lastActivityAt
}
Epoch   = { id, keyHash(sha256), mintedAt, expiresAt|null, jobsAssigned:[jobId] (<= jobsPerChat), lastCallAt }
Release = { jobId, canvasFilePath, label(<=60), releasedAt, lapsesAt|null, lane, heldReason|null, epochId|null, codes:[<=16 served codes] }
PauseReason = 'user'|'idle'|'refresh-reuse'|'code-reuse'|'key-burst'|'lane-probe'|'rate-burst'|'cap-trip'|'source-new'|'revoked'
```

### 5.2 Settings (Limits and prefs)

Raising exposure means increasing a value or setting 0; that always needs a native confirm (C15).

| Name | Default | Range | Basis |
|---|---|---|---|
| accessTtlSec | 3600 | fixed | [M] ChatGPT refreshed 0 times in 7 calls on 1 h tokens and before every call on 2-minute tokens (RESULTS.md:155-162); lab default 300 s must not ship |
| refreshGraceSec | 60 | fixed | design; lab default 120 |
| refreshIdleDays | 7 | 1 to 30 | sliding, reset by each successful refresh; expiry is one Reconnect card [M RESULTS.md:169] |
| grantMaxAgeDays | 30 | 7 to 90 | absolute from consent; one Reconnect card plus one pairing |
| pairingWindowMinutes | 10 | fixed | design |
| releaseTtlHours | 24 | 1 to 72, 0 = off | bounds S12 |
| chatKeyMaxAgeHours | 24 | 1 to 72, 0 = off | bounds S5 |
| jobsPerChat | 2 | 1 to 3 | design budget; bounds S6 and S5 |
| idlePauseMinutes | 180 | 15 to 1440, 0 = off | slowest legitimate step about 1 m 50 s [M], drains take 4 to 16 min |
| perJobRejectionCap | 6 | fixed | design |
| rateSustainedPerMin | 60 | fixed | 3.75x the measured 60 s peak of 16 [M] |
| clipboardClearSeconds | 120 | 0 to 600 | S5 |
| autoServeOnLaunch | false | bool | C1 |
| pairingNetworkCheck | enforce | enforce, off | C5 |
| sourcePolicy | alert | off, alert, enforce | flip default to enforce after gate G3 |

### 5.3 Serving states

| State | Listener + tunnel | Public surface | tools/call (authenticated) | Entered by |
|---|---|---|---|---|
| off | down | none (Cloudflare error page) | n/a | default, Disable, quit, env kill |
| starting | listener bound, tunnel starting | none until probe passes | n/a | Enable, autoServe |
| live | up | full C6 table | served per the gate pipeline | probe success, Resume |
| paused | up | full C6 table; OAuth refresh keeps working so the link survives | fixed `paused` result; tools/list still answers; in-flight submit completes | Pause, idle, any C8 anomaly, Revoke all |
| error | tunnel or listener failed | none | n/a | start failure, restart budget exhausted |

Pause is soft on purpose: a hard stop would make ChatGPT's next refresh fail against a dead origin and can look like a broken link. Disable is the hard stop.

### 5.4 Gate pipeline (order is normative)

For every request, `tick(now)` runs first (C9).

1. http.js: route allowlist, Host pin, method, Origin and content-type rules (C6); in-flight and aggregate shedding (C7). No body is read.
2. Bearer authentication (401 with challenge on failure; anonymous failures are counters only).
3. Serving state: `paused` gives the fixed paused result for tools/call; `tools/list` and `initialize` are still answered.
4. Read body (2 MiB cap), parse once into known-key shapes; per-grant token bucket (`rate_limited`).
5. Source-prefix policy (alert or enforce).
6. Chat key: retired key gives `session_replaced` (not an anomaly); expired gives `session_expired`; unknown gives uniform `unauthorized` and counts toward key-burst.
7. Window rule: zero canvas windows gives `app_unavailable` (C16).
8. Epoch job cap: a lane not yet assigned when the epoch already has jobsPerChat jobs gives `session_full`.
9. Lane routing and engine (get: depth-first current lane; submit: served-code index, exact match, pre-check, app call).
10. Audit ledger line and status snapshot update (metadata only).

### 5.5 Fixed result statuses and notes (results are outside the frozen tool surface; v2s submit text already says 'another status with a short note')

Plain facts only, no directive wording (the measured lesson of RESULTS.md:126). Behaviour instructions live in the starter message, which gains: 'If a status says paused, expired, replaced, full or on hold, stop and tell me.'

| status | fixed note |
|---|---|
| paused | The handoff service is paused in the app. Nothing was accepted or changed. |
| session_expired | This session code has expired. Nothing was accepted. |
| session_replaced | This session code was replaced by a newer chat. Nothing was accepted. |
| session_full | This chat has reached its limit of jobs. |
| app_unavailable | The app has no open canvas window, so this job cannot advance. Nothing was accepted. |
| held | This handoff is on hold in the app. Nothing was accepted. |
| rate_limited | Too many calls. retryAfterSeconds says when to repeat the same call. |
| unauthorized | The session code was not accepted. (uniform, as realistic.js:41) |
| queue_empty (nothing released) | No handoffs are released to this service. |

## 6. Controls

Every control lists State, IPC, UI hook and Tests (IDs are in section 9). IPC names are defined in section 8.

### C1 Master toggle and launch policy

Rules:
1. `enabled` is process-scoped. Persisted are only config, limits and prefs. After every launch `serving` is `off` unless `prefs.autoServeOnLaunch` (default false), which waits for the first canvas window plus 20 s and then shows a notification 'Handoff bridge started'.
2. Refusals with fixed codes: env INFINITE_CANVAS_HANDOFF_BRIDGE=0 gives `disabled_by_env`; INFINITE_CANVAS_E2E=1 or isBackgroundE2E (backgroundE2e.js:6-8) gives `e2e`; not app.isPackaged unless INFINITE_CANVAS_HANDOFF_BRIDGE_DEV=1 gives `unpackaged`; no configured hostname or tunnel gives `no_hostname` (no default hostname string may exist in source: fail loudly, never fake); binary checks are C13.
3. Enable shows one native confirm (buttons ['Cancel','Enable'], Cancel = index 0 = default, so the stub's {response:0} cancels). Text: destination hostname; 'the service stays reachable until you disable it or quit'; that nothing is visible to ChatGPT until you release jobs; cloudflared path and first 12 hex of its SHA-256; current lapse values. Only then: bind 127.0.0.1 (exclusive), start tunnel, self-probe the public protected-resource URL through the tunnel, set `live`. Any failure tears down and sets `error` with a fixed code.
4. Disable needs no confirm. Teardown order: refuse new RPCs, await in-flight get/submit up to 10 s (a commit point is never aborted), stop tunnel (C13), close listener and all connections, clear volatile state, audit. Quit runs the same routine as a fourth entry of the allSettled at main.js:1361-1365.

| | |
|---|---|
| State | PersistedState.prefs.autoServeOnLaunch; Volatile.serving |
| IPC | set-enabled, set-prefs, get-status |
| UI | Settings > HandoffBridgeSetup toggle; Tray item 'Disable bridge'; app menu 'Handoff Bridge > Disable' |
| Tests | XT-C1-1 to XT-C1-4 |

### C2 Release set (replaces Start; per-job routing)

Rules:
1. Nothing is served that is not released. Membership never comes from disk discovery, the dock manifest or a renderer publish (a renderer unmount publishes [] and must not change anything).
2. `release` input: at most 10 items in the set (APPLICATION_HANDOFF_LIMIT, applicationHandoffDock.js:33); jobId matches JOB_ID_RE (localAiApplication.js:5243); canvasFilePath absolute with no NUL; label NFKC-normalised, invisibles and newlines stripped (port cleanText, oauth.js:137-143), at most 60 chars, display only.
3. One native confirm per release batch lists: count, each label and canvas file basename on one escaped line, destination hostname, 'your career file, the listing and any drafts go to ChatGPT and pass through Cloudflare', and the lapse time. Cancel releases nothing.
4. Lapse: `lapsesAt = releasedAt + releaseTtlHours`. On lapse the lane becomes `held('lapsed')`, is never deleted, and re-release needs the confirm again. Removal also happens on saved or gone status and on Unrelease (an in-flight submit completes).
5. Routing: submit routes by the served-code index of the lane (at most 16 codes), exact match, never normalised or upper-cased, never by response.jobId (the app's echo check needs that field, localAiApplication.js:3248-3251 per design). Unknown code returns `unknown_handoff` with no app call. get has no job selector (design-tools.js:107).
6. Result projection is a whitelist: handoffCode, stage, attempt, prompt (verbatim), corrections, correctionPrompt, remaining counts, instructions. `draft`, `localJob`, `folder`, `canvasFilePath` are never serialised.
7. Containment: canvasFilePath is renderer-reported (main.js:1197-1200) and is not a trust boundary. Real containment is assertRealJobDirectory (localAiApplication.js:5250-5259), manifest ownership (:8754-8761) and the native confirm that shows file names.
8. A lane is assigned to the active epoch when first served; per epoch at most jobsPerChat lanes (C3).

| | |
|---|---|
| State | Volatile.releases; Release fields above |
| IPC | release, unrelease, get-status; main to renderer event application-changed {jobId} |
| UI | HandoffBridgePanel job checklist, 'Send N to ChatGPT', 'Send all pending', per-job 'Remove'; a lapse countdown per job |
| Tests | XT-C2-1 to XT-C2-6 |

### C3 Chat epochs (one active chat, per-chat key)

Rules:
1. Key: 10 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, formatted XXXXX-XXXXX (realistic.js:143-148), CSPRNG. Main keeps only sha256(key) after building the starter; comparison uses timingSafeEqual on digests. The key exists in plaintext only in the starter text handed to the clipboard.
2. One active epoch. `new-chat` mints a new key, retires the previous (keep 3 retired digests), resets jobsAssigned, sets `expiresAt = now + chatKeyMaxAgeHours`. Refused unless serving is `live` (or paused for idle) and at least one release exists.
3. Retired key: `session_replaced`, counted separately, never an anomaly. Unknown key with a valid token: uniform `unauthorized`, counted toward key-burst (C8). Expired: `session_expired`.
4. jobsPerChat cap: a lane not yet assigned when the epoch already holds jobsPerChat lanes returns `session_full` even if more jobs are released. This is a count-based bound on what a stolen key can read.
5. Starter text is built and copied by main (clipboard.writeText in main). The starter follows the measured wording of server.js starterFor (non-A plugin text) plus the stop clause. Clipboard is cleared after clipboardClearSeconds only if clipboard.readText() still equals the starter (never clobbers a later copy). The 'continue' starter reuses the key and is refused when no live epoch exists.
6. No secret crosses IPC: new-chat returns {copied, epochAgeMinutes}; the renderer never sees key or starter.

| | |
|---|---|
| State | Volatile.epochs; limits.chatKeyMaxAgeHours, jobsPerChat, clipboardClearSeconds |
| IPC | new-chat {kind:'new'|'continue'} |
| UI | Panel buttons 'Copy starter (new chat)' and 'Copy continue'; chip 'chat key expires in 21 h, 1 of 2 jobs used' |
| Tests | XT-C3-1 to XT-C3-6 |

### C4 Link policy (OAuth)

Port oauth.js (Node built-ins only) with these changes; its 100-step suite is the base of the product suite.

| # | Rule |
|---|---|
| 1 | Client: only `https://chatgpt.com/oauth/client.json` (constant list; adding another needs a code change). Fetch with the ported guarded fetcher (HTTPS, no port, no userinfo, no redirects, JSON only, 16 KB, 3 s, DNS guard for non-public addresses, concurrency 4), cached for the pairing window. Document must have client_id equal to the URL, the request's redirect in redirect_uris, no secret, and `none` among supported methods. |
| 2 | Redirect: exactly `https://chatgpt.com/connector_platform_oauth_redirect`. Delete DEFAULT_REDIRECTS' second pattern, the static client, DCR, `/oauth/register` and `registration_endpoint` from the product (advertisement removal is gate G4). |
| 3 | PKCE S256 only, `iss` on every authorization response, `resource` bound to https://<host>/mcp, tokens only in the Authorization header: ported unchanged. |
| 4 | Lifetimes per section 5.2. Refresh has two clocks: idleExpiresAt (sliding) and absoluteExpiresAt (from consent). Either expiring gives invalid_grant; ChatGPT shows the Reconnect card [M]. |
| 5 | Single grant: at most one active family. Completing a consent revokes any existing family (audit `link_replaced`), retires the epoch and clears allowedSources. |
| 6 | Security events emitted to the exposure controller (never logged with values): `refresh-reuse` (reuse outside grace, family revoked), `code-reuse` (replay that revoked a live family), `refresh-expired`, `token-revoked-by-client`. |
| 7 | Source prefix: /24 for IPv4, /48 for IPv6, from CF-Connecting-IP only (X-Forwarded-For is client-appendable). Seeded from the code-exchange request. Policy alert (audit + banner) or enforce (pause `source-new`). |
| 8 | Client authentication stays public. Optional G1 hardening: advertise private_key_jwt with RS256, verify the assertion with the jwks_uri fetched through the guarded fetcher (cache 1 h): iss and sub equal the client id, aud is the token endpoint, exp within 5 minutes, jti replay cache. Require it only if ChatGPT demonstrably signs. |
| 9 | Persistence and locking as ported (hashes only, fsync before responding to issuance or revocation, sealed grace blob, pid lock, grants bound to the resource). |
| 10 | ChatGPT Disconnect calls /oauth/revoke [M RESULTS.md:167]: audit `link_revoked_by_client`, status unlinked. Deleting the plugin is not assumed to revoke [U]. |

| | |
|---|---|
| State | PersistedState.link and .as; limits.refreshIdleDays, grantMaxAgeDays; prefs.sourcePolicy |
| IPC | get-status (link block), set-limits, set-prefs, revoke-all |
| UI | Setup: link state, grant age, 'expires in', source prefix list; Panel banner 'ChatGPT link needs renewing' |
| Tests | XT-C4-1 to XT-C4-8 |

### C5 Pairing window (the only human binding)

Rules in order:
1. A window opens only through `open-pairing` (main dialog) or the reconnect prompt (rule 8). One window at a time; a second open replaces it and kills the old code. Length 10 minutes.
2. Code: 10 symbols of the 32-symbol alphabet, formatted XXXXX-XXXXX (50 bits), CSPRNG, stored as sha256, single use, checked in constant time, shown only in a main-owned native dialog with 'Do not share your screen while this is open'. Never logged or returned by IPC.
3. Learning this Mac's address: when the window opens, main GETs the public protected-resource URL twice, forcing IPv4 and IPv6, with header `x-ic-probe: <nonce>.<hmac(nonce, per-boot key)>`. The listener records CF-Connecting-IP for a request whose header verifies, giving `ownEgress`. A forged header from anyone else never verifies. If no probe succeeds the window does not open (`probe_failed`): the tunnel is not working anyway.
4. GET /oauth/authorize requires an open window. When pairingNetworkCheck is `enforce`, CF-Connecting-IP must be in ownEgress, otherwise 403 with no transaction, no CIMD fetch and no dialog. Then the CIMD check; then the single pending request (a newer request from the same network replaces the older). Main then shows a second native dialog: 'ChatGPT asked to link (request 7QK2). Type the code on the page that shows 7QK2.'
5. POST /oauth/authorize requires the same network check, the transaction and the code. Five wrong codes per window close it (`pairing_locked`). Success consumes the code, issues a 60 s authorization code and redirects with `iss` and `state`.
6. Success applies C4 rule 5 and shows a native dialog: 'ChatGPT linked. The bridge is <live|paused>'. After Revoke all the dialog offers Resume or Stay paused.
7. The consent page keeps the ported hardening (CSP default-src none, form-action self plus the pinned redirect origin, frame DENY, no-store, no-referrer) and 'the code is on the Mac' wording.
8. Reconnect hint: when a refresh presents a token from the linked family that has expired by idle or absolute age, main may show a non-modal notification 'ChatGPT link expired. Open Connect ChatGPT.' It never opens a window itself and is triggered only by a presented, formerly valid token (an anonymous caller cannot cause it).

Why the same-network check is safe against griefing: a stranger's browser fails it at GET, so a stranger can neither occupy the single request slot nor force the window closed. Measured support [M]: in the lab log the consent browser and curl shared one address while ChatGPT's backend came from 52.255.111.x. Limits: VPN or proxy split routing, a phone on cellular, or dual-stack mismatch fail closed with an instructive page; Settings can turn it off (native confirm). Whether cloudflared passes CF-Connecting-IP intact and both families probe correctly is gate G6.

| | |
|---|---|
| State | Volatile.pairing; prefs.pairingNetworkCheck |
| IPC | open-pairing, set-prefs |
| UI | Setup 'Connect ChatGPT' button; Tray item 'Connect ChatGPT...' when unlinked; runbook line 'do not pair while screen sharing' |
| Tests | XT-C5-1 to XT-C5-7 |

### C6 Public surface (unauthenticated exposure)

| Method and path | Unauthenticated result | Work done | Body read |
|---|---|---|---|
| GET, HEAD /.well-known/oauth-protected-resource and .../mcp | 200 static JSON (resource, authorization_servers, scopes_supported [handoff], bearer_methods_supported) | none | no |
| GET, HEAD /.well-known/oauth-authorization-server, /.well-known/openid-configuration (+ /mcp forms) | 200 static JSON, no registration_endpoint (G4), S256 only, iss parameter supported, client_id_metadata_document_supported | none | no |
| OPTIONS on the above | 204 with CORS * (public documents) | none | no |
| POST, GET, DELETE /mcp without a valid bearer | 401 + WWW-Authenticate Bearer resource_metadata=..., scope=... (error only when a token was presented) | one constant-time digest scan over at most a handful of tokens | no |
| GET /oauth/authorize | 403 page unless a window is open (and network check passes); nothing created or fetched when closed | none when closed | no |
| POST /oauth/authorize | 403 page unless window open | txn and code check | at most 64 KB, only when open |
| POST /oauth/token | OAuth JSON error; failures draw the failure bucket | client and grant lookup | at most 64 KB |
| POST /oauth/revoke | 200 {} always (RFC 7009) | token lookup | at most 64 KB |
| everything else (including /healthz, /canary/*, /oauth/register, wrong Host) | 404 uniform JSON | none | no |

Rules: Host must equal the configured hostname (lowercase, no port; a mismatch is the same 404 and never echoes the Host). `Origin` present on /mcp, /oauth/token, /oauth/revoke gives 403 once gate G5 confirms ChatGPT sends none. /mcp POST requires `content-type: application/json`. No CORS except the public documents. Cache-Control no-store everywhere. JSON parsed once into validated known-key shapes with no merge or Object.assign of parsed input. Nothing logs req.url. Bind 127.0.0.1 with exclusive true.

| | |
|---|---|
| State | none (stateless routing); counters in Volatile.windows |
| IPC | none |
| UI | Panel and Tray show only counts: 'anonymous requests rejected today' |
| Tests | XT-C6-1 to XT-C6-4 |

### C7 Load shedding and rate limits

1. http.Server: maxConnections 64, headersTimeout 10 s, requestTimeout 30 s, keepAliveTimeout 5 s, maxHeadersCount 50, in-flight cap 24 (503 without reading the body).
2. Unauthenticated aggregate bucket: 100 requests per second, burst 200; beyond that 503 before routing.
3. Authenticated per-grant bucket: rateSustainedPerMin 60, burst 60, giving `rate_limited` with retryAfterSeconds. Measured legitimate peak is 16 per 60 s across 5 chats, 4 in 5 s.
4. Submit semaphore of 2; get hold at most 10 s, cancelled when the client aborts [M: ChatGPT abandons at about 60 s].
5. Deliberately absent: closing the listener under flood (it would give strangers a kill switch). A Cloudflare rate rule for the path set /mcp, /oauth/*, /.well-known/* is recommended [U on plan limits].

| | |
|---|---|
| State | Volatile.windows buckets |
| IPC | none; counters via get-status |
| UI | Panel diagnostics row (rate-limited count) |
| Tests | XT-C7-1 to XT-C7-4 |

### C8 Anomaly auto-pause

Principle: only events that require a valid credential can pause. Anonymous noise, invalid tokens, unknown client ids and wrong keys presented without a valid token only increment counters.

| Kind | Trigger (authenticated only) | Effect | Resume |
|---|---|---|---|
| refresh-reuse | refresh token reused outside the 60 s grace (family revoked) | pause; retire epoch; link gone | native confirm plus new pairing |
| code-reuse | authorization code replay that revoked a live family | same | same |
| key-burst | 5 unknown-key calls with a valid token in 10 min (retired keys excluded) | pause | native confirm |
| lane-probe | 5 `unknown_handoff` or `misrouted` results in 10 min with valid token and key (legit rate was 0 in 124 lab submits) | pause | native confirm |
| rate-burst | 50 `rate_limited` results in 60 s | pause | native confirm |
| cap-trip | 3 lanes held by the rejection or junk cap within 60 min | pause | native confirm |
| source-new | valid token from a prefix outside allowedSources with sourcePolicy enforce | pause | native confirm showing the prefix and 'Add and resume' |

Effects of any auto-pause: state `paused`, audit event, generic notification 'Handoff bridge paused. Open Infinite Canvas.', Tray alarm glyph, Dock badge, panel banner with the reason enum and counts. Counters are in-memory sliding windows; thresholds live in limits.js. Acknowledge clears only the alarm glyph.

| | |
|---|---|
| State | Volatile.windows counters; Volatile.pause |
| IPC | pause, resume, ack-anomaly, get-status |
| UI | Panel banner with Resume; Tray 'Resume...' item; notification |
| Tests | XT-C8-1 to XT-C8-5 |

### C9 Deadline engine: lapses and idle pause

One idempotent `tick(now)` evaluates pairing expiry, release lapses, epoch expiry, idle pause, link clocks (informational) and audit rotation. It runs at the top of every request and status read and from a 15 s interval (unref'd). All deadlines are absolute wall-clock epoch times so macOS sleep is counted; tests use a fake clock with timers disabled.

Idle pause: precondition serving `live` AND (at least one non-terminal release OR an active epoch). `lastActivityAt` is the last valid authenticated tool call OR the last native-confirmed user action (release, new chat, resume, pair). When `now - lastActivityAt >= idlePauseMinutes`, state becomes `paused('idle')`. Resume is one plain click, or any native-confirmed release or New chat. Value 0 turns it off (native confirm to set).

| | |
|---|---|
| State | limits.idlePauseMinutes, releaseTtlHours, chatKeyMaxAgeHours; Volatile.lastActivityAt |
| IPC | set-limits, resume |
| UI | Setup limit fields; Panel countdown chips |
| Tests | XT-C9-1 to XT-C9-5 |

### C10 Emergency controls: Pause, Resume, Revoke all, Disable

- Pause: state `paused('user')`. tools/call returns `paused`, tools/list and OAuth refresh keep working, an in-flight submit finishes (a commit point is never aborted). No confirm.
- Resume: from user or idle pause, no confirm. From an anomaly pause, a native confirm naming the reason, counts and time (Cancel default). From `revoked`, blocked until a new link exists.
- Revoke all (no confirm, so it works in an emergency; the panel adds a two-step button): 1) refuse new RPCs, state `paused('revoked')`; 2) revoke every family, access and refresh token, delete authorization codes, close the pairing window; 3) fsync state.json; 4) retire the epoch and clear all releases (consent records die with the link); 5) audit `revoked_all`; 6) answer the caller only after step 3 is durable. ChatGPT then sees 401, refresh gives invalid_grant, and shows the Reconnect card [M]. Honest scope: data already sent stays in ChatGPT chats; Revoke all is not deleting the plugin or the chats.
- Disable: C1 teardown.
- All four are callable from the Tray and app menu without any renderer.

| | |
|---|---|
| State | Volatile.pause; PersistedState.as (wiped on revoke) |
| IPC | pause, resume, revoke-all, set-enabled(false) |
| UI | Tray menu, app menu 'Handoff Bridge', Panel buttons, Setup 'Revoke all' |
| Tests | XT-C10-1 to XT-C10-4 |

### C11 Visibility: status indicator and last call

Sources of truth: main's `snapshot()` (section 8 StatusSnapshot), pushed on every change and every 15 s.

| Surface | Behaviour |
|---|---|
| Tray (macOS menu bar) | exists iff enabled. Glyph: idle-live (outline), active-live (filled, a call in the last 60 s), paused, alarm (!). The glyph says live only when tunnel.state is `up`. Tooltip: 'Handoff bridge: live. Last call 12 s ago (get_handoff, served). Released 2. Key expires in 21 h.' Menu: status lines, Pause or Resume, Revoke all, Connect ChatGPT (when unlinked), Open Infinite Canvas, Disable bridge. Icons are embedded PNG data URIs (no new asset files). |
| Dock badge | none when live; pause glyph when paused; '!' on alarm (optional chaining, absent in the stub) |
| App menu | 'Handoff Bridge' submenu with the same actions |
| Panel pill and popover | states Ready, Live, Working, Paused, Needs you, Not linked; last call with tool, outcome enum, age and source prefix; releases with lane and lapse countdown; anomalies (last 5) |
| Nudges | native notification when live with no authenticated call for 24 h and again at 72 h: 'Handoff bridge has been idle. Turn it off?' |

Rules: every status text states observed facts (the repo rule: assert only what is known); notifications use generic text because lock screens can show them.

| | |
|---|---|
| State | none of its own; derived |
| IPC | get-status; main to renderer `handoff-bridge:status` |
| UI | as above; pure functions `snapshotToTray` (main) and `snapshotToPill` (src/utils/handoffBridgeStatus.js) |
| Tests | XT-C11-1 to XT-C11-4 |

### C12 Logging, audit and telemetry

| Sink | May contain | Never contains |
|---|---|---|
| App logger ring (feeds bug reports) | `[HandoffBridge] <enum code>` only | any field value, message, stack, URL |
| Audit ledger `<userData>/handoff-bridge/audit.jsonl` (0600, rotate at 1 MiB, keep 2) | per authenticated call: t, tool, outcome enum, stage enum, argBytes, resultBytes, ms, grantFp (8 hex), epochFp (4 hex of sha256(key)), source prefix (/24 or /48), tokenLeftSec; anomaly and control events (kind, counts) | prompt, response, handoff code, chat key, token, pairing code, jobId, canvas path, label, client assertion, anonymous callers' addresses |
| Anonymous traffic | counters by route and status class | per-event records or IPs |
| cloudflared | its own log file (0600, --loglevel warn) read by a line filter that maps known lines to state enums | forwarding raw lines to the app logger |
| Status snapshot and IPC returns | enums, counts, timestamps, prefixes | any secret (key, tokens, codes, starter text) |
| Native dialogs | hostname, labels, file basenames, the pairing code (pairing dialog only) | keys, tokens |
| Bug report | counters and enums (Phase 2) | anything above; add the configured hostname to redactReportUrl and redactReportUrlsInText as `<bridge-host>` |

Rules: `log.js` accepts `(code: enum, fields: number or enum values)` only. A source-scan test bans `.message`, `.stack`, `req.url`, and template literals inside log calls in the directory (V8's JSON.parse errors quote body fragments). The lab's near-miss session logging is dropped.

| | |
|---|---|
| State | audit.jsonl; logger |
| IPC | get-status returns the last 200 audit entries as metadata |
| UI | Panel 'Activity' list |
| Tests | XT-C12-1 to XT-C12-4 |

### C13 Tunnel supervision (D6)

| # | Control |
|---|---|
| T1 | Binary: no PATH lookup. Candidates: configured absolute path, /opt/homebrew/bin/cloudflared, /usr/local/bin/cloudflared. realpath; regular file; executable; owner is root or the current user; not group- or world-writable; parent directory owned by root or the current user and not world-writable. Otherwise `binary_untrusted`. |
| T2 | Approval: SHA-256 recorded at Enable through the native confirm. A different hash at any later start gives `binary_changed` and a re-approval confirm (a Homebrew upgrade costs one click). The binary is not executed before the hash matches an approved value. |
| T3 | Config: app-generated from a fixed template in `<userData>/handoff-bridge/` (0700 directory, 0600 file, tmp+rename). Every value validated (uuid regex; hostname regex for lower-case DNS labels; credentials path absolute with no control characters; port integer 1024 to 65535) and emitted with JSON.stringify (valid YAML, so no injection). Ingress: hostname to the origin, catch-all http_status:404. |
| T4 | Spawn: argv array, shell false, stdio ignored, scrubbed environment (PATH=/usr/bin:/bin, HOME, TMPDIR only; nothing from the app's process.env), no secret in argv (credentials-file mode, never --token), quiet log level with its own 0600 log file. Flags must be verified against the installed version (G6). |
| T5 | Orphan-proofing: the process is started through a constant wrapper: `/bin/sh -c 'app=$1; shift; "$@" & c=$!; while kill -0 "$app" 2>/dev/null; do sleep 2; done; kill "$c" 2>/dev/null; wait "$c"' sh <app pid> <cloudflared> <args...>` with `detached: true` so a graceful stop signals the process group. All variable values are positional arguments, never interpolated. A crash or SIGKILL of the app stops cloudflared within about 2 s. |
| T6 | Reaper at launch: read tunnel.json (pid, start time, config path). If that pid is alive and `ps -o lstart=,command= -p <pid>` shows our config path and a matching start time, signal its group. Never kill a cloudflared that does not carry our config path (Jack's manual lab tunnel is left alone). |
| T7 | Origin: the app binds 127.0.0.1 on an ephemeral port BEFORE writing the config and starting the tunnel, so no other process can hold that port and an orphan cannot point at a stale one. Prefer a unix socket in a 0700 directory if the installed version supports `unix:` ingress (G6). The existing single-instance lock (main.js:246) prevents a second app instance from binding. |
| T8 | Credentials: the JSON file is referenced by path only; refuse if group- or world-readable or not owned by the user; never read, copy or log its content. Warn (status field `certPresent`) when ~/.cloudflared/cert.pem exists. |
| T9 | Health: probe the public protected-resource URL every 60 s (probe header as in C5); 3 failures gives `degraded`; restart with backoff 5, 15, 60 s, at most 5 per hour, then `error`. A rogue second connector is not detectable from the origin (accepted). |
| T10 | Runbook: production hostname label random (about 20 hex characters), unlike the guessable bridge. and bridge-lab.; dedicated Cloudflare account with hardware-key 2FA, registrar transfer lock, DNSSEC state noted, cert.pem deleted, credentials 0400 or 0600. |

| | |
|---|---|
| State | Volatile tunnel record {state, pid, startedAt, sha256, origin}; `<userData>/handoff-bridge/tunnel.json` (pid, start time, config path only) |
| IPC | get-status (tunnel block); set-enabled |
| UI | Setup 'Tunnel' section: binary path, approved hash prefix, credentials path, certPresent warning; Tray tooltip uses tunnel.state |
| Tests | XT-C13-1 to XT-C13-7 |

### C14 Push lane gating (D4)

1. Default-deny task allowlist constant (a new task is paste-only until named). A task is a candidate only after its prompt is inspected for what it carries. Never bridgeable: attachmentPaths non-empty, grounded (web-search) tasks, marketplace-*, price-*, vision-*, resume-parse, career-file-extract, and anything whose record has a non-empty initialResponse or draft. Job scoring carries a candidate-evidence block derived from the career corpus plus scraped listings (jobs.js:2549-2555), so it is PII-bearing like application prompts.
2. Release unit is a RUN (record.runId, nonApiAi.js:1982): main lists pending runs as {ordinal, task label enum, batchTotal, pending count} (no prompt text, no ids); a native confirm names the task labels and counts and states that career-derived evidence and scraped listings go to ChatGPT and Cloudflare. Lapse as C2. Push records are never ambient: a run that starts after the release is not covered.
3. Eligibility also requires: sender alive, not settling, responseSchema present. Codes are echo checks, not capabilities (N12): authorization for push is token + key + release + record identity; tombstones are keyed (requestId, code) and consulted after the live registry.
4. Per-epoch caps apply (bytes budget and a batches-per-chat cap set from measurement); the per-grant rate bucket applies.
5. Integrity note: accepted push answers steer ranking without per-batch human review; the allowlist starts with tasks whose output Jack later reviews, and a task is added only with a differential parity test (design section 12 PARITY).

| | |
|---|---|
| State | Volatile.pushReleases; PUSH_ALLOWLIST constant; the additive nonApiAi.js seam from design section 7 (listBridgeableNonApiAiHandoffs, submitNonApiAiResponseForBridge) |
| IPC | release-push, unrelease-push |
| UI | Panel 'Scoring runs' list with 'Send this run to ChatGPT' |
| Tests | XT-C14-1 to XT-C14-4 |

### C15 Renderer trust boundary: native-confirm matrix

| IPC | Raises exposure | Native confirm | Works without renderer |
|---|---|---|---|
| set-enabled(true) | yes | yes (C1) | no |
| set-enabled(false) | no | no | yes (Tray, menu) |
| open-pairing | yes | native dialog shows the code | no |
| release, release-push | yes | yes (C2, C14) | no |
| unrelease, unrelease-push | no | no | no |
| new-chat | mints a key (useless without a token OpenAI holds) | no | no |
| pause | no | no | yes |
| resume (user or idle pause) | restores consented state | no | yes |
| resume (anomaly pause) | yes | yes | yes |
| revoke-all | no | no | yes |
| set-limits, set-prefs | conditional | yes if any value increases exposure, sets 0, weakens the network check or sourcePolicy, or sets autoServeOnLaunch true | no |
| get-status, ack-anomaly | no | no | no |

Native confirm implementation: main-owned dialog.showMessageBox, buttons [Cancel, Confirm], defaultId 0, cancelId 0, injected as `ui.confirm(spec)` so tests supply a fake; the stub default {response:0} cancels.

### C16 Window and power states

1. Zero canvas windows: lanes answer `app_unavailable` and the Tray shows 'no window'; serving resumes when a window exists (canvasWindows is main.js module state; macOS keeps the app alive with none, N9). This is a hold, not an anomaly.
2. powerMonitor (optional-chained, absent in the stub, injected): 'suspend' records the time; 'resume' re-runs the tunnel health probe; the gap counts as idle (C9); nothing re-pairs or re-arms by itself. Screen lock changes nothing.
3. No powerSaveBlocker in Phase 1 (unmeasured E10).

| | |
|---|---|
| State | Volatile.hold; suspendedAt |
| IPC | get-status |
| UI | Tray and Panel 'no window' chip |
| Tests | XT-C16-1 to XT-C16-3 |

## 7. Control matrix

| Control | Bounds scenarios | Timer-like? | Needs native confirm |
|---|---|---|---|
| C1 toggle and launch | S1, S12 | no | enable, autoServe |
| C2 release set | S6, S12, S14, S16 | lapse 24 h (0 allowed) | release |
| C3 chat epochs | S3, S5, S6, S7, S14 | key max age 24 h (0 allowed) | none |
| C4 link policy | S3, S4, S9, S14 | idle 7 d, absolute 30 d | none |
| C5 pairing | S2 | window 10 min | code dialog |
| C6 public surface | S1, S9, S10 | no | no |
| C7 shedding | S1, S15 | no | no |
| C8 anomaly pause | S3, S4, S5, S8 | no | resume |
| C9 deadline engine | S12 | idle pause 180 min (0 allowed) | limits |
| C10 emergency controls | all | no | anomaly resume |
| C11 visibility | S12, S17 | nudges | no |
| C12 logging | S17 | rotation | no |
| C13 tunnel | S10, S13 | health probe | binary approval |
| C14 push gating | S16 | lapse | release-push |
| C15 renderer boundary | S11 | no | matrix |
| C16 window and power | S12 | no | no |

## 8. IPC contract

Style follows existing channels (kebab-case invoke handlers registered from a register function, preload one-liners). Channel prefix `handoff-bridge:`; preload names are camelCase. Every handler validates argument shape and returns `{ok:true, ...}` or `{ok:false, code}` with a fixed code from: disabled_by_env, e2e, unpackaged, no_hostname, binary_untrusted, binary_changed, credentials_unsafe, probe_failed, tunnel_failed, port_unavailable, cancelled, not_linked, not_live, too_many, invalid_argument, busy. Nothing throws to callers.

| Channel | Preload | Arguments | Returns |
|---|---|---|---|
| handoff-bridge:get-status | handoffBridgeGetStatus | none | StatusSnapshot |
| handoff-bridge:set-enabled | handoffBridgeSetEnabled | {enabled:boolean} | Result |
| handoff-bridge:open-pairing | handoffBridgeOpenPairing | none | Result |
| handoff-bridge:release | handoffBridgeRelease | {items:[{jobId, canvasFilePath, label}]} | Result + {released:n} |
| handoff-bridge:unrelease | handoffBridgeUnrelease | {jobId} | Result |
| handoff-bridge:release-push | handoffBridgeReleasePush | {runs:[ordinal]} | Result |
| handoff-bridge:unrelease-push | handoffBridgeUnreleasePush | {run:ordinal} | Result |
| handoff-bridge:new-chat | handoffBridgeNewChat | {kind:'new'|'continue'} | {ok, copied, epochAgeMinutes} (no key) |
| handoff-bridge:pause | handoffBridgePause | none | Result |
| handoff-bridge:resume | handoffBridgeResume | none | Result |
| handoff-bridge:revoke-all | handoffBridgeRevokeAll | none | Result |
| handoff-bridge:set-limits | handoffBridgeSetLimits | partial Limits | Result + snapshot |
| handoff-bridge:set-prefs | handoffBridgeSetPrefs | partial prefs | Result + snapshot |
| handoff-bridge:ack-anomaly | handoffBridgeAckAnomaly | {id} | Result |

Events to renderer: `handoff-bridge:status` (StatusSnapshot; preload `onHandoffBridgeStatus`) and `handoff-bridge:application-changed` {jobId} (preload `onHandoffBridgeApplicationChanged`), which the panel turns into requestApplicationHandoffRefresh(jobId) (applicationHandoffDock.js:559).

```
StatusSnapshot = {
  v:1, at,
  enabled, serving:'off'|'starting'|'live'|'paused'|'error',
  pause: null|{reason, by, at, resume:'click'|'confirm'}, hold: null|'no-window',
  tunnel: { state:'down'|'starting'|'up'|'degraded'|'error', since, certPresent, binary:'ok'|'changed'|'untrusted'|'missing' },
  link: { state:'unlinked'|'linked'|'expired', grantAgeMs, idleLeftMs, absoluteLeftMs, sourcePolicy, sources:[prefix] },
  pairing: null|{ expiresAt, requestPending },
  chat: null|{ epochAgeMs, expiresInMs|null, jobsAssigned, jobsCap },
  releases:[{ jobId, kind:'application', lane, heldReason|null, lapsesInMs|null }],
  push: { releasedRuns, eligible },
  lastCall: null|{ at, tool, outcome, source, tokenLeftSec },
  anomalies:[{ id, kind, at, acknowledged }],   // last 5
  counters24h:{ authedCalls, anonymousRejected, rateLimited, keyMisses, rejections },
  windows:n, limits, prefs                        // no secrets anywhere
}
```

Main-only controller API used by Tray and menu without IPC: `pause()`, `resume()`, `revokeAll()`, `disable()`, `openPanel()`, `openPairing()`.

Pure module contract (electron/ipc/handoffBridge/exposure.js, everything injected: now, random, store, ui {confirm, tray, notify, clipboard, dockBadge}, audit, log, windows, tunnel, oauth, engine):
`snapshot()`, `tick()`, `gate(ctx) -> {allow:true, lane, epoch} | {allow:false, status, noteKey, count?}`, `onAnonymous(kind)`, `onSecurityEvent(evt)`, `enable()`, `disable()`, `pause(by, reason)`, `resume()`, `revokeAll()`, `release(items)`, `unrelease(jobId)`, `newChat(kind)`.

## 9. Test catalogue

Files (all pure DI, no port bound, no process spawned, registered in scripts/test-runner.js with the file name beside the group; names globally unique; must pass on Node 22 with the electron stubs): scripts/tests/handoff-bridge-exposure.js (C1, C2, C3, C8, C9, C10, C11, C15, C16), scripts/tests/handoff-bridge-oauth.js (C4, C5, ported lab suite), scripts/tests/handoff-bridge-http.js (C6, C7), scripts/tests/handoff-bridge-tunnel.js (C13), scripts/tests/handoff-bridge-privacy.js (C12), and push cases beside the existing non-api-ai suite (C14). Fake clock and fake ui/tray/clipboard/spawn/fs throughout.

C1
- XT-C1-1 default off: fresh state has serving off, bind and spawn spies never called; env=0, E2E, unpackaged and missing hostname give disabled_by_env, e2e, unpackaged, no_hostname; a source scan finds no default hostname literal.
- XT-C1-2 enable needs a native confirm: the stub default {response:0} returns cancelled with no side effects; response 1 binds, spawns, probes, reaches live.
- XT-C1-3 relaunch: remembered config does not auto-serve; autoServeOnLaunch waits for the first window plus 20 s on the fake clock.
- XT-C1-4 disable and quit teardown order recorded by spies (refuse RPC, await in-flight, stop tunnel, close listener); an in-flight submit completes.

C2
- XT-C2-1 unreleased work is never served: empty release set gives queue_empty with the fixed note and the app get/submit spies never called.
- XT-C2-2 release validation: cancel releases nothing; 11 items give too_many; bad jobId or relative path give invalid_argument; labels with newlines, bidi and 300 characters are sanitised in the dialog text.
- XT-C2-3 lapse on a fake-clock jump with no ticks: lane held('lapsed'), get returns held, no app call; re-release needs the confirm.
- XT-C2-4 submit with a code of an unreleased lane, a case-changed code or a stale code returns unknown_handoff or duplicate with the app submit spy not called.
- XT-C2-5 saved or gone lanes are removed; unrelease removes; an in-flight submit completes.
- XT-C2-6 projection: served result keys are a subset of the whitelist; draft, localJob, folder, canvasFilePath never appear even when the app record carries them.

C3
- XT-C3-1 New chat rotation: old key gives session_replaced, not counted; unknown key gives uniform unauthorized and counts; comparison goes through timingSafeEqual (spy).
- XT-C3-2 jobsPerChat 2: the third released job returns session_full.
- XT-C3-4 expiry: a 25 h fake-clock jump gives session_expired without any timer firing; 0 disables.
- XT-C3-4 starter: contains the key once and the stop clause; clipboard is cleared after 120 s only when unchanged (fake clipboard).
- XT-C3-5 no secret over IPC: new-chat and get-status returns contain neither key nor starter (sentinel).
- XT-C3-6 continue without a live epoch gives no_active_chat.

C4
- XT-C4-1 CIMD pin: the captured real document is accepted; any other chatgpt.com path is refused before any fetch; other hosts refused; a redirect other than the pinned one is a page error, never a redirect.
- XT-C4-2 no DCR or static client: /oauth/register is 404, metadata has no registration_endpoint, source scan finds no static-client code.
- XT-C4-3 lifetimes: access 3600 in the token response; idle clock slides on refresh; absolute 30 d is hard; grace 60 s replay returns the identical pair; reuse after grace revokes and emits refresh-reuse.
- XT-C4-4 single grant: a second consent revokes the first (old tokens 401, audit link_replaced).
- XT-C4-5 persistence: state.json mode 0600, no raw token (grep), written and fsynced before the response.
- XT-C4-6 source prefix: IPv4 /24 and IPv6 /48 computed from CF-Connecting-IP only; alert writes audit; enforce pauses; user agent is ignored.
- XT-C4-7 client revoke marks the link unlinked; nothing assumes plugin deletion revokes.
- XT-C4-8 (behind G1) signed assertion verification: alg none, bad signature, wrong aud, expired, replayed jti all rejected.

C5
- XT-C5-1 code: 10 symbols from the 32-symbol alphabet, one live code, reopening kills the old, 10-minute expiry, single use.
- XT-C5-2 closed authorize: no window gives 403 with no fetch, no dialog, no transaction, under a flood.
- XT-C5-3 same-network: mismatch gives 403 with no transaction, no fetch, no dialog; match creates one transaction; a probe header with a bad HMAC adds nothing to ownEgress; enforce off path works.
- XT-C5-4 single request: a second GET replaces the first and a POST on the replaced one fails.
- XT-C5-5 five wrong codes close the window; the right code afterwards is refused.
- XT-C5-6 success: redirect carries code, state and iss; PKCE and resource binding hold; consent page headers as ported.
- XT-C5-7 the pairing code appears only in the pairing dialog spec (sentinel over logs, snapshot, IPC, audit).

C6
- XT-C6-1 route matrix: every method x path x auth combination in the C6 table gives the listed status and body shape; /healthz, /canary/x, /oauth/register and wrong Host give the uniform 404.
- XT-C6-2 Host pin, Origin reject on /mcp, application/json required, no CORS outside well-known, no-store.
- XT-C6-3 a spy on req 'data' shows unauthenticated /mcp requests never read the body.
- XT-C6-4 source scan: http, mcp, oauth, preflight, framing import only node:http, node:crypto, node:net and siblings (the guarded CIMD fetcher lives in its own module with node:https and node:dns); no fs, child_process, electron, eval, new Function; no Object.assign of parsed input.

C7
- XT-C7-1 in-flight cap and aggregate bucket return 503 without reading bodies.
- XT-C7-2 per-grant bucket returns rate_limited; 50 in 60 s trips rate-burst.
- XT-C7-3 replay of a synthetic arrival pattern with the measured maximum (16 calls in 60 s, 28 in 120 s, 5 chats) never limits.
- XT-C7-4 a held get is cancelled when the client aborts and never exceeds 10 s.

C8
- XT-C8-1 anonymous cannot pause: 10,000 requests with no token, invalid tokens, wrong client ids and wrong keys without a token leave state unchanged; only counters move.
- XT-C8-2 each anomaly triggers at exactly its threshold (n-1 does not, n does) and its window slides.
- XT-C8-3 pause effects: tools/call gives paused, tools/list and refresh still work, an in-flight submit completes; refresh-reuse also retires the epoch.
- XT-C8-4 resume from an anomaly needs a native confirm (Cancel keeps it paused); after refresh-reuse a new link is required.
- XT-C8-5 the notification text is generic; the audit line carries kind and counts only (sentinel).

C9
- XT-C9-1 a 30 h fake-clock jump with no interval ticks: the first request applies lapses, key expiry and idle pause.
- XT-C9-2 idle preconditions and activity sources; resume by a confirmed release.
- XT-C9-3 0 disables each timer and raising a limit needs a native confirm.
- XT-C9-4 the interval is unref'd and close leaves no timer (child-process check ported from the lab suite).
- XT-C9-5 a simulated sleep gap counts as idle.

C10
- XT-C10-1 pause and resume semantics per section 6.
- XT-C10-2 revoke all: every token 401, refresh invalid_grant, pairing closed, epoch retired, releases cleared, the state file read at the moment the call resolves holds no live token, audit written, caller answered only after fsync.
- XT-C10-3 Tray and menu handlers work with the renderer absent.
- XT-C10-4 revoke all is idempotent and works while off.

C11
- XT-C11-1 snapshotToTray truth table: tunnel not up never shows live; alarm outranks paused outranks active.
- XT-C11-2 snapshots contain no secret and carry lastCall fields (sentinel).
- XT-C11-3 nudges fire at 24 h and 72 h of no authenticated call.
- XT-C11-4 snapshotToPill (src/utils/handoffBridgeStatus.js) states table.

C12
- XT-C12-1 sentinel run: a scripted full session with sentinels in token, key, code, prompt, response, jobId, path, label, assertion, pairing code and anonymous address; assert absence in the logger ring, audit lines, snapshots, IPC returns, tray and menu templates, notification text and dialog text, except the pairing dialog (code) and the release dialog (labels).
- XT-C12-2 source scan bans .message, .stack, req.url and template literals in log calls.
- XT-C12-3 the configured hostname is redacted in redactReportUrl and redactReportUrlsInText output.
- XT-C12-4 audit rotation at 1 MiB keeping 2 files, mode 0600.

C13
- XT-C13-1 binary trust matrix on fake stat results (owner, mode bits, parent directory, symlink).
- XT-C13-2 a changed SHA-256 refuses start until re-approved.
- XT-C13-3 config golden file; hostile inputs (newline, colon, hash, ampersand, quote, spaces, path traversal) are rejected or JSON-quoted.
- XT-C13-4 spawn shape: argv array, shell false, scrubbed environment, no secret in argv, wrapper script is a constant string with values only as positional arguments.
- XT-C13-5 reaper decision table on fake ps output (ours, foreign, dead, pid reuse).
- XT-C13-6 credentials mode and owner checks; certPresent flag.
- XT-C13-7 health probe and restart-budget state machine on the fake clock.

C14
- XT-C14-1 eligibility table: attachments, grounded, settling, non-allowlisted task, destroyed sender, unreleased run give not listed; released allowlisted gives listed.
- XT-C14-2 release confirm, lapse, and a run started after the release is not covered.
- XT-C14-3 recurring 6-char codes: tombstones keyed by (requestId, code) consulted after the live registry.
- XT-C14-4 the existing non-api-ai suite stays unchanged and green (exactly-three log-line pin, abortListener pin).

C15
- XT-C15-1 for every IPC: with a cancelling confirm, exposure-raising calls leave state unchanged; lowering calls never invoke confirm.
- XT-C15-2 no IPC return contains a secret (sentinel).

C16
- XT-C16-1 zero windows gives app_unavailable; a window opens and serving resumes; not counted as an anomaly.
- XT-C16-2 suspend and resume: the gap counts as idle, resume re-probes, nothing re-arms.
- XT-C16-3 (manual) a second app launch does not bind.

Manual gates (in addition to design section 12): M1 Tray and Dock states by eye with two released jobs and a live chat; M2 Force Quit: cloudflared gone within 5 s and no listener (lsof), then a relaunch reaps any survivor; M3 `ps` shows no secret in any argv; M4 sleep, lid close and wake with an outstanding handoff; M5 packaged .app from Finder (minimal PATH) enables, pairs and probes; M6 pairing with the network check on the real network, then through a VPN; M7 Revoke all and Reconnect card round trip with ChatGPT; M8 idle pause fires on a shortened setting and a confirmed release lifts it.

## 10. Measurement gates (Phase 1, before enforcing the marked defaults)

| Gate | Question | Method | Decides |
|---|---|---|---|
| G1 | Does ChatGPT send signed private_key_jwt assertions if the AS advertises them? | Lab AS advertises none plus private_key_jwt RS256; log presence of client_assertion (no values) | Whether XT-C4-8 and requiring signed assertions ship (removes the bearer-refresh weakness) |
| G2 | Does tools/call carry a conversation or user identifier in _meta? | Log _meta key names only for the first 20 calls | Chat identity to detect two chats on one key (S7) |
| G3 | Is the connector egress prefix stable? | 14 days of audit prefixes in alert mode | Flip sourcePolicy default to enforce |
| G4 | Does omitting registration_endpoint change ChatGPT's linking? | Lab link with and without | Remove the advertisement (C4 rule 2) |
| G5 | Does ChatGPT ever send an Origin header on server calls? | Log presence only | Enforce Origin rejection on /mcp and /oauth/token |
| G6 | cloudflared: flags (--config, --logfile, --no-autoupdate, run <uuid>), unix: ingress, Host preserved, CF-Connecting-IP intact, dual-family probe | Run against the installed version | C13 T4, T7, C5 rule 3 |
| G7 | Reconnect card behaviour while the bridge is paused or unlinked; whether the connector redirect or state changes across reconnect | Lab | C5 rule 8 |
| G8 | Warm-up reset by URL or tool edits, sleep, renderer throttling (already open items E3, E5, E10) | as design | timing expectations only |

## 11. Residual risk Jack accepts, stated plainly

1. Cloudflare and OpenAI read every prompt and answer in plaintext; anyone with local code execution reads everything anyway (L6, L7).
2. Every served prompt contains the career corpus. Release limits which listings and drafts are exposed, not the corpus. A credential holder with the key reads it at the first serve.
3. Prompt injection is bounded only by the model behaving: 0 of 9 canaries is compatible with a failure rate up to about 28%; one model and effort; browsing state never recorded; another tool in the same chat is an exfiltration channel the app cannot police.
4. The link is not account-bound. Any ChatGPT user can point a plugin at the hostname; only the pairing code, the same-network check and the 10-minute window stop a stranger. Screen sharing or shoulder surfing during pairing defeats it.
5. A refresh token is a bearer credential. Theft is noticed only on reuse outside the grace window, by a source-prefix change (alert-only until G3) or by rate and key anomalies. Until G1 there is no client authentication.
6. The hostname is public by nature and, if guessable, scanned constantly. Availability can be degraded by a flood; the app sheds load but has no kill switch for strangers by design.
7. A rogue second connector on the same tunnel, or a hijacked DNS record, is invisible from the origin and can read calls and inject arbitrary tool results into Jack's chats.
8. Grounded but sabotaged answers from a credential holder are possible: application documents are reviewed by Jack before sending; push scores are not reviewed per batch.
9. Timers exist at their defaults (24 h, 24 h, 180 min). Setting them to 0 (literal D5) means a forgotten release and a stale key stay live until Jack acts, and idle never pauses; with autoServeOnLaunch the surface returns after every restart without Jack present.
10. The hand-rolled authorization server is inherently risky code; the mitigations are the ported 100-step suite, the changes above with tests, a /security-review pass and the negative battery before any real data crosses it.
11. Unmeasured: warm-up reset by edits, sleep, renderer throttling, egress stability, real-world scanning volume, whether Cloudflare offers the rate rule on the free plan.

## 12. Break-glass and design-doc edits

Break-glass (Jack): 1) Tray, Revoke all. 2) In ChatGPT, Disconnect the plugin (ChatGPT calls /oauth/revoke) and delete the handoff chats. 3) Disable the bridge. 4) In Cloudflare, delete or rotate the tunnel credential; check the DNS record and registrar lock. 5) Check the audit ledger for unfamiliar source prefixes.

Design doc edits to make when this spec is accepted: rewrite section 8 items 1, 2, 4, 5, 6 and the last two sentences of PUBLIC URL; section 9 STATES, START, END, SLEEP/WAKE, KILL; section 10 T1, T2, T5, T10, INTEGRITY and GET ANNOTATION untouched; decision D5 and D6 rows; section 3 Phase 1 exit criteria (replace 'Force Quit leaves no listener' with XT-C13 and M2); section 14 item 2 (no longer rejected, now contained); add this spec's threat model and constants.

## Files

- `electron/ipc/handoffBridge/exposure.js`: NEW. Pure controller with everything injected (now, random, store, ui, audit, log, windows, tunnel, oauth, engine): serving state machine, release set, chat epochs, deadline engine tick(), anomaly counters, gate(ctx), snapshot(), pause/resume/revokeAll/enable/disable/release/newChat.
- `electron/ipc/handoffBridge/limits.js`: NEW. Constants and validation for section 5.2 (defaults, ranges, which changes raise exposure), anomaly thresholds, fixed result notes, allowlists.
- `electron/ipc/handoffBridge/oauth.js`: NEW, ported from scripts/chatgpt-handoff-spike/oauth.js with: CIMD pinned to the exact client URL and single redirect; static client, DCR, /oauth/register and registration_endpoint removed; single active family; pairing session object (one 10-char code, single request, wrong-attempt cap per window, network gate hook); idle-sliding plus absolute refresh clocks; grace 60 s; access 3600 s; security events emitted to exposure; revokeAll(); source prefix capture; optional signed-assertion verification behind gate G1.
- `electron/ipc/handoffBridge/cimdFetch.js`: NEW. The guarded fetcher (HTTPS, no redirects, DNS guard, 16 KB, 3 s, concurrency 4) split out so the pre-auth modules import no node:https or node:dns.
- `electron/ipc/handoffBridge/http.js`: NEW. Route table of section 6 C6, Host pin, Origin and content-type rules, shedding and timeouts of C7, no body read before auth, uniform 404; createRequestHandler returns (req,res) so tests bind no port.
- `electron/ipc/handoffBridge/mcp.js, tools.js`: NEW. Stateless JSON-RPC subset and the frozen v2s tool descriptors; results limited to the whitelist projection; new statuses (paused, session_expired, session_replaced, session_full, app_unavailable, held, rate_limited).
- `electron/ipc/handoffBridge/store.js`: NEW. The only fs user for state.json (0600, tmp+rename, fsync before acknowledging issuance or revocation, pid lock, version 2).
- `electron/ipc/handoffBridge/audit.js, log.js`: NEW. Enum-only private logger; audit.jsonl ledger (0600, rotate 1 MiB keep 2) with the C12 field list and source prefixes.
- `electron/ipc/handoffBridge/tunnel.js`: NEW (D6). Binary resolution and trust, SHA-256 approval, config template with JSON-quoted validated values, wrapper spawn with detached process group, reaper, health probe and restart budget, credentials checks, cloudflared line filter.
- `electron/ipc/handoffBridge/native.js, trayIcons.js`: NEW. Injected wrappers for dialog.showMessageBox (Cancel = index 0), Tray with embedded PNG data URIs, dock badge, Notification, clipboard write and conditional clear, powerMonitor; snapshotToTray pure function.
- `electron/ipc/handoffBridge/index.js`: NEW. registerHandoffBridgeHandlers({notify, getCanvasWindows}) with the section 8 IPC handlers, idempotent, never throws to callers, launch policy of C1, app menu items for Tray and menu actions.
- `electron/ipc/handoffBridge/sources/application.js`: NEW. Only importer of getLocalApplicationHandoff, submitLocalApplicationHandoff, localApplicationStatus; whitelist projection; served-code index routing.
- `electron/ipc/handoffBridge/sources/push.js`: NEW (D4). Run-level release, default-deny allowlist, eligibility predicate; uses the additive nonApiAi.js seam of design section 7.
- `electron/main.js`: Additive hunks only: import; registerHandoffBridgeHandlers() in try/catch after registerNonApiAiHandlers() (:1178); stopHandoffBridge() as a fourth entry of the quit allSettled (:1361-1365); Handoff Bridge submenu in setupApplicationMenu; optional autoServeOnLaunch scheduling after the first createWindow.
- `electron/preload.js`: Additive one-liners for the section 8 channels and the two listeners; no secret crosses IPC.
- `electron/ipc/bugReport/helpers.js`: Additive: redact the configured bridge hostname in redactReportUrl and redactReportUrlsInText.
- `electron/ipc/nonApiAi.js`: Additive Phase 3 seam already in the design (acceptNonApiAiResponse hoist with reason enum, listBridgeableNonApiAiHandoffs, submitNonApiAiResponseForBridge, onNonApiAiEvent, record.grounded); needed for D4 and gated by C14; no change to the IPC handler's return shape.
- `src/components/HandoffBridgePanel.jsx`: NEW. Pill and popover: status, last call, release checklist with lapse countdowns, Send N / Send all pending, Pause/Resume, New chat and Continue, Revoke all (two-step), anomaly banner, Activity list, scoring-run releases. Inline useRef/useState, hooks above early returns.
- `src/components/HandoffBridgeSetup.jsx (inside SettingsPanel.jsx)`: NEW. Enable toggle, tunnel binary and credentials section, hostname, limits and prefs fields, Connect ChatGPT, Revoke all, runbook link; avoid the labels scripts/electron-smoke.js asserts absent.
- `src/utils/handoffBridgeStatus.js, handoffBridgeQueue.js`: NEW. snapshotToPill pure function and the dock-item to bridge-state mapper.
- `src/App.jsx`: One import and one element after <NonApiAiDialog /> (line 34).
- `scripts/tests/handoff-bridge-exposure.js, handoff-bridge-oauth.js, handoff-bridge-http.js, handoff-bridge-tunnel.js, handoff-bridge-privacy.js`: NEW test files for section 9; registered in scripts/test-runner.js.
- `scripts/test-runner.js`: Register the new test files (file name beside each group).
- `docs/chatgpt-mcp-bridge-design.md`: Rewrite the sections listed in spec section 12; record D5 and D6 resolutions; add the constants table.
- `docs/chatgpt-bridge.md (runbook)`: NEW. Tunnel setup with credentials-file mode, random production label, Cloudflare path rules and rate rule, cert.pem deletion, pairing hygiene (no screen sharing), break-glass steps.

## Tests

- XT-C1-1 default off; env, E2E, unpackaged and no-hostname refusals; no default hostname literal in source
- XT-C1-2 Enable needs a native confirm; stub {response:0} cancels with no side effects
- XT-C1-3 relaunch never auto-serves; autoServeOnLaunch waits for first window plus 20 s
- XT-C1-4 Disable and quit teardown order; in-flight submit completes
- XT-C2-1 unreleased work never served; app get/submit spies untouched
- XT-C2-2 release validation and label sanitisation; cancel releases nothing; more than 10 refused
- XT-C2-3 lapse on a fake-clock jump holds the lane; re-release needs a confirm
- XT-C2-4 submit routing by served code, exact match, unknown code makes no app call
- XT-C2-5 saved or gone lanes removed; unrelease; in-flight submit completes
- XT-C2-6 result projection whitelist: no draft, localJob, folder, canvasFilePath
- XT-C3-1 New chat rotation: session_replaced not an anomaly; unknown key uniform unauthorized; timingSafeEqual
- XT-C3-2 jobsPerChat cap gives session_full
- XT-C3-3 chat key max age 25 h jump gives session_expired without timers; 0 disables
- XT-C3-4 starter text contents and conditional clipboard clear
- XT-C3-5 no key or starter over IPC (sentinel)
- XT-C3-6 continue without a live epoch refused
- XT-C4-1 CIMD pinned to the exact client URL and single redirect (captured real document fixture)
- XT-C4-2 no DCR, static client or registration_endpoint
- XT-C4-3 lifetimes: 3600 s access, sliding idle, absolute 30 d, 60 s grace, reuse revokes and emits refresh-reuse
- XT-C4-4 single grant: second consent revokes the first
- XT-C4-5 state file 0600, hashes only, fsync before response
- XT-C4-6 source prefix /24 and /48 from CF-Connecting-IP; alert versus enforce
- XT-C4-7 client revoke marks the link unlinked
- XT-C4-8 (behind G1) signed client assertion verification negatives
- XT-C5-1 pairing code shape, single live code, 10-minute expiry, single use
- XT-C5-2 authorize closed with no window: no fetch, dialog or transaction under flood
- XT-C5-3 same-network check: mismatch creates nothing; forged probe header ignored; enforce off path
- XT-C5-4 single pending request, newest replaces older
- XT-C5-5 five wrong codes close the window
- XT-C5-6 successful pairing redirect with iss and state; PKCE and resource binding; consent page headers
- XT-C5-7 pairing code appears only in the pairing dialog (sentinel)
- XT-C6-1 route matrix table-driven; lab-only routes and wrong Host give uniform 404
- XT-C6-2 Host pin, Origin rejection, JSON content type, no CORS outside well-known
- XT-C6-3 unauthenticated /mcp never reads the body
- XT-C6-4 source scan: pre-auth modules import only node:http, node:crypto, node:net and siblings
- XT-C7-1 in-flight cap and aggregate bucket shed without reading bodies
- XT-C7-2 per-grant bucket and rate-burst trigger
- XT-C7-3 measured arrival pattern (16 per 60 s, 5 chats) never limited
- XT-C7-4 held get cancelled on client abort, at most 10 s
- XT-C8-1 anonymous and invalid-credential noise cannot pause
- XT-C8-2 each anomaly triggers exactly at its threshold and windows slide
- XT-C8-3 pause effects: paused result, tools/list and refresh still work, in-flight completes, epoch retired on reuse
- XT-C8-4 anomaly resume needs a native confirm; new link after refresh-reuse
- XT-C8-5 generic notification text; audit carries kind and counts only
- XT-C9-1 30 h fake-clock jump with no ticks applies lapses, expiry and idle pause
- XT-C9-2 idle preconditions, activity sources, resume by confirmed release
- XT-C9-3 zero disables timers; raising a limit needs a native confirm
- XT-C9-4 interval unref'd; close leaves no timer
- XT-C9-5 simulated sleep gap counts as idle
- XT-C10-1 pause and resume semantics
- XT-C10-2 revoke all: tokens dead, pairing closed, epoch retired, releases cleared, durable before reply
- XT-C10-3 Tray and menu actions work without a renderer
- XT-C10-4 revoke all idempotent and works while off
- XT-C11-1 snapshotToTray truth table (tunnel not up never live; alarm precedence)
- XT-C11-2 snapshot has no secrets and carries lastCall
- XT-C11-3 idle nudges at 24 h and 72 h
- XT-C11-4 snapshotToPill states
- XT-C12-1 sentinel privacy run across logger, audit, snapshot, IPC, tray, notifications, dialogs
- XT-C12-2 source scan bans .message, .stack, req.url and template literals in log calls
- XT-C12-3 hostname redaction in bug-report helpers
- XT-C12-4 audit rotation and mode
- XT-C13-1 binary trust matrix on fake stats
- XT-C13-2 changed SHA-256 refuses start until re-approved
- XT-C13-3 config golden file and hostile-input rejection
- XT-C13-4 spawn shape: argv, shell false, scrubbed env, no secret in argv, constant wrapper
- XT-C13-5 orphan reaper decision table
- XT-C13-6 credentials mode and owner; certPresent flag
- XT-C13-7 health probe and restart budget state machine
- XT-C14-1 push eligibility predicate table
- XT-C14-2 run-level release, lapse, later runs not covered
- XT-C14-3 recurring 6-char codes tombstoned by (requestId, code)
- XT-C14-4 existing non-api-ai suite unchanged and green
- XT-C15-1 native-confirm matrix per IPC
- XT-C15-2 no secret in any IPC return
- XT-C16-1 zero windows gives app_unavailable, not an anomaly
- XT-C16-2 suspend/resume gap counts as idle, resume re-probes, nothing re-arms
- XT-C16-3 (manual) second app instance does not bind
- Manual gates M1 to M8 (Tray/Dock visuals, Force Quit reaping, argv secret check, sleep/wake, packaged app, pairing on real network and VPN, Revoke-all plus Reconnect round trip, idle pause on a shortened setting)
- Measurement gates G1 to G8 in spec section 10 before flipping the marked defaults
- Baseline command: npm test (with the Electron stub); also npx eslint ., npm run build:compile, npm run test:e2e with the bridge absent and inert

## Risks

- The link is not account-bound: ChatGPT's client document has one redirect for every user, so a stranger's plugin looks identical to Jack's at the OAuth level. Only the pairing code, the same-network check and the 10-minute window stand between a stranger and a weeks-long link; screen sharing or shoulder surfing during pairing defeats them.
- A refresh token is a bearer credential and theft inside the 60 s grace window is invisible. Until gate G1 shows ChatGPT will sign assertions, and gate G3 justifies enforcing the source prefix, detection relies on reuse, rate and key anomalies.
- Prompt injection is only bounded by model behaviour: 0 of 9 hostile canaries allows a true failure rate up to about 28% at 95% confidence, on one model and effort, with browsing state never recorded. Every served prompt contains the career corpus, so one successful injection with another tool available exfiltrates it regardless of release limits.
- Cloudflare, OpenAI, a rogue second connector or a hijacked DNS record can read plaintext calls and a rogue origin can inject arbitrary tool results into Jack's chats; none is detectable from the origin. The tunnel credential file and the registrar and Cloudflare accounts are the trust root.
- The public surface exists whenever the app is open. A hostname learner can fingerprint it and flood it; the app sheds load but deliberately has no listener-closing circuit breaker, so legitimate ChatGPT calls can be denied during a flood.
- Timers were kept only on data-bearing items and as a pause; setting them to 0 (literal D5) or enabling autoServeOnLaunch removes the bounds for forgotten releases and stale keys, and makes the surface reappear after every restart without Jack present.
- The pairing same-network check depends on CF-Connecting-IP passing intact through cloudflared and on the browser and the Mac sharing an egress address (VPN, split routing, phone on cellular and dual-stack mismatches fail closed). Untested on the real setup (gates G6, M6).
- Several ChatGPT behaviours the controls lean on are unmeasured: conversation ids in _meta, egress stability, whether removing registration_endpoint changes linking, whether deleting the plugin revokes, Reconnect while paused, warm-up reset, sleep and renderer throttling.
- D4 push handoffs add a large, run-driven data flow with 6-char non-secret codes, sender-bound records and unreviewed integrity impact (scores steer ranking); the allowlist must start small and each task needs prompt inspection and a parity test.
- macOS keeps the process alive with zero windows and jobs finish only in a renderer, so an always-armed bridge can hold released work it cannot advance; handled as a hold, but Jack may see stalled lanes after closing canvases.
- Hand-rolled OAuth and MCP code in the privileged main process is the only parser of untrusted bytes; the port must carry the whole lab suite plus the new tests and get a /security-review pass before any real data crosses it.
- The app spawning cloudflared adds a supervised child, a binary to trust and a credential path; the wrapper watchdog and reaper are untested on macOS and the exact cloudflared flags are unverified.

## Open questions for Jack

- Do you read D5 as 'enabled per app run' (my default: the bridge is off after every launch and one click turns it on), or should it come back by itself after every launch, crash or reboot (autoServeOnLaunch, which means the public surface can be up without you present)?
- Do you accept the release confirm (one native dialog per batch of jobs or scoring runs) as the replacement for Start? Without it, an always-on bridge with a live chat key exposes every pending job; this is the click that makes always-armed acceptable.
- Do you accept the default timers on data-bearing items only: release lapse 24 h, chat-key max age 24 h, idle pause 180 min (pauses, never disables; lifted by any confirmed release or New chat or one Resume click)? Each can be 0 with a native confirm; literal D5 is all three at 0.
- Is one linked ChatGPT connector at a time acceptable (a new pairing replaces and revokes the old link)? It shrinks the target to a single grant and costs nothing unless you create a second plugin.
- Will you rename the production hostname to a random label (about 20 hex characters) instead of the guessable bridge.lullascape.com? It cuts scanner noise and makes the hostname harder to enumerate; it is not a security boundary.
- Push scope (D4): do you approve run-level release (you pick a scoring run in the panel and confirm) instead of a per-hub toggle, and which tasks go on the first allowlist? I recommend starting with job-scoring only after inspecting its prompt, and never any task with attachments, grounding, marketplace or price data.
- Should pairing enforce that your browser and the Mac share the same public network address (default enforce; fails closed on VPN or a phone), or is code-only acceptable?
- Is a new menu-bar (Tray) icon acceptable? It is the only at-a-glance indicator that works with no window open on macOS; without it the fallback is a Dock badge and the app menu.
- Source-prefix policy: alert-only for the first 14 days and then enforce (my default, because the egress evidence is one 12-hour window), or enforce from day one and accept a possible false pause if OpenAI moves its addresses?
