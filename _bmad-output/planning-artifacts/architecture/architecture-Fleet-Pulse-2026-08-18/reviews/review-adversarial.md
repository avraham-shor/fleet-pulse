# Adversarial Review — Architecture Spine, FleetPulse

**Lens:** adversarial — construct pairs of epics that each obey every AD to the letter yet build incompatibly. Every surviving pair is a hole to close with a new or tightened AD.
**Spine reviewed:** `ARCHITECTURE-SPINE.md` (draft, 2026-08-18). PRD consulted for grounding.
**Method note:** every attack below was judged against the ACTUAL rule text. Attacks the text already blocks were discarded (one is recorded at the end for transparency).

---

## VERDICT: REVISE — 2 certain integration breaks and 7 likely ones survive the letter of the ADs. The spine's dataflow arrows (AD-1) and its reset/ownership rules (AD-5, AD-8, AD-15) leave the pipeline's internal state, the routes entity, and the client→server WS direction each with either two compliant owners or zero legal paths.

---

## CRITICAL — certain integration break

### C1. `fleet_reset` has no legal path into the pipeline, and the pending coalesce buffer flushes into the wiped store

**Epics:** (7) resilience/degraded × (2) telemetry pipeline.

**Construction A (resilience, fully compliant):** AD-8's rule text is exhaustive: "`fleet_reset` dispatches the one store-wide reset action — wipe fleet, routes, presence, anomaly log, and history; refetch; probe immediately." The resilience builder implements exactly that: a store action. Nothing more is asked. Crucially, AD-1's arrow list ("the only legal import directions are the arrows below") contains **no WS→pipeline edge** — `ws-manager` may call slice actions (WS→STORE) but may not touch `pipeline/`. So the resilience builder *cannot* legally clear pipeline state even if they think of it; the compliant construction leaves the pipeline untouched.

**Construction B (pipeline, fully compliant):** AD-4's ordering/dedupe stage necessarily holds per-truck internal state — the current-newest reading-timestamp cursor, dedupe sets, open FR-8 suspect windows — and AD-5's coalescing commit necessarily holds a buffer of readings awaiting the ≤10/s flush. No AD gives this state a reset hook, and AD-1 forbids anyone outside the SSE path from reaching in. The pipeline builder exposes exactly one entry point (SSE→PIPE) and no `reset()`.

**Divergence at integration:** two certain failures. (a) The coalesce buffer holding pre-reset readings flushes *after* the store wipe — ghost trucks and pre-reset history appear in the "clean" post-reset store, violating FR-33's clean-refresh guarantee. (b) If the server epic restarts its simulation clock on `POST /api/reset` — a compliant choice, since exact wire timestamp semantics are explicitly Deferred and "`contract/` is authoritative wherever the PDF is silent" (AD-13) — every post-reset reading is older than the pipeline's retained cursor, so *all* readings backfill forever and current state freezes permanently. Even with wall-clock timestamps, (a) alone breaks integration, and open suspect windows / stale dedupe sets survive the reset.

**Proposed tightening:** AD-8 — the reset flow is a three-step sequence owned by `app/`: (1) drop the pipeline's pending commit and clear all per-truck pipeline state via an explicit `pipeline.reset()` seam, (2) dispatch the store-wide reset action, (3) refetch/probe; AD-1 gains the corresponding wiring edge (composition root may bridge WS lifecycle events to pipeline lifecycle, and *only* lifecycle).

---

### C2. The route entity has two compliant writers — api-client on 2xx and the WS `route_*` echo — with no precedence rule and no originator-echo rule

**Epics:** (4) routes & concurrency × (1) server.js.

**Construction A (routes, fully compliant):** AD-7: pessimistic UI, "state changes only on 2xx." The routes builder reads this as api-client committing the confirmed route (server body, new version) to the routes slice on 2xx — the AD-1 graph blesses it (`API --> STORE`), and the state-mutation convention lists api-client as a legal caller of slice actions.

**Construction B (server.js, fully compliant):** AD-11 fixes the WS message *set* (`route_assigned`/`_updated`/`_reassigned`) but says nothing about recipients. The server builder broadcasts every route event to **all** connected dispatchers, originator included (the simplest faithful hub) — or, equally compliantly, excludes the originator to avoid double-apply. The convention "route events → routes [slice]" makes the WS manager a second writer of the same entity either way.

**Divergence at integration:**
- *Originator included:* the same mutation lands twice via two paths with no ordering guarantee. Worse: dispatcher A's 2xx (version N+1) can be applied *after* the WS echo of dispatcher B's follow-up change (N+2) — the slice regresses to N+1, the next `If-Match` carries a stale version, and the dispatcher gets a spurious FR-13 conflict dialog attributing a conflict to a change they already have. The routes builder also appends an FR-15 audit entry per lifecycle event → duplicate audit rows for every own mutation.
- *Originator excluded:* FR-15's audit trail is "built from route lifecycle events," so the acting dispatcher's own changes never enter their own audit trail — "nobody knew who did what" reappears for the self case.

Both server constructions and the routes construction obey every AD as written; the spine fixes neither the echo semantics nor write precedence.

**Proposed tightening:** new AD (or AD-7 extension) — the WS route event is the **sole** writer of route state (server always echoes to all, originator included); api-client's 2xx only clears the in-flight indicator; the routes slice action is monotonic by version (a write with `version <=` current is a counted no-op), and audit entries derive only from WS events.

---

## HIGH — likely integration break

### H1. AD-15 orders history backfill "through the pipeline's ordering stage," but AD-1 provides no api-client→pipeline edge

**Epics:** (6) vehicle detail panel × (2) telemetry pipeline.

**Construction A (detail panel):** takes the Deferred backfill-on-open option. AD-15: fetched readings "enter through the pipeline's ordering stage as FR-6 backfill — never straight into charts." But AD-1's only edge into `pipeline/` is `SSE --> PIPE`, and api-client's blessed edge is `API --> STORE`. A builder holding AD-1 as the stricter law commits the fetched history straight to the store — legal per the graph, forbidden per AD-15.
**Construction B (pipeline):** exposes a single ingest entry point wired to the sse-manager, per the graph. No backfill API exists for api-client to call.
**Divergence:** either the detail epic violates AD-15 (unordered, unclassified, undeduplicated history mixed into charts — duplicates when live SSE already delivered the same readings) or it violates AD-1 with an illegal import; two builders resolve the contradiction opposite ways and the history buffer receives entries via two disciplines.
**Tightening:** AD-1 — add an explicit `API --> PIPE` edge restricted to one named `ingestBackfill()` seam; AD-15 cites it.

### H2. `Reading<T>` granularity: per-signal envelopes vs one composite envelope per message — and one merged 300-cap history can't serve both

**Epics:** (2) telemetry pipeline × (6) vehicle detail panel (and (3) fleet overview).

**Construction A (pipeline):** AD-6 makes signals a registry — "adding one = new module + one register call; editing an existing module to accommodate it is a violation." A composite `Reading` whose `value` bundles speed/fuel/temp/position would require editing the composite type for every new signal, so the compliant pipeline emits **per-signal** envelopes, each with its own trust (FR-20 demands per-signal trust: speed suspect while fuel trusted). Store history becomes per-truck-per-signal buffers.
**Construction B (detail/fleet):** AD-15's letter — "the store's bounded **per-truck** history (~300 readings ≈ 10 min)" — reads as one merged per-truck buffer of 300 readings. The detail builder renders sparklines by filtering the merged timeline; the fleet builder draws trails from it.
**Divergence:** shapes clash at the store seam (map of signal buffers vs one array), and the merged variant has a real starvation bug the cap text invites: one 30-reading GPS burst evicts ten minutes' cap-share of fuel/temp history, emptying the FR-21 sparklines the moment failure mode 1 fires.
**Tightening:** AD-15 — history is per-truck **per-signal** `boundedBuffer`s of per-signal `Reading<T>` envelopes; caps per signal live in `shared/constants.js`; the ~300 figure applies per signal (position included).

### H3. Backfilled readings skip the classify stage, so history entries reach widgets with unassigned trust

**Epics:** (2) telemetry pipeline × (3) fleet overview / (6) vehicle detail.

**Construction A (pipeline):** AD-4's fixed order is ingest → order/dedupe → classify → commit, with "older-than-current backfills history, never overwrites state" happening **at the ordering stage**; FR-8 confirms: an older 0% "is discarded upstream and never reopens a window" — i.e., backfills exit before classify. So backfill envelopes get a default trust (`trusted` is the natural default) or an out-of-vocabulary placeholder. Fully compliant with AD-4's letter.
**Construction B (fleet/detail):** AD-3 — every value crossing the boundary is `{value, trust, ...}` and FR-20 carries integrity annotations into history renders; the trail and sparklines color every history point by its trust.
**Divergence:** a batch replaying truck_7's stuck window backfills 999 km/h points labeled trusted (or crashes the TrustBadge on an unknown state); the anomaly log misses them entirely (never classified), so observability disagrees with the chart showing the spike. Rendering an unvalidated raw value as history-truth also breaches FR-5's spirit while both builders obey the AD letters.
**Tightening:** AD-4 — backfills bypass *state update and window bookkeeping* but still pass classification: order stage routes them to classify in stateless mode (plausibility rules only, no window mutation), so every history entry carries a real plausibility trust.

### H4. The dispatcher's own session identity has no owner: presence-slice residence makes reset and the liveness timeout revoke api-client's `dispatcherId`

**Epics:** (5) presence × (4) routes & concurrency.

**Construction A (presence):** AD-7 says api-client "reads `dispatcherId` live from the presence/session state." The presence builder keeps the own-identity as a presence entry like any other (FR-17 shows *all* active dispatchers, self included) and applies FR-19's rules uniformly: no sign of life for 30 s → entry removed. AD-8's reset wipes presence. Fully compliant.
**Construction B (routes):** api-client refuses mutations "with a visible reason while unregistered" whenever the read comes back empty. Fully compliant.
**Divergence:** (a) after `fleet_reset`, presence is wiped and only "refetch" is mandated — re-registration is not — so api-client reads no id and every mutation is refused while the WS is healthily connected; (b) if the server (compliantly — unspecified) doesn't echo a dispatcher's own presence events back, the own entry hits the 30 s liveness timeout mid-shift and mutations die silently-with-a-reason; (c) whether the *server's* presence registry survives `POST /api/reset` is also unspecified — a server that wipes it leaves the client holding an id the server no longer knows, breaking 409 attribution.
**Tightening:** new convention/AD — own-session identity lives in a dedicated session field owned solely by the ws-manager (set on `registered`, cleared on socket loss only), exempt from the liveness sweep and from the reset wipe; `fleet_reset` never invalidates registration on either side.

### H5. No legal UI→WS send path exists for `viewing_truck` and the FR-22 alert send

**Epics:** (6) vehicle detail panel × (5) presence.

**Construction A (detail):** FR-22/FR-18 require the client to *send* — an alert, and viewing state on truck select. AD-1: "`ui/` may import `store/` … and `transport/api-client` — never … the socket managers." The detail builder therefore routes the alert through api-client as an HTTP POST and expects a REST endpoint.
**Construction B (presence):** the presence builder, needing `viewing_truck` (a WS message per AD-11's message set), invents the other legal bridge: UI dispatches a store action recording viewing intent, and the ws-manager subscribes to the store (the WS→STORE import direction, used backwards for reads) to emit the message.
**Divergence:** two different client→server command paths for sibling features; the alert path additionally collides with AD-11's "the contract quietly growing" ban if the brief's alert channel is WS-inbound — the endpoint the detail epic assumes doesn't exist, while the store-subscription bridge the presence epic built is a covert data path AD-1 never named. The spine simply has no upstream arrow for WS sends.
**Tightening:** AD-1 — the ws-manager exposes a typed send-only facade (`sendViewing`, `sendAlert`) that `ui/` may import alongside api-client; add the `UI --> WS(send)` arrow to the graph and forbid transport-subscribing-to-store as a command channel.

### H6. Failure mode 8's synthetic mid-processing reassignment yields a 409 whose "conflicting dispatcher" no client construction can render — and a version bump that may never be broadcast

**Epics:** (1) server.js × (4) routes & concurrency.

**Construction A (server.js):** AD-12 — the quirk scheduler "self-fires the 8 modes"; AD-11 — "409 bodies carry the conflicting dispatcher + current route state." For mode 8 the scheduler must *manufacture* a mid-processing reassignment. Compliant options: attribute it to a phantom `dispatcherId` that was never registered, or to a random real one; and either broadcast the synthetic `route_reassigned` or bump the version silently (nothing in AD-11 says quirk-originated changes broadcast). All four combinations obey the letter.
**Construction B (routes):** `dispatcherId` is "opaque, never a name" (conventions), so the FR-13 conflict view resolves the 409's dispatcher id against the presence slice to display a human name; the routes slice learns version changes only from WS route events (see C2's tightening — this is the *recommended* construction, which makes the hole sharper).
**Divergence:** phantom id → conflict chooser renders an unresolvable attribution (blank/undefined "who"), failing the brief's flagged senior-level design challenge on the exact failure mode built to test it; silent version bump → client version stays stale, every subsequent mutation 409s until the conflict flow force-refreshes, reading as a client bug in the demo.
**Tightening:** AD-11/AD-12 — quirk 8 executes as a *real* reassignment by a permanently registered synthetic "system" dispatcher (present in the presence registry, broadcast normally), and every 409 body carries both `dispatcherId` and display name so the conflict view never depends on a presence lookup.

### H7. The anomaly log has two compliant homes — pipeline-internal buffer vs store obs slice — and only one is reachable by its reader and its reset

**Epics:** (2) telemetry pipeline × (8) observability.

**Construction A (pipeline):** FR-9/AD-3 make the pipeline the writer ("raw rejected values exist only inside anomaly-log entries"). AD-5 compels only "pipeline **output**" through the batched commit — a builder can read the anomaly log as internal bookkeeping, not output, and keep it as a pipeline-local `boundedBuffer` (AD-10 satisfied, framework-free per AD-1).
**Construction B (observability):** AD-1 lets `ui/` read only `store/`; the capability map places Group G in "`store/` obs slice." The anomaly view reads the log from the store, and AD-8's reset wipes "anomaly log" via the store-wide reset action.
**Divergence:** if A wins, the FR-29 view has no legal path to the log (AD-1 bans ui→pipeline) and reset can't wipe it (no WS→PIPE edge — C1 again); if both build, there are two logs with divergent entry shapes (the shape is declared nowhere — not `contract/`, not Deferred), and FR-29's aggregation runs over whichever one its builder found first.
**Tightening:** new AD line — the anomaly log is a store obs-slice collection with a declared entry shape `{ruleId, truckId, rawValue, readingTs, arrivalTs}`; the pipeline emits entries only through the batched commit; the pipeline retains no copy.

---

## MEDIUM — plausible integration break

### M1. The "global" ≤10 commits/s ceiling governs only pipeline output, so WS action floods break NFR-1's verification

**Epics:** (5) presence × (8) observability.
**Construction A (presence):** the convention routes every WS event to a slice action immediately — `dispatcher_viewing` churn and `truck_alert` bursts each cost one store commit; AD-5's coalescer covers "all pipeline output" only, and AD-1 explicitly keeps WS out of the pipeline.
**Construction B (observability):** NFR-1 is "verified by counting state-commits under a synthetic event flood — the coalescing ceiling holds," and the constants table calls the ceiling "≤10 state-commits/sec, **global**."
**Divergence:** the NFR-1 test as specified fails against a fully compliant presence build (or the obs builder quietly scopes the test to SSE-only and the "global" claim in the constants table becomes false); render storms under combined SSE+WS floods remain possible.
**Tightening:** AD-5 — either rename the ceiling "pipeline commits/s" everywhere, or route high-frequency WS actions (`dispatcher_viewing`, `truck_alert`) through the same coalescer; pick one and make the NFR-1 test text match.

### M2. "Time since last accepted reading" vs the arrival clock: an all-rejected stream marks a live truck stale

**Epics:** (2) telemetry pipeline × (3) fleet overview.
**Construction A (pipeline):** AD-3 — rejected raw values "exist only inside anomaly-log entries"; a fully-rejected stretch (truck_7's stuck window if speed is the only signal in those messages) produces no fleet-slice contact, only log entries.
**Construction B (fleet overview / effective-trust selector):** FR-4 — age runs on "time since the last **accepted** reading"; AD-3 — stale layers per-truck on the arrival clock.
**Divergence:** truck_7 shows sensor-fault *and* trips the 10 s staleness badge while actively transmitting — two of the five exactly-one states competing, from two compliant readings of "accepted."
**Tightening:** AD-3/AD-4 — define contact: every ingested (parsed) reading, accepted or rejected, refreshes the truck's arrival clock; staleness means silence, not rejection.

### M3. `boundedBuffer` is capped-at-insertion but never ordered, so backfill insert semantics diverge

**Epics:** (2) telemetry pipeline × (3) fleet overview.
**Construction A (pipeline):** emits backfill commits expecting the history buffer to insert by `readingTs` (FR-6: "timestamp-sorted history").
**Construction B (fleet overview):** implements AD-10's letter — one generic `boundedBuffer`, append + cap at insertion (a ring buffer) — and sorts nothing; AD-10 says nothing about ordering, and the trail "timestamp-sorted" duty is met by sorting at render.
**Divergence:** eviction discards the *oldest-inserted*, not the *oldest-by-timestamp* — a late backfill batch evicts fresher readings; render-sorting also runs per frame over 300×12 entries, the exact cost AD-5 exists to avoid.
**Tightening:** AD-10 — `boundedBuffer` takes an optional ordering key; history buffers are ordered by `readingTs` with eviction from the timestamp-oldest end; sorted insertion happens once, at commit.

---

## LOW — theoretical

### L1. Cold-start `truck_alert` races the first coalesced fleet commit

**Epics:** (5) presence/WS × (3) fleet overview.
**Constructions:** ws-manager dispatches `truck_alert` → fleet slice immediately (convention); the fleet slice, built by the overview epic, indexes alerts under trucks created by the first pipeline commit (delayed up to the coalescing interval) or the fleet fetch. A compliant slice that ignores alerts for unknown trucks silently drops a real alert on cold start; one that throws breaks a widget boundary.
**Divergence window:** sub-second, cold start or post-reset only.
**Tightening:** convention line — the fleet slice's alert action upserts a truck stub for unknown ids; alerts are never dropped for ordering reasons (CM1).

### L2. Obs counters across reset — recorded as *blocked*, kept for transparency

Attempted pair: (7) resilience × (8) observability, diverging on whether reset wipes the obs slice. The rule text blocks it: AD-8's wipe list ("fleet, routes, presence, anomaly log, and history") and FR-33's list ("telemetry history, anomaly log, and cached route and presence state") are both exhaustive and both exclude obs, so two literal builders agree that counters survive. Not a finding; noted only because a *loose* reader of FR-33's "clean state refresh" could still drift — a parenthetical "(obs counters survive reset)" in AD-8 costs one clause.

---

## Attack summary

| # | Sev | Epic pair | Hole |
|---|-----|-----------|------|
| C1 | critical | resilience × pipeline | no legal reset path into pipeline state; pending coalesce flush pollutes wiped store |
| C2 | critical | routes × server.js | two compliant route writers; originator-echo and write precedence unfixed |
| H1 | high | detail × pipeline | AD-15's backfill-through-pipeline contradicts AD-1's edge list |
| H2 | high | pipeline × detail | per-signal vs composite `Reading`; one merged 300-cap starves signals |
| H3 | high | pipeline × fleet/detail | backfills bypass classify → trustless history entries |
| H4 | high | presence × routes | own `dispatcherId` revocable by reset/liveness sweep; server registry across reset unspecified |
| H5 | high | detail × presence | no legal UI→WS send path (`viewing_truck`, FR-22 alert) |
| H6 | high | server.js × routes | quirk-8 phantom conflicting dispatcher; silent synthetic version bump |
| H7 | high | pipeline × observability | anomaly log's residence, shape, and reset reachability unowned |
| M1 | medium | presence × observability | "global" commit ceiling excludes WS actions; NFR-1 test fails a compliant build |
| M2 | medium | pipeline × fleet | "accepted reading" staleness marks an all-rejected live stream stale |
| M3 | medium | pipeline × fleet | boundedBuffer eviction order vs timestamp-sorted backfill |
| L1 | low | presence × fleet | cold-start `truck_alert` for uncommitted truck |
| L2 | low (blocked) | resilience × observability | obs-across-reset — rule text already closes it |

Closing C1, C2, H1, and H5 amounts to completing AD-1's graph (pipeline lifecycle edge, backfill edge, WS-send edge) and naming a single writer per entity (routes, anomaly log, session id) — the spine's paradigm survives intact; its arrow list is simply missing four edges and three ownership sentences.
