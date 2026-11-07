# Migration preparation tools

These tools prepare and verify private offline artifacts. They do not switch a
webhook, publish/import a workflow, start an attendance service or send a message.

- `dell_inventory.py`: fixed read-only Cockpit/sudo inventory. Existing project
  credentials are read privately; neither password nor service token enters argv.
- `snapshot.mjs`: copies an authenticated encrypted state into a new private
  staging file, invokes the captured persistence consumer's actual `load()`, and
  reconciles the complete JSON and every array record. It preserves duplicate IDs,
  order, scalar maps, human holds and unknown delivery outcomes. No conversion into
  a different application's data model is implied.
- `workflows.mjs`: allowlisted published-version graph selection, with draft
  preserved separately. Export artifacts have every node disabled, no attached
  credential, no static data and no error-workflow mapping. They are not imported.
  Treat the artifacts as private: node parameters can contain sensitive settings.
- `preflight.mjs`: preparation-only **NO_GO** report, checks captured source/state
  hashes and inert artifacts. It cannot authorize or execute a cutover.
- `check_group_contract.mjs`: fictional quoted group commands against the captured
  support parser/claim logic. Does not start the attendance HTTP server.
- `check_evolution_receipts.mjs`: isolated callbacks against one compiled native
  receipt handler. A failure is a scoped coverage gap, not proof that every other
  webhook/receipt path fails. Does not patch or start Evolution.

Run synthetic safety tests with `node --test migration/test_*.mjs`.

Rust was evaluated for new tooling. These preparation tools reuse native Node
crypto/VM and the existing Python Cockpit transport so the actual JavaScript
persistence reader can be checked without another runtime or an application
rewrite. This is an offline migration tool, not a new production agent framework.

Keep captures, inspected environment values, code from the private runtime,
customer data, original workflow exports and restore files under `private/` with
restricted permissions. Do not upload them to CI or a public repository. Public
CI runs fictional tests only. A snapshot hash is integrity evidence, not proof of
service-wide consistency, backup coverage or target-service compatibility.

## Confirmed scope on 2026-11-07

Evolution API and its authenticated WhatsApp session must remain on the Mac Mini Server. Do not move or recreate the session as part of the Dell pilot. The user approved only the sampled suggested-question answers, not WhatsApp rendering/delivery, integrated scheduling or image delivery. Approved goals now include prices from the corresponding approved image when AppBarber disagrees, multiple formatted WhatsApp messages, automatic booking/change/cancellation and varied approved images. These goals are not evidence of implemented or tested capabilities. See the [infrastructure decision record](../docs/2026-11-07-decisoes-piloto-jp.md) and the linked pilot acceptance record. Preparation remains NO_GO; this documentation update does not activate a channel or change an appointment.

## Cutover contract to implement after a proven target pilot

1. Capture fresh runtime identities and versions. Approve one exact release and
   a human-authorized window. Do not infer it from a successful preflight.
2. Fence only the JP writers, clocks and manual operations in scope. Keep other
   tenants' n8n workflows running. Never replay overdue jobs.
3. Receive new events durably in exactly one intake owner while draining existing
   jobs. If the channel cannot retain/reconcile the gap, the cutover is not ready.
4. Capture the final state/configuration cohort after fencing and confirm no active
   jobs, stale leases or unaccounted in-flight requests. Restore into an isolated
   target; reconcile records and origin IDs, including uncertainty and holds.
5. Transfer exactly one processing/sending responsibility. Preserve the local
   Evolution instance/session. Verify authentication, groups, quoted events,
   participant authorization and receipts without parallel senders.
6. Observe natural, authorized traffic. HTTP success, container health and queue
   acceptance do not prove consumer delivery. Reconcile the same provider ID.
7. For rollback after new events, stop/fence the target, retain its latest event,
   intent and delivery ledgers, then reconcile the delta into a compatible return
   reader. Never restore the old database over newer activity. If state contracts
   are incompatible, retain durable intake and use human coverage; do not guess.

No fixed interruption estimate is supported before drain/recovery measurements.
Never reboot the Windows host as part of this preparation stage.
