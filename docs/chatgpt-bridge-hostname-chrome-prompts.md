# Claude-in-Chrome prompts: put lullascape.com behind a Cloudflare tunnel

Two stages, because DNSSEC must be off and expired from resolver caches (about 24 hours) before the nameservers change.
Jack does anything involving sign-up, sign-in, email verification, 2FA, CAPTCHA or payment; the agent stops there.

Expected facts (public lookups, 2026-09-26): registrar Porkbun; nameservers `curitiba/fortaleza/maceio/salvador.ns.porkbun.com`; DS record key tag 2371, algorithm 13, digest type 2, digest `6D1A4E2F2362A204566CB67271F6535211A9C2B2226AAC5679FFF128FA0D8CB3`; Porkbun-default records only: apex A to 207.207.210.23/.36/.50, wildcard `*` and `www` CNAMEs to `uixie.porkbun.com`, MX `fwd1`/`fwd2.porkbun.com`, the SPF TXT, and two `_acme-challenge` TXT tokens (stale leftovers of Porkbun's automatic Let's Encrypt wildcard certificate for the link-in-bio redirect: Certificate Transparency shows certs for `*.lullascape.com` + `lullascape.com` issued 2026-07-10 and 2026-09-12; deleting them is safe). No email forwarding is used.

## Between the stages (local checks)

```bash
dig +short DS lullascape.com @1.1.1.1     # must print nothing before Stage 2
dig +short DS lullascape.com @8.8.8.8     # must print nothing before Stage 2
```

## Stage 1: Cloudflare site + Porkbun DNSSEC off

```text
ROLE: You are helping me (Jack) set up DNS for ONE domain: lullascape.com. Work only on that domain, in my logged-in Chrome. Follow the steps literally; do not improvise. If anything differs from what a step says I should see, STOP and report. An honest BLOCKED or INCONCLUSIVE is better than a guess.

WHY: lullascape.com is registered at Porkbun with Porkbun's default DNS. I want Cloudflare (Free plan) to serve its DNS so a Cloudflare Tunnel can later publish https://bridge-lab.lullascape.com to a program on my Mac. The domain has DNSSEC ON at Porkbun, so DNSSEC must be turned OFF at Porkbun BEFORE the nameservers change, and we then wait ~24 hours. THIS PROMPT IS STAGE 1 ONLY: do NOT change nameservers at Porkbun.

HARD RULES
- lullascape.com ONLY. Never touch jackwu.ca, shuttersheep.com or any other domain or account.
- Never type or paste passwords, 2FA or recovery codes, card numbers or API tokens. If a sign-up, sign-in, email-verification, 2FA prompt or CAPTCHA appears, STOP and tell me; I will complete it and say "continue".
- Never buy anything, add a payment method, upgrade a plan or accept an upsell. Free plan only. If payment details are requested, STOP.
- Do not enable DNSSEC anywhere. Do not enable Email Routing, Access, Workers, WAF rules or API tokens. Do not transfer the domain or change the registrar lock.
- Do not put secrets in your reports.
- The UIs change often. Use the visible labels; if a label is missing, use the closest equivalent and say what you used.

STEP 1: Cloudflare, add the site
1a. Open https://dash.cloudflare.com/ . If I am not signed in or no account exists, STOP.
1b. Add the domain: open https://dash.cloudflare.com/?to=/:account/add-site (or use Add > Connect a domain). Enter lullascape.com. Accept the automatic DNS-record scan. Choose the FREE plan. If payment is requested, STOP.
1c. On the DNS-records review screen, write down exactly what was imported (type, name, content, proxy status). I expect ONLY these Porkbun defaults: apex A records for 207.207.210.23, 207.207.210.36, 207.207.210.50 (or one flattened apex record); CNAME * -> uixie.porkbun.com; CNAME www -> uixie.porkbun.com; two TXT records named _acme-challenge (43-character tokens, stale ACME challenge leftovers); MX @ priority 10 fwd1.porkbun.com; MX @ priority 20 fwd2.porkbun.com; TXT @ "v=spf1 include:_spf.porkbun.com ~all". If there is ANY other record, STOP and list it.
1d. Delete the apex A record(s), the * CNAME, the www CNAME, both _acme-challenge TXT records and both MX records (parking, stale-certificate and forwarding defaults I do not use). Edit the TXT SPF record so its content is exactly: v=spf1 -all . Optional, only if easy: add TXT with name _dmarc and content: v=DMARC1; p=reject;
1e. Continue to the screen that shows the two Cloudflare nameservers assigned to this zone (form: something.ns.cloudflare.com). Write both down exactly. Do NOT change anything at Porkbun for this. Leave every other option on its default; do not tick anything that enables DNSSEC.
1f. Finish the wizard and note the zone status text (expect "Pending Nameserver Update" or similar).

STEP 2: Porkbun, turn DNSSEC off
2a. Open https://porkbun.com/account/domainsSpeedy (Account > Domain Management). If I am not signed in, STOP.
2b. Find the row for lullascape.com ONLY. Open its details and find the DNSSEC section. It should list exactly ONE DS record: key tag 2371, algorithm 13, digest type 2, digest 6D1A4E2F2362A204566CB67271F6535211A9C2B2226AAC5679FFF128FA0D8CB3. Copy what you actually see into your report BEFORE deleting anything. If the key tag differs or there is more than one DS record, STOP and report without deleting.
2c. Remove that DS record (disable DNSSEC) for lullascape.com and confirm any dialog.
2d. Reload the page and confirm no DS record is listed for lullascape.com.

STOP HERE. Do nothing else.

REPORT (exactly these fields):
1. Cloudflare nameserver 1 / nameserver 2:
2. Records in the Cloudflare zone after cleanup (type / name / content):
3. DS record removed at Porkbun: YES or NO, with the key tag and digest you saw:
4. Cloudflare zone status text:
5. Anything unexpected, every STOP reason, anything you were unsure about:
VERDICT: DONE, BLOCKED (why) or INCONCLUSIVE (why).
```

## Stage 2: nameservers, zone settings, tunnel (only after 24 hours and the two `dig` checks are empty)

Replace `<NS1>` and `<NS2>` with the two nameservers Stage 1 reported.

```text
ROLE: You are helping me (Jack) finish setting up ONE domain: lullascape.com. Work only on that domain, in my logged-in Chrome. Follow the steps literally; do not improvise. If anything differs from what a step says I should see, STOP and report. An honest BLOCKED or INCONCLUSIVE is better than a guess.

STATE: Stage 1 is done. Cloudflare (Free plan) has the zone with only a TXT record "v=spf1 -all", and DNSSEC is OFF at Porkbun (I have verified with dig that no DS record is visible). The two Cloudflare nameservers for this zone are: <NS1> and <NS2>.

HARD RULES
- lullascape.com ONLY. Never touch jackwu.ca, shuttersheep.com or any other domain or account.
- Never type or paste passwords, 2FA or recovery codes, card numbers or API tokens. On any sign-in, 2FA or CAPTCHA, STOP and tell me.
- Never buy anything, add a payment method, upgrade a plan or accept an upsell. Free plan only. If payment details are requested, STOP.
- THE TUNNEL TOKEN IS A SECRET. Never copy it, read it out, type it anywhere or include any part of it in a report. Leave that page open and tell me it is displayed; I will copy it myself.
- Do not enable DNSSEC. Do not enable Email Routing, Access applications, Workers or API tokens. Do not create any WAF rule. Do not run or install anything.
- The UIs change often. Use the visible labels; if a label is missing, use the closest equivalent and say what you used.

STEP A: Porkbun, point the nameservers at Cloudflare
A1. Open https://porkbun.com/account/domainsSpeedy . Find the row for lullascape.com ONLY and open its details.
A2. First confirm DNSSEC shows NO DS record. If a DS record is present, STOP.
A3. Open Authoritative Nameservers > Edit. Remove Porkbun's four nameservers (curitiba, fortaleza, maceio, salvador .ns.porkbun.com) and enter exactly <NS1> and <NS2> as the only two. Submit.
A4. Reload and report the nameservers now listed.

STEP B: Cloudflare, wait for Active
B1. Open https://dash.cloudflare.com/ , select the lullascape.com site, choose "Check nameservers now" (Re-check). If it is not Active, re-check at most 3 times, 10 minutes apart. If still not Active, STOP and report the exact status text. Do not do anything else until it is Active.

STEP C: Cloudflare zone settings (they can block ChatGPT's connector traffic)
C1. Security > Bots: set Bot Fight Mode to OFF. Turn OFF or set to Allow any "Block AI bots" / "AI Scrapers and Crawlers" / AI Crawl Control blocking. Report each control's exact label and its state before and after.
C2. Confirm DNSSEC is still OFF for the zone. Do not change any other setting.

STEP D: Cloudflare Zero Trust, create the tunnel
D1. Open https://one.dash.cloudflare.com/ . First-time onboarding asks for a team name: use a neutral one such as lullascape . Choose the FREE plan ($0). If it asks for a payment method, STOP.
D2. Networks > Tunnels (newer UI: Networks > Connectors > Cloudflare Tunnels) > Create a tunnel > connector type Cloudflared > name: lullascape-bridge-lab > Save.
D3. Choose macOS. The page will show an install command containing a token. DO NOT run it, copy it or reveal it. Leave the page open and tell me "token displayed". Wait for me to say "token saved", then click Next.

STEP E: publish the hostname
E1. Add a public hostname (newer UI: "Published application routes" > Add): subdomain bridge-lab, domain lullascape.com, path EMPTY, service type HTTP, URL 127.0.0.1:8787 . Save.
E2. In the zone's DNS records, confirm a CNAME named bridge-lab pointing to <uuid>.cfargotunnel.com was created and is Proxied. Report the record (the UUID is fine to report).
E3. Note the tunnel's status (expect Inactive or Down, since no connector is running yet).

STOP HERE. Do nothing else.

REPORT (exactly these fields):
1. Nameservers now at Porkbun:
2. Cloudflare zone status:
3. Bot / AI-bot controls: label, state before, state after:
4. DNSSEC at Cloudflare: OFF or ON:
5. Tunnel name and status; DNS record created for bridge-lab (type / name / content / proxied):
6. Anything unexpected, every STOP reason, anything you were unsure about:
VERDICT: DONE, BLOCKED (why) or INCONCLUSIVE (why).
```

## After Stage 2 (on the Mac; the token never leaves your machine)

```bash
# 1. Start the tunnel connector. Paste the token when prompted (it is not echoed and not saved in shell history).
read -rs TUNNEL_TOKEN && export TUNNEL_TOKEN && cloudflared tunnel run
#    (if this cloudflared version ignores TUNNEL_TOKEN, use: cloudflared tunnel run --token <TOKEN>)

# 2. In another terminal, start the spike server (fake data) on the tunnel's local port:
cd scripts/chatgpt-handoff-spike && JOBS=2 npm start

# 3. Prove the whole path (expect the spike's 404 JSON):
curl -i https://bridge-lab.lullascape.com/
```

## Progress log

**Stage 1: DONE, verified (2026-09-26, about 01:30 EDT).**
- Cloudflare (Free plan) zone for `lullascape.com` created; assigned nameservers **`liv.ns.cloudflare.com`** and **`ram.ns.cloudflare.com`**. Zone contains only `TXT @ "v=spf1 -all"` (the optional `_dmarc` record was skipped). Zone status: "Waiting for your registrar to propagate your new nameservers".
- Porkbun DNSSEC DS record (key tag 2371, algorithm 13, digest type 2) removed. Verified independently at 01:36 EDT: the `.com` registry (`a.gtld-servers.net`) returns no DS for `lullascape.com`, and 1.1.1.1, 8.8.8.8 and 9.9.9.9 return none. Delegation still at Porkbun (`curitiba/fortaleza/maceio/salvador`), as intended.
- Open item: Porkbun's own DNSSEC toggle for the domain still reads ON next to "Registry DNSSEC: 0 records". If Porkbun manages the DS automatically it could re-add it, so turn the toggle OFF (small follow-up prompt) and re-check the registry before Stage 2.
- Stage 2 timing: the safe wait is 24 hours from about 01:30 EDT on 2026-09-26 (the DS TTL is up to a day). The registry and the three big public resolvers are already clean, so waiting until later today is a low residual risk; it only affects a validating resolver that cached the DS in the last 24 hours. A resolver on Jack's own network may have been primed by earlier lookups: for local tests use `dig @1.1.1.1` / `curl --resolve`, or wait.
- Re-check immediately before Stage 2: `dig +norec DS lullascape.com @a.gtld-servers.net` must show `ANSWER: 0`.

**Follow-up done, verified (2026-09-26, 01:42 EDT).** Porkbun's DNSSEC toggle for `lullascape.com` is OFF (persisted after reload, no warning), "Registry DNSSEC" 0 records. Re-verified at the `.com` registry: no DS, delegation still Porkbun x4, 1.1.1.1 / 8.8.8.8 / 9.9.9.9 return no DS. Stage 2 may run any time now with a low residual risk (the strict worst case for a stale cached DS at some validating resolver is 24 hours, until about 01:30 EDT on 2026-09-27); ChatGPT's resolvers are unlikely to hold one because nothing on their side ever resolved this domain.
