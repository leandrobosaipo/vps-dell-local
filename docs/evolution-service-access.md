# Dell to existing Evolution service access

The existing Evolution Access application remains at its current hostname, DNS,
tunnel and origin. The scoped updater adds one named service token and one
Service Auth policy to that dedicated application. Human policies are preserved
by readback. A shared or changed application is refused before creation.

The Cloudflare administration credential stays on the administrator machine.
Only the new application service credential and the existing JP instance key
are delivered to the Dell. The native instance key is not a read-only role:
`cloudflare/evolution_probe.py` restricts its own use to named GET routes and
never follows a redirect, sends a message or changes a session or configuration.
It is a CLI checker, not a listener, scheduler or transport connected to n8n.

Plan is the default. Applying requires a clean published source commit, a matching
script hash and a fresh private snapshot of the exact app/policies. A token name
collision or partial receipt requires reconciliation, not automatic recreation.
The service token lasts 8760 hours; the private receipt records its actual expiry.

Install the checker as root-owned code under
`/usr/local/libexec/jp-evolution-readonly/`, with mode 0755. Credentials belong in
`/etc/jp-evolution-readonly/access.json`, mode 0600, root-only directory 0700.
Deliver secret values over the existing encrypted administrative stdin channel,
never command arguments, logs, shell history or public Git. Do not replace a
preexisting installation without separately inspecting its receipt.

Rollback removes only the new policy ID and new token ID from the recorded
application/account. Never restore the whole old application or overwrite other
policies. Remove the checker/credential only after verifying no consumer uses it;
this change creates no service and does not need a Windows, VM or container restart.

Validate from Dell: no credential must remain denied; Cloudflare authentication
alone must not bypass the Evolution instance key; both valid layers must return
JSON from connection-state and existing webhook reads. Group metadata needs a
separate successful identity/member proof. HTTP 404 with `Connection Closed`
does not prove that a group ID is missing or changed. `open` can be a cached state.

Keep Evolution on the Mac Mini, keep the JP webhook unchanged and keep the group
silent. A session restart is a separate operational action requiring recoverable
auth data and protection from pending sends. This access change never authorizes
that restart or a production cutover.
