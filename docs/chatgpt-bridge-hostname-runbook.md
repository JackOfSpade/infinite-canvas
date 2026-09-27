# ChatGPT bridge: stable hostname runbook

**Purpose:** operate the Phase 1 bridge on a stable public HTTPS address without putting a tunnel credential in an argument, environment variable, repository, screenshot, chat, or routine backup. This is an operational checklist for Jack. It does not authorize or perform registrar, Cloudflare, DNS, or ChatGPT account changes.

The existing domain is `lullascape.com`, registered at Porkbun and hosted in a dedicated Cloudflare account. `jackwu.ca` and `shuttersheep.com` remain out of scope. The lab hostname is `bridge-lab.lullascape.com`. Production uses one generated `b-<20-lowercase-hex>` label; its concrete value has not yet been generated or created.

## 0. Before any production plugin

Choose the production label once, before creating its DNS route or ChatGPT plugin:

```sh
openssl rand -hex 10
```

Use the result only to form `b-<20-lowercase-hex>.lullascape.com`; for example, the command output is not a credential, but do not paste the resulting production hostname into public tickets or screenshots. Record the selected hostname in the password manager and in the app setup, not in this repository. A hostname change later means a new plugin, a fresh warm-up, and dropped OAuth grants.

The random label reduces scanner noise and pairing-hint spam. It is not an authorization boundary.

### Certificate Transparency correction

Cloudflare's normal edge certificate covers a one-level hostname with a wildcard such as `*.lullascape.com`; issuance of that wildcard certificate does not put the individual `b-...` label in Certificate Transparency. This does not make the hostname secret: DNS, edge traffic, Cloudflare account access, and active scanning can still reveal it. Before production, confirm the certificate behavior and current issuance with `crt.sh`; do not infer it from this runbook alone.

## 1. Domain and DNS handoff status

`lullascape.com` was moved from Porkbun DNS to Cloudflare after removing its old parking/wildcard records. DNSSEC had to be disabled at Porkbun before that nameserver move. Before production, Jack must complete the reverse, safe DNSSEC handoff:

1. In Cloudflare, enable DNSSEC for `lullascape.com` and obtain the DS values Cloudflare displays.
2. At Porkbun, add exactly those DS values at the registrar.
3. Confirm DNSSEC validation after propagation. Do not remove or replace a DS record speculatively; a mismatched DS can make the entire zone fail for validating resolvers.

Do not add a wildcard DNS record. The production route must be only the selected `b-<20 hex>.lullascape.com` hostname. Keep the lab route separate.

## 2. Registrar and Cloudflare account hardening

Before carrying real data, Jack must verify all of the following. These are account-holder actions, not automated application steps.

- Porkbun auto-renew is enabled, the payment method works, and the registration term is at least two years. The currently recorded expiration is 2027-04-29; renew before it becomes a deadline.
- Registrar lock and WHOIS privacy remain enabled. Do not enable email forwarding or URL forwarding for the bridge hostname.
- The dedicated Cloudflare account has a unique password-manager password and hardware-key 2FA (not SMS). Keep its recovery material protected.
- DNSSEC is enabled at Cloudflare and the matching Cloudflare DS record is published at Porkbun, as described above.
- Add a restrictive CAA record that permits the certificate authority Cloudflare documents for this zone. Verify the exact CA value in Cloudflare's current documentation before publishing it; a wrong CAA can prevent renewal.
- Keep Cloudflare Access off for this hostname. ChatGPT cannot complete an Access login flow.
- Keep Bot Fight Mode and AI-bot blocking off for this zone/hostname. The bridge relies on explicit route and source controls, not a generic bot challenge that may block connector traffic.

Cloudflare terminates TLS. A Cloudflare account holder can see zone configuration and DNS, change routes and rules, and may be able to inspect or stream traffic/log data depending on enabled products and permissions. The account, its recovery channels, and anyone with its privileged access are therefore part of the bridge credential trust root. Keep Logpush and unnecessary traffic retention off, restrict account membership, and perform the planned `cloudflared tail --level debug` check before treating debug output as safe.

## 3. Create the named tunnel with a credentials file

Use a dedicated tunnel, for example `infinite-canvas-bridge`. From a local terminal while authenticated to the dedicated Cloudflare account:

```sh
cloudflared tunnel create infinite-canvas-bridge
cloudflared tunnel route dns <tunnel-uuid> b-<20-lowercase-hex>.lullascape.com
chmod 600 "$HOME/.cloudflared/<tunnel-uuid>.json"
dig +short b-<20-lowercase-hex>.lullascape.com @1.1.1.1
```

Record the `<tunnel-uuid>` printed by `tunnel create` and use it for the route command; do not use the tunnel name. With cloudflared 2026.9.3, a non-UUID tunnel argument can resolve to the `credentials-file` in a default config before Cloudflare looks up the supplied name. Confirm in the Cloudflare DNS dashboard that the record target is exactly `<tunnel-uuid>.cfargotunnel.com`; the command output must also report that UUID. Because Cloudflare flattens proxied CNAMEs, public `dig CNAME` can be empty. The ordinary `dig` check should return Cloudflare addresses rather than `NXDOMAIN`. If correcting an already-created DNS record, first confirm the hostname, then rerun the UUID route command with `--overwrite-dns`.

`tunnel create` writes a per-tunnel credential file named `<tunnel-uuid>.json` under `~/.cloudflared`. It contains the tunnel secret. Do not rename it, commit it, attach it, or copy its contents. The repository `.gitignore` does **not** protect an arbitrary `<uuid>.json` credential file; only storage discipline does. If `cloudflared login` was used for setup, delete the account-wide `~/.cloudflared/cert.pem` when it is no longer needed. That certificate is more powerful than the per-tunnel credential file.

For Phase 1, save the selected hostname in Bridge Setup, choose and explicitly approve the `cloudflared` binary copy, then choose the credentials JSON. At enable time the app accepts only an owner-owned, non-symlink UUID-named JSON file with matching `TunnelID` and mode `0400` or `0600`; it writes its own generated `handoff-bridge/tunnel/config.yml` and starts the approved app-owned copy with a credentials-file configuration and a Unix-socket origin. Do not create a launchd service, a shell wrapper, a token environment variable, or a manual foreground connector for the production bridge. Before the app manages a tunnel ID, stop any hand-run lab connector using that same ID. The generated configuration uses this shape:

```yaml
tunnel: <tunnel-uuid>
credentials-file: "/Users/<you>/.cloudflared/<tunnel-uuid>.json"
ingress:
  - hostname: b-<20-lowercase-hex>.lullascape.com
    service: "unix:/Users/<you>/Library/Application Support/infinite-canvas/handoff-bridge/b.sock"
    originRequest:
      httpHostHeader: b-<20-lowercase-hex>.lullascape.com
      connectTimeout: 5s
      keepAliveConnections: 8
      keepAliveTimeout: 30s
  - service: http_status:404
```

The actual app path is chosen from its Electron user-data directory; the example is illustrative. Never place a tunnel token in argv. The app owns its generated configuration and exact run arguments: the tunnel ID is positional, the log level is `info`, the metrics listener is loopback-only, and `--no-autoupdate`, `--grace-period 2s`, `--label infinite-canvas`, and `--management-diagnostics=false` are required.

## 4. Cloudflare edge rules before real data

Create and test the following rules for the production hostname. Rule availability and quotas on the selected Cloudflare plan are unverified; record the result of the X7 check before depending on them.

1. Create a WAF custom rule for the production hostname that allows only `/mcp`, `/oauth/*`, and `/.well-known/*` and blocks every other path. Keep the origin catch-all 404 as a separate backstop.
2. Add a source-range rule for `/mcp`, `/oauth/token`, and `/oauth/revoke`. During S1 through S6 it is **log mode**. Before S7, switch it to enforcement only after validating OpenAI's published connector ranges and the measured source prefixes. Keep `/oauth/authorize` and `/.well-known/*` open so discovery and the human pairing flow work. The in-app policy remains the backstop.
3. Add a rate-limit rule for `/oauth/*` and `/.well-known/*`. It is defense in depth; preserve the application-side limits.
4. Do not put an Access application, generic browser challenge, Bot Fight Mode, or AI-bot blocking in front of the bridge.

The Phase 0 observation was `52.255.111.0/28`, but it is not a permanent authority list. Refresh `OPENAI_CONNECTOR_RANGES` from the published source and the staged measurements before enabling enforcement. A range change can require a re-pair; do not silently widen rules to all Internet traffic just to restore service.

## 5. Plugin creation and warm-up

Only after the packaged app is healthy, the public protected-resource self-probe succeeds, and the production edge rules are ready:

1. Create one ChatGPT MCP app with URL `https://b-<20-lowercase-hex>.lullascape.com/mcp`.
2. Complete the staged S7 checks with synthetic data first: discovery, link, refresh, Disconnect/Reconnect, one drain, and the hostile-input check.
3. Wait at least 30 minutes before treating a newly created plugin or any URL/tool-metadata edit as usable. A URL edit is a warm-up reset.
4. Only then move the range rule from log mode to enforce and proceed to the monitored first real job.

Use a dedicated ChatGPT Project or chat for handoffs, with memory, browsing, and unrelated connected apps configured intentionally. Delete handoff chats when appropriate for the selected data controls. Never paste the pairing code, chat epoch key, OAuth tokens, or tunnel credential into a chat.

## 6. Backup and local credential hygiene

The default safe choice is to keep tunnel credentials and bridge state out of Time Machine. On the Mac that owns the bridge, run the following paths after confirming the app's user-data location:

```sh
tmutil addexclusion "$HOME/.cloudflared"
tmutil addexclusion "$HOME/Library/Application Support/infinite-canvas/handoff-bridge"
```

`tmutil` exclusions are local-machine settings; verify them after an OS migration or a new backup destination. If Jack deliberately needs disaster recovery, store the minimum required credentials in an encrypted, access-controlled backup outside Time Machine, document who can restore it, and understand that restoring a credential restores the ability to run that tunnel. Do not rely on `.gitignore`: it does not cover a tunnel `<uuid>.json` credential file.

Keep the credential file owner-only (`0600`, or `0400` where the setup validator accepts it). Remove stale `cert.pem`, screenshots, terminal history containing sensitive setup material, and abandoned tunnel credentials. Rotate/delete a suspected credential in Cloudflare rather than attempting to redact it from a backup.

## 7. What survives a restart

| Item | After quit, crash, Force Quit, or relaunch |
|---|---|
| Enabled state | Does not survive. The bridge is off after every launch unless its separately persisted, opt-in `autoStart` setting was enabled. |
| Chat epoch key and in-memory chat state | Does not survive. Every chat ends. |
| OAuth link and persisted release/lane state | Can survive, subject to its expiry and the app's persisted state. |
| Restored released lanes | Are held for `restart` unless already held or `needs_user`; they require the per-launch native confirmation before serving. |
| Tunnel setup selections | A credentials-file selection can persist independently. A binary path and its pin persist only together and are never trusted without explicit approval; the credential file itself remains outside bridge state. |
| Running cloudflared child after an app crash | The watchdog should terminate it in under about 5 seconds; the next launch also reaps a verified survivor. |
| `autoStart` | Can bring up the tunnel and OAuth link only. It never restores a chat epoch or serves released work by itself. |

Do not assume a restart resumes a chat. Start a new chat/epoch through the native confirmation and use the generated starter again.

## 8. Recovery from refresh-reuse revocation

`refresh_reuse` is intentionally fail-closed: it revokes the OAuth family, retires the epoch, and pauses the bridge. It can be a real compromise, a false positive, or - before client assertion enforcement is proven - an availability attack by a holder of a stale refresh token from an allowed network. Nothing is exposed while revoked: new protected calls fail, and recovery requires a new pairing at the Mac.

| Situation | Immediate result | Jack's recovery when back at the Mac | Expected downtime |
|---|---|---|---|
| Confirmed or suspected hostile refresh reuse while away | Family revoked; epoch retired; bridge paused; no new handoff data is served. | Treat the credential path and Cloudflare account as suspect; review the security event, rotate/revoke the tunnel credential if indicated, then use Revoke/Forget as appropriate and open a fresh native pairing window. | Until Jack can act, plus about 2 minutes for the re-pair drill. |
| Likely false reuse or interrupted concurrent refresh | Same safe failure; do not try to revive the revoked family. | At the Mac, open pairing deliberately, link a new OAuth family, create a new chat epoch, and verify a synthetic protected request before resuming work. | About 2 minutes at the Mac; no data exposure during the outage. |
| Range rule blocks legitimate connector traffic | Protected calls fail closed; no automatic broadening. | Confirm the observed prefix against OpenAI's published ranges and staged evidence, update the narrow rule/config under change control, then re-pair if required. | Until corrected and re-paired. |

Perform the M20 drill with synthetic data: revoke/reuse, verify that nothing is served, re-pair from the Mac, create a new chat, and measure the recovery. Do not conduct this drill by exposing a real refresh token.

## 9. Reversal ladder

Use the smallest effective step first. Preserve evidence before deleting a possibly compromised credential.

1. **Stop exposure now:** Disable the bridge in Settings or Tray. Confirm the Unix socket is gone and no owned cloudflared process remains.
2. **Remove application authorization:** Revoke all links or use Forget Setup. A revoked link is not restored; use a new pairing if service resumes.
3. **Remove remote reachability:** Disconnect and delete the ChatGPT plugin, then remove the Cloudflare DNS route and tunnel. Deleting the plugin alone does not revoke tokens.
4. **Remove local credentials:** revoke/delete the per-tunnel credential in Cloudflare, then securely remove the local credential file and any account-level `cert.pem` if present. Rotate account recovery material if account compromise is suspected.
5. **Revert software only if required:** revert the bridge controller/renderer wiring, then run the bridge gate suite and verify the bridge is inert. Do not delete unrelated application state.

## 10. Do not

- Do not create or guess a production hostname in source control.
- Do not put a tunnel secret, OAuth token, pairing code, chat key, or credential-file contents in a URL, argument, environment variable, repository, log, bug report, screenshot, or chat.
- Do not use the production hostname for lab or fake-data experimentation.
- Do not move `jackwu.ca` or `shuttersheep.com` to this Cloudflare account.
- Do not weaken DNSSEC, CAA, source rules, rate limits, or account protection just to make a failed connector test pass; diagnose the measured failure first.
