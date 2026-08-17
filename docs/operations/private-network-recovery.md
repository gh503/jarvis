# Private Network Recovery

This runbook restores the phone-to-Gateway path without exposing Harness or
falling back to public HTTP. It applies to a loopback development Gateway, a
local Wi-Fi address, and a trusted private overlay such as Tailscale.

## Health Check

The diagnostic uses only the unauthenticated Gateway health endpoint. It does
not send or print the Owner Token, device credential, session token, or health
response body.

For a local Mac check:

~~~bash
npm run check:gateway
~~~

For a private HTTPS address:

~~~bash
JARVIS_GATEWAY_URL='https://100.64.0.10:3090' \
JARVIS_GATEWAY_TIMEOUT_SECONDS=5 \
npm run check:gateway
~~~

The command succeeds only when the health response identifies Jarvis Gateway,
reports status ok, and matches the URL transport and expected scope. A
non-loopback URL using HTTP, a URL containing credentials, or a URL with a
path/query is rejected before any network request.

## Recovery Order

1. **Gateway stopped**: on the Mac, confirm the Gateway process is running and
   repeat the loopback health check. Do not expose the Harness port.
2. **Local Wi-Fi**: confirm the phone and Mac are on the same trusted network,
   use the Mac's configured private address, and run the HTTPS health check from
   a device that trusts the configured certificate.
3. **Private overlay**: confirm the overlay client reports the Mac as reachable,
   use its assigned private address, and repeat the HTTPS health check. The
   Gateway must remain bound to that explicit address.
4. **TLS failure**: verify the certificate name covers the address or hostname
   used by the phone and that the private key is owner-only. Fix trust or
   certificate configuration; do not downgrade to plaintext HTTP.
5. **PWA stale state**: reopen the PWA, use its refresh control, and wait for a
   fresh Gateway session. The offline snapshot is read-only and must not be
   treated as current.
6. **Expired session**: allow the paired PWA to refresh its session. If the
   Gateway rejects the refresh, start a new owner-approved pairing flow.
7. **Revoked device**: do not retry old credentials. Pair the browser again
   through the Mac owner approval flow; no phone-side Owner Token is needed.
8. **Lost or compromised device**: on the Mac, run `npm run devices -- list`,
   identify the device by its owner-assigned name, then run
   `npm run devices -- revoke --id <device-id>` and confirm with `REVOKE`.
   Keep `JARVIS_OWNER_TOKEN` on the Mac and do not send the device list to a
   public issue or support channel.

## Failure Meaning

| Observation | Meaning | Action |
| --- | --- | --- |
| Connection timeout/refused | Gateway or private route unavailable | Restore the process or private route, then rerun health |
| TLS name/trust error | Certificate does not match the private endpoint | Correct certificate trust/name; keep HTTPS |
| Health scope mismatch | The endpoint is not the configured private boundary | Stop and inspect Gateway binding |
| 401 after health passes | Device/session authentication has expired or was revoked | Refresh once, then re-pair if rejected |
| PWA shows stale data | No current authenticated synchronization | Restore health and session before mutating |

There is no public-internet fallback. Harness stays loopback-only, and the
Stage 3 exit gate still requires named-phone observations over local Wi-Fi and
remote mobile access.
