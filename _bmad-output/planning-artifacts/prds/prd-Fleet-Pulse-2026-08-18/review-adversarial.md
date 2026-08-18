# Adversarial Review — Fleet-Pulse PRD + Addendum

Reviewed: `prd.md`, `addendum.md` (2026-08-18). Reviewer stance: hostile. Every finding below survived a second look against the exact PRD text; style nits were deliberately dropped (separate prose pass). Severity is by impact on a one-developer, ships-tomorrow implementation.

**Verdict:** The PRD is unusually honest about server limits and its counter-metrics are the right instinct — but its flagship safety invariant (CM1) is contradicted by its own speed policy, its anomaly policies are specified in wall-clock language while its ordering policy is specified in reading-timestamp language (they meet head-on in every batch), and the tier plan ships half of FR-26 while deferring the other half to Tier 2. An implementer starting tomorrow will have to invent answers to at least a dozen questions this document claims to have settled.

---

## CRITICAL

### C-1. CM1 is contradicted by FR-7 + the 120 km/h constant: a real overspeed is guaranteed to be suppressed
- **Anchors:** CM1 (§2), FR-7, Tunable Constants (§5: "Plausible max speed 120 km/h ... anything above is flagged as sensor fault"), Test Matrix (§5).
- **The attack:** CM1 states "a real sustained overspeed must still alert. (Tested explicitly.)" FR-7 states any implausible speed is replaced by the last plausible speed plus a "sensor fault" badge, and the constants table makes "implausible" a single hard threshold: *anything* above 120 km/h is a sensor fault. A truck genuinely doing a sustained 135 km/h is therefore, by the PRD's own mechanism, masked forever — the dispatcher sees the last sub-120 reading with a fault badge. That is precisely the "suppressed emergency" CM1 forbids.
- **Compounding:** CM1 says this is "tested explicitly," but the test matrix has exactly one speed case — "999 km/h filtering" — and zero cases for real sustained overspeed. The fuel half of CM1 got three test cases and a whole hybrid policy (FR-8); the speed half got nothing. There is no FR that defines an overspeed alert at all.
- **Why it bites tomorrow:** The developer will implement the constants table literally (that is what a constants table is for) and will pass every listed test while violating a stated counter-metric. Either add a second band (e.g., >120 and ≤ physically-possible = overspeed alert; only physically-impossible values like 999 = sensor fault, possibly with a stuck-value / repeat-count discriminator since the server's failure mode is "stuck at 999 for 5–10s"), or amend CM1 to admit speed emergencies above 120 are out of scope. You cannot keep both texts.

---

## HIGH

### H-1. FR-8's debounce window has no defined clock — it collapses under FR-3 batches and becomes incoherent under FR-6 out-of-order delivery
- **Anchors:** FR-8, FR-6, FR-3, constants (§5: fuel debounce 5s).
- **The attack:** FR-8's cases (b) and (c) are written in wall-clock UX language ("validating badge for a debounce window", "0% persisting beyond the window"), while FR-6 mandates that state is driven by reading timestamps, and FR-3 mandates that 10–30 buffered readings can arrive in one instant. Three unanswered questions, each with a different correct answer:
  1. **Batch replay:** a batch arrives containing 0% at t, t+2, t+4 and recovery at t+6 — all at once. Does the classifier wait 5 wall-clock seconds showing "validating" (absurd: the recovery evidence is already in hand), or classify retrospectively from timestamps (correct, but nowhere stated)? Conversely, a batch containing 0% readings spanning >5s of reading-time proves case (c) instantly — does it alert immediately on arrival? Unstated.
  2. **Out-of-order:** a 0% reading with timestamp t arrives *after* a healthy reading with timestamp t+3 has already been applied. Per FR-6 it must not overwrite current state — but does it enter the classifier? Starting a wall-clock debounce for a reading that timestamp-order says already ended is incoherent; ignoring it entirely means an out-of-order genuine 0% never alerts (CM1 violation).
  3. **Silence during the window:** 0% arrives, then *no readings at all* for 10s (signal loss). Is absence-of-data confirmation (alert, per "fails toward alerting") or does the suspect state just sit under a staleness badge (FR-4)? Suspect + stale simultaneously is a state the PRD never mentions.
- **Also note:** with the 2s SSE cadence, "persisting beyond 5s" is only observable at the first reading ≥6s after onset — the effective window is 6–7s, not 5. Fine, but say so before tests freeze thresholds (OQ-3).
- **Fix direction:** Declare the classifier operates in reading-timestamp time, define batch/out-of-order behavior as retrospective classification, and define the silence rule explicitly (CM1 argues: silence past the window while last-known state is 0% → alert).

### H-2. Tier 1 ships FR-26, whose text depends on FR-25 — which is Tier 2
- **Anchors:** §6 Tier 1 ("FR-1–FR-12, FR-14–FR-24, **FR-26**–FR-29, FR-31–FR-33"), §6 Tier 2 ("FR-25 — circuit breaker with degraded mode"), FR-26 ("Degraded mode (**open circuit** or dropped streams)...").
- **The attack:** FR-26's own definition of degraded mode includes "open circuit," but the circuit breaker that produces an open circuit is FR-25, deferred to Tier 2. §6's rule is "a tier begins only when the previous one is done and green" — Tier 1's FR-26 can never be "done" per its own text without a Tier-2 feature. Meanwhile FR-25's text says the breaker "enter[s] degraded mode," so the degraded-mode trigger set is split across two tiers with no statement of which half ships when.
- **Fix direction:** Either split FR-26 into 26a (dropped-streams degraded mode, Tier 1) and 26b (circuit-open trigger, Tier 2), or move FR-25 into Tier 1. Do it in the PRD, not in the developer's head at 2am.

### H-3. Presence: reconnect and duplicate names create phantom identities FR-19 does not cover — and a lost disconnect event means a phantom forever
- **Anchors:** FR-16, FR-17, FR-18, FR-19, FR-27; addendum (client→server messages limited to `register_dispatcher`/`ping`/`viewing_truck`); server behavior (disconnect events delayed up to 10s).
- **The attack:** FR-19 only covers ghost *disconnect* events (late, duplicated, out-of-order). The connect side is wide open:
  1. **Reconnect duplication (FR-27):** on WS reconnect the dispatcher "re-registers" — presumably receiving a *new* server identity while the old identity's disconnect event may lag up to 10s. For that window the dispatcher appears twice in FR-17's list, and the dead identity may still show a viewing indicator on some truck (FR-18). No requirement says the client dedupes, and dedupe-by-name is unsound because —
  2. **Same name twice:** nothing forbids two humans registering as "Dana." Two legitimate identities with one name are indistinguishable from a reconnect duplicate. Any name-based dedupe silently merges two real dispatchers; any identity-based approach keeps the reconnect ghost. The PRD picks neither.
  3. **The missing disconnect:** FR-19 promises no phantom presence for late/dup/out-of-order disconnect events — but a disconnect event that *never arrives* (dropped during the client's own SSE/WS outage, or server hiccup) leaves a phantom permanently. There is no client-side liveness timeout requirement (e.g., "no presence/ping activity for N seconds → mark ghost"), and no such constant in §5.
- **Fix direction:** Add a presence-reaper rule (activity timeout, constant in §5), define reconnect as replace-own-identity, and state the honest limit on name collisions the way UJ-1 beat 1 states the truck-level-proxy limit.

### H-4. FR-24 and FR-25 fight: the circuit-breaker probe can violate Retry-After, its interval is missing from the constants table, and "three consecutive 503s" is ambiguous under retries
- **Anchors:** FR-24, FR-25, Tunable Constants (§5 — claims to list all deliberate defaults).
- **The attack:** Three holes in one mechanism:
  1. Circuit opens; FR-25 says "periodic probes detect recovery." The last 503 carried `Retry-After: 30`. If the probe period is shorter, the probe violates the principle FR-24 just established (honor the server's backpressure). Which requirement wins is unstated.
  2. The probe interval is a tunable constant by any definition — it is absent from §5, which presents itself as the complete list ("All values below..."). So are the SSE/WS reconnect backoff parameters (FR-27). The one-place-to-tune promise is already broken at spec time.
  3. "Three consecutive 503s": does one logical fetch retried per Retry-After count as one failure or three? If retries count, a single user action can trip the breaker; if not, the breaker may effectively never open under the documented failure mode. Both readings are defensible from the text.
- **Fix direction:** Probe interval = max(configured probe period, last Retry-After); add probe interval and backoff parameters to §5; define the failure-counting unit (recommend: each completed HTTP attempt returning 503).

### H-5. The PRD's first motivating incident — two trucks dispatched to the same address — has no covering requirement: route *creation* bypasses all concurrency control
- **Anchors:** §1 incident 1, FR-10, FR-12, FR-31.
- **The attack:** FR-12's optimistic locking is version-checked *updates* to an existing route. Route creation (FR-10) has no version to check — two dispatchers concurrently creating routes (same destination, or both assigning to the same truck) sail through with zero conflict detection. FR-31's inline notice only fires for "a route open for editing." So the very incident the vision section leads with recurs untouched through the create path. It may be genuinely unfixable client-side (the immutable server may accept both), but the PRD documents the truck-level-presence limit honestly (UJ-1 beat 1) and stays silent here — a reviewer tracing incidents → requirements (G5's own discipline) will find the hole in minutes.
- **Fix direction:** Either add a client-side guard (warn on creating a route for a truck that already has an active route / duplicate destination, from cached fleet state) or add an explicit honest-limit note. Silence is the only wrong option.

---

## MEDIUM

### M-1. FR-13's "who made the conflicting change" rests on an unverified server field
- **Anchors:** FR-13, §6 Tier 1 ("FR-13 in its minimum form — conflict message plus **attribution**"), addendum (server contract fixed).
- The 409 response is assumed to carry (or the current route state to expose) the conflicting dispatcher's identity. Neither the PRD nor the addendum confirms the mock server provides it. Fallback — reconstructing from WS route events — fails for a dispatcher who joined after the conflicting change, and races event delivery. Even Tier 1's minimum form depends on this. Verify against the actual server response *before* architecture, or specify the fallback and its honest limit.

### M-2. Cold start: FR-7 and FR-8 both reference a "last plausible/trusted" value that may not exist
- **Anchors:** FR-7, FR-8(a), FR-33.
- Truck 7's 999 km/h episode lasts 5–10s; if the client connects (or FR-33's fleet reset wipes state) mid-episode, there is no "last plausible speed" to display and no "prior trusted level" for the fuel classifier's case (a)/(b) split. Behavior on empty history is unspecified for both policies. Define it (e.g., render "no trusted reading yet" + treat first-ever 0% as case (c)-pending, failing toward alerting).

### M-3. FR-11's transition diagram is ambiguous and races live updates
- **Anchors:** FR-11, FR-14, FR-31.
- "`assigned` → `in-progress` → `completed` / `cancelled`" reads as cancel-only-from-in-progress; can an `assigned` route be cancelled? Almost certainly yes operationally, but the text says otherwise. What does *reassign* (FR-14) do to status — reset to `assigned`? Is reassigning an `in-progress` or `completed` route legal? Also: "the UI offers only legal transitions" is computed from local state that a server event can invalidate mid-click (FR-31 covers open *editors*, not action buttons on a list row) — the click lands as a 409 on a transition that was legal a second ago. Enumerate the full legal-transition table, including reassign semantics.

### M-4. FR-4's "telemetry age" has no defined clock — batches and skew make both readings wrong
- **Anchors:** FR-4, FR-3, FR-26, constants (§5: staleness 10s, rationale "five missed cycles" — implies arrival-clock).
- Age since *arrival* or since *reading timestamp*? After a GPS batch replays, the newest reading's timestamp can be 20s old though it arrived milliseconds ago: timestamp-age slaps a stale badge on a just-updated truck; arrival-age presents 20s-old data as fresh, violating FR-26's "old data is never presented as fresh." Client/server clock skew (server-generated timestamps vs. client clock) can make timestamp-age negative or inflated, and nothing addresses it. Pick a clock, state the skew assumption.

### M-5. The degraded-mode banner is one indicator driven by two independent failure axes with no state machine
- **Anchors:** FR-25, FR-26, FR-27, FR-2, CM2.
- Set/clear conditions are unspecified: circuit open but SSE flowing → telemetry is *live* while route/fleet metadata is stale-cached ("degraded mode on cached data" is simply wrong for the telemetry half); SSE drops and reconnects (FR-27) while the circuit stays open — does the banner clear? Rapid drop/reconnect cycles flap the banner, which is exactly the fatigue CM2 forbids. Define the banner as a disjunction of named conditions with per-condition set/clear rules and hysteresis, and say what mixed freshness (live position, stale status) looks like.

### M-6. FR-33's "clean state refresh" collides with the open circuit and with every stateful subsystem
- **Anchors:** FR-33, FR-25, FR-7/FR-8 (trusted history), FR-9, FR-15, NFR-3.
- A fleet reset triggers "a clean state refresh" — via the fleet endpoint. If the circuit is open, the refresh is blocked: force-close, probe-now, or queue? Unstated. And what does "clean" wipe — telemetry history (breaking "last trusted" per M-2), the anomaly log (FR-9), the audit trail (FR-15's whole point is that the record survives)? Each answer is defensible; none is written down.

### M-7. Identity lives on the WebSocket, but writes go over REST: NFR-4 silently couples route management to WS health
- **Anchors:** NFR-4, FR-16, FR-27, FR-15; addendum (`X-Dispatcher-Id` header).
- No WS registration → no identity → per NFR-4, no writes. During a WS outage/reconnect a dispatcher can watch the fleet but cannot save, and nothing requires the UI to surface why. Worse: re-registration after reconnect presumably issues a *new* identity, so one human's audit-trail entries (FR-15) split across two IDs mid-shift ("nobody knew who did what" returns wearing a UUID), and an in-flight mutation carrying the dead ID has undefined fate. Specify identity continuity (or the honest limit) and the write-lockout UX.

### M-8. Out-of-order and stale-batch readings vs. history, trails, and charts: backfill or drop is never decided
- **Anchors:** FR-6, FR-3, FR-21, NFR-3, constants (§5: 300-reading history).
- FR-6 says old readings "never overwrite newer data" — but do they *backfill* the bounded history that feeds FR-21's charts and FR-3's trails, or get dropped? Dropping loses real trajectory data; backfilling means mid-buffer insertion into a 300-cap ring buffer (and re-rendering charts), which is real work nobody scoped. Same ambiguity inside FR-3: "snaps to the latest position" — latest by timestamp or last element of the batch array? The server sends out-of-order timestamps *inside* batches; if the trail isn't explicitly timestamp-sorted, the polyline zigzags. Three words fix it: "sorted by timestamp; stale readings backfill history but never current state" (or "are logged and dropped" — just choose).

### M-9. Untestable claims presented as requirements
- **Anchors:** NFR-1 ("runs indefinitely without degradation"), NFR-3 ("An 8-hour shift must not leak; memory plateaus"), FR-3/NFR-2 ("never visibly stalls" / "no dispatcher-visible stall").
- With a deadline tomorrow, nobody runs an 8-hour soak, and "indefinitely" is unfalsifiable by construction. "No visible stall" has no budget (ms of main-thread block? frames dropped?). These need proxy criteria the test suite can actually assert: every collection has an enforced cap (testable today), batch processing of N readings completes under X ms in a unit test, coalescing verified by counting renders under a synthetic flood. As written, G5's "every requirement maps to tests" is false for these three.

### M-10. The viewing indicator has no end-of-life: "stopped viewing" may be unrepresentable
- **Anchors:** FR-18, addendum (client→server limited to `register_dispatcher`/`ping`/`viewing_truck`).
- When a dispatcher closes the detail panel and views nothing, what clears their indicator on other screens? If the protocol only carries `viewing_truck <id>` with no null/none form, "not viewing anything" cannot be transmitted and every dispatcher permanently appears parked on the last truck they opened. Combined with H-3, a ghosted dispatcher's indicator lingers ≤10s minimum, forever at worst. Verify whether the message accepts a null payload; if not, document the honest limit like UJ-1 does.

---

## LOW

### L-1. "Nine or more cases total" counts a Tier-2 test
- The circuit-breaker case (FR-25) is in the §5 matrix, but FR-25 is Tier 2. If Tier 2 is cut — the tiering exists precisely because it might be — the count is exactly 8: the mandate holds with zero slack, and the PRD's "nine or more" claim is false. Say "eight mandated + one self-imposed."

### L-2. Render coalescing "≤10 updates/sec" — per truck, per widget, or global?
- 12 trucks × 10/sec is a very different budget from 10/sec total. One word in §5 settles it.

### L-3. FR-30's "WebSocket latency" has no defined measurement
- WS server messages carry no guaranteed send-timestamp, and clock skew poisons any timestamp diff. If it means ping/pong RTT, say so — otherwise this metric is unimplementable as named.

### L-4. FR-10 route creation: assigning to a `maintenance` truck is unvalidated
- NFR-7 validates "types, ranges, required fields" — nothing validates business legality (truck status). Either it's allowed (say so) or it's a validation rule (add it).

### L-5. FR-19's one mandated test cannot meaningfully cover three failure phenomena
- FR-19 enumerates late, duplicated, *and* out-of-order disconnect events; the matrix allots 1 case. One case covering all three is a kitchen-sink test; one case covering one leaves two behaviors untested. Either bump the minimum to 3 or name which phenomenon the single case must exercise.

---

## Counts

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 5 |
| Medium | 10 |
| Low | 5 |
| **Total** | **21** |

## The one-paragraph handoff

Before code starts: resolve C-1 (split sensor-fault from overspeed, or amend CM1), declare the classifier's clock (H-1) and the staleness clock (M-4), fix the FR-25/26 tier split (H-2), add the presence-reaper and reconnect-identity rules (H-3, M-7, M-10), and complete the constants table (H-4). Everything else can be settled by one-line PRD edits during implementation — but these six will otherwise be settled implicitly by whatever the code happens to do, which is exactly the failure mode a trust-first PRD exists to prevent.
