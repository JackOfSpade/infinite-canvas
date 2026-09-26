# ChatGPT bridge: stable hostname runbook

**Purpose:** give the bridge (and the Phase 0 tests) a fixed public HTTPS address, `https://bridge.<newdomain>`, so the ChatGPT plugin is created once and never re-pointed.
**Decision (2026-09-26):** a new cheap domain registered at Porkbun; only that domain's nameservers point at a dedicated Cloudflare account; Cloudflare Tunnel (free) does the forwarding. `jackwu.ca` and `shuttersheep.com` are not touched. Background and alternatives: `docs/chatgpt-mcp-bridge-design.md` section 1 and D1/D2.

Only Jack can do the account, payment and DNS steps. Nothing here is automated.

## 1. Pick and register the domain (Porkbun, about 5 minutes)

- Choose a boring, non-descriptive name, and a mainstream TLD such as `.com` or `.ca`. Avoid the very cheapest TLDs (`.xyz`, `.top` and similar): they have a poorer reputation, and ChatGPT has rejected connectors on some domains as "not safe" (judgement, not verified for this case).
- Expect roughly 10-15 USD or CAD per year (unverified). Leave registrar lock on. Turn on the free WHOIS privacy. Do **not** enable email forwarding, URL forwarding or DNSSEC on it.

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
