# ChatGPT bridge: stable hostname runbook

**Purpose:** give the bridge (and the Phase 0 tests) a fixed public HTTPS address, `https://bridge.<newdomain>`, so the ChatGPT plugin is created once and never re-pointed.
**Decision (2026-09-26):** a new cheap domain registered at Porkbun; only that domain's nameservers point at a dedicated Cloudflare account; Cloudflare Tunnel (free) does the forwarding. `jackwu.ca` and `shuttersheep.com` are not touched. Background and alternatives: `docs/chatgpt-mcp-bridge-design.md` section 1 and D1/D2.

Only Jack can do the account, payment and DNS steps. Nothing here is automated.

## 0. Chosen domain: `lullascape.com` (2026-09-26)

Jack chose an existing domain instead of buying a new one. Findings from public lookups on 2026-09-26:

- Registered at Porkbun on 2026-04-29, expires 2027-04-29, registrar lock on, DNS at Porkbun. A mainstream `.com` with a neutral coined name: it fits the naming guide in section 1.
- Still on Porkbun's defaults, no site of Jack's own: the apex redirects (302) to a Porkbun link-in-bio page `https://lullascape-com.l.ink/`; **any subdomain** is a wildcard CNAME to Porkbun's parking host `uixie.porkbun.com`; MX points at Porkbun email forwarding (`fwd1/fwd2.porkbun.com`) and there is Porkbun's SPF TXT.
- **DNSSEC is on** (a DS record exists at the `.com` registry), as on Jack's other two Porkbun domains.

What moving its DNS to Cloudflare changes, and the ordering it needs:

1. **Decide what to keep.** Moving the nameservers stops the `l.ink` redirect and the parking records unless you recreate them, and stops email forwarding unless you recreate the MX and SPF records. If Jack has no aliases and no use for the `l.ink` page, nothing is lost. **Ask before moving:** does `lullascape.com` have email forwarding aliases or a page you rely on?
2. **Add the domain to Cloudflare first** (Free plan). Cloudflare imports the existing records. Delete the imported apex `A` and wildcard `*` CNAME (the parking records) so they cannot shadow the tunnel. Keep the two MX records and the SPF TXT record only if forwarding is in use.
3. **Turn DNSSEC off at Porkbun** for this domain (remove the DS record) **before** changing nameservers. If the DS record is left in place, validating resolvers get SERVFAIL for the whole domain once Cloudflare's nameservers answer. Then wait about a day for the old DS to expire from resolver caches. Because nothing important depends on this domain, waiting less is a low-risk shortcut if forwarding is not in use, but the tunnel hostname itself would fail to resolve for validating resolvers during any gap, including ChatGPT's if it validates.
4. **Switch the nameservers** at Porkbun to Cloudflare's two and wait for **Active**.
5. **Optional later:** enable DNSSEC in Cloudflare and add its DS record at Porkbun.
6. **Hostnames:** `bridge.lullascape.com` (production) and `bridge-lab.lullascape.com` (lab). Keep every tunnel hostname on a subdomain so a future public site on the apex stays separate.

Jack confirmed there is **no email forwarding** on this domain, so the imported MX and parking records are simply deleted and the SPF record becomes `v=spf1 -all`. Only **`bridge-lab.lullascape.com`** is published first (pointing at the Phase 0 spike on `127.0.0.1:8787`); `bridge.lullascape.com` is created later, for Phase 1.

The literal, step-by-step prompts for Claude in Chrome are in `docs/chatgpt-bridge-hostname-chrome-prompts.md` (Stage 1 now; Stage 2 after about 24 hours).

Sections 2 to 6 below apply unchanged, except that in section 1 the registration steps are already done: do not buy a new domain.

## 1. Pick and register the domain (Porkbun, about 5 minutes)

**Choose it as shared infrastructure for many projects, not as this app's name.** One domain gives unlimited subdomains, and one Cloudflare tunnel can map several hostnames to different local ports, so later projects cost nothing extra.

- **Neutral and boring:** a short (about 6-12 letters), pronounceable, coined or two-unrelated-word name. Not `infinitecanvas`, `resume`, `jobs`, `career` or your own name: the hostname shows up in ChatGPT's plugin settings, DNS and Cloudflare logs and must not describe or expose what runs behind it. Subdomain names are discoverable, so never rely on them being secret; auth is what protects the data.
- **Avoid brand and security words:** `openai`, `chatgpt`, `gpt`, `cloudflare`, `login`, `auth`, `secure`, `verify`, `account`, `pay`. They resemble phishing patterns and can trip safety filters. Also avoid hyphens and digits.
- **Mainstream TLD:** `.com` (safest) or `.ca`. Avoid the very cheapest TLDs (`.xyz`, `.top` and similar): poorer reputation, and ChatGPT has rejected connectors on some domains as "not safe" (judgement, not verified for this case). Expect roughly 10-15 USD or CAD a year (unverified).
- **Separate from anything personal or branded:** do not use `jackwu.ca` or `shuttersheep.com`. A dedicated domain keeps a registrar or Cloudflare problem, and any reputation damage, away from your email and site.
- **Renewal must never lapse:** turn on auto-renew, keep the card valid, consider registering 2 or more years. If a lapsed domain were re-registered by someone else, the ChatGPT plugin would point at them.
- **Registrar settings:** leave registrar lock on, turn on the free WHOIS privacy, and do **not** enable email forwarding, URL forwarding or DNSSEC on it.

**Hostname plan (one level only: Cloudflare's free certificate covers `*.domain` but not `a.b.domain`):**

| Hostname | Use |
|---|---|
| `bridge.<domain>` | The production ChatGPT bridge |
| `bridge-lab.<domain>` | Lab/test copy of the bridge (the design requires a separate lab hostname for tests) |
| `<project>.<domain>` | Any later project, each with its own tunnel and token so one leak never covers the others |

OAuth tokens are bound to the hostname they were issued for, so projects on different subdomains cannot use each other's tokens.

## 2. Dedicated Cloudflare account (about 10 minutes)

- Create a **new** Cloudflare account (not one shared with anything else) with a unique password from your password manager and 2FA. Prefer a hardware key; otherwise an authenticator app, never SMS.
- Cloudflare may ask for a payment method even on the free plan (unverified). The free plan is enough.

## 3. Put the new domain's DNS on Cloudflare (minutes to a few hours of propagation)

1. Cloudflare dashboard: **Add a domain** -> enter the new domain -> **Free** plan. It scans for records (there are none).
2. Cloudflare shows two nameservers. In Porkbun, open that domain's **Authoritative Nameservers** and replace Porkbun's with Cloudflare's two.
3. Wait until Cloudflare shows the domain as **Active**. Nothing else on your Porkbun account changes.

## 4. Create the tunnel (dashboard method, no `cert.pem`)

1. Cloudflare **Zero Trust** -> **Networks** -> **Tunnels** -> **Create a tunnel** -> connector type **Cloudflared** -> name it `infinite-canvas-bridge`.
2. Choose **macOS**. Copy the **tunnel token** from the install command into your password manager. **Treat it as a secret:** anyone holding it can run a connector for your tunnel. Never paste it into chat, a file in the repo or a screenshot.
3. Add a **public hostname**: subdomain `bridge`, your domain, service type **HTTP**, URL `http://127.0.0.1:8787` (the Phase 0 spike port; Phase 1 will use its own port).
4. Run it by hand for the tests (a foreground process that stops when you close the terminal; the always-on launchd agent is a Phase 1/2 decision): `cloudflared tunnel run --token <TOKEN>`.

## 5. Cloudflare zone settings that matter for ChatGPT

- Turn **Bot Fight Mode** and **Block AI bots** **off** for this zone for now. Reports say they return 403 to ChatGPT's connector traffic. Later replace that with a narrow WAF skip rule for `/mcp`, `/oauth/*` and `/.well-known/*`.
- Do **not** put Cloudflare Access (a login page) in front of the hostname: ChatGPT cannot pass it.

## 6. Verify (I can do this once you tell me the hostname)

- With the spike server running on 8787: `curl -i https://bridge.<newdomain>/` should return the spike's `404 {"error":"not_found"}`, proving the whole path (Cloudflare edge -> tunnel -> your Mac -> the server).
- Then create the ChatGPT plugin once at chatgpt.com/plugins -> Add -> Create MCP App with URL `https://bridge.<newdomain>/mcp/<token>` (spike, fake data, "No auth" only) and run the Phase 0 tests on that fixed URL.

## Do not

- Move `jackwu.ca` or `shuttersheep.com` to Cloudflare.
- Reuse this Cloudflare account or domain for anything unrelated.
- Commit the tunnel token, any hostname secret path or the spike's URL token.
