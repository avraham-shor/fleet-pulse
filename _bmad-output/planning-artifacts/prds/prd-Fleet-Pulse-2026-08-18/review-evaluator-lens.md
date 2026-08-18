# Evaluator-Lens Review — Fleet-Pulse PRD + Addendum

**Role:** hiring evaluator grading a senior frontend submission on six parameters; this PRD ships in the repo as SDD evidence and will be defended in a follow-up interview.
**Inputs reviewed:** `prd.md`, `addendum.md` (2026-08-18).
**Grading frame:** Spec-Driven Development, Architecture, Security, Performance, Observability, Tests. Eight mandated server failure modes. Brief prizes thoughtful partial over naive complete; conflict-resolution UX between dispatchers is flagged as the senior-level design challenge.

---

## Gate Verdict

**Conditional pass — this PRD would place the submission in the top band for SDD, Security, Performance, and Observability, but it ships with one internal contradiction in the anomaly policy, one of the eight mandated failure modes left unaddressed while claiming all eight are handled, and the brief's flagged senior-level challenge parked in a cuttable tier. All three are exactly the kind of thing an interviewer probes. Fix before shipping.**

No critical findings. 3 high, 6 medium, 10 low.

---

## Scorecard

| # | Parameter | Verdict |
|---|---|---|
| 1 | Spec-Driven Development | **Sets up to excel** |
| 2 | Architecture | **Adequate** — goal stated, not made traceable |
| 3 | Security | **Sets up to excel** |
| 4 | Performance | **Sets up to excel** — verification plan missing |
| 5 | Observability | **Sets up to excel** |
| 6 | Tests | **Adequate — would lose points** as specified |

---

## 1. Spec-Driven Development — Sets up to excel

**Evidence (strong):**
- Stable, append-only FR IDs (`FR-1`…`FR-33`), with late additions honestly marked (*added from UJ-1*, *added at source reconciliation*) rather than renumbered — exactly the discipline SDD grading looks for.
- Explicit traceability plumbing: commits reference FR IDs (§7), DECISIONS.md entries must cite the FR/NFR they serve, test matrix maps assignment-mandated areas → FRs → case counts (§5).
- The evaluation-parameter table (§2) maps each graded parameter to where the PRD answers it.
- Counter-metrics (CM1–CM3) show requirements-level thinking about failure of the spec itself — a genuinely senior signal.
- Tiered scope with an explicit depth-over-breadth rule matching the brief's "thoughtful partial beats naive complete."

**Findings:**

- **[SDD-1 | MEDIUM] No failure-mode → FR traceability table, and G1 overclaims.** G1 asserts "All eight server failure modes are handled deliberately," but the PRD never enumerates the eight and maps them to FRs. Seven map cleanly (GPS batch→FR-3/6; fuel 0%→FR-8; speed 999→FR-7; If-Match 409→FR-12/13; out-of-order SSE→FR-6; delayed disconnect→FR-19; 503/Retry-After→FR-24/25). The eighth — **PATCH race returning 409 mid-processing** — has no distinct requirement (see SEC-3/TEST-2). An evaluator cross-checking the eight against the FRs finds the gap precisely because the map is missing. One table would both close the gap and be the single strongest SDD artifact in the document.
- **[SDD-2 | LOW] Frontmatter `status: draft`.** A "draft" PRD shipped as the SDD anchor invites "did you actually build from this?" Flip to approved/final (with a changelog line) before the repo ships.
- **[SDD-3 | LOW] Open questions ship unresolved.** OQ-1–OQ-3 are properly scoped as architecture-level, but if the repo ships with them open and no DECISIONS.md entries closing them, the traceability story has visible loose ends. Defense question: "What did you decide on OQ-2 and where is it recorded?" must have an answer in the repo.
- **[SDD-4 | LOW] "Success is evaluator-shaped" is a visible gamble.** §2 openly addresses the grader ("The reviewer should close the repo thinking…"). Some evaluators read this as audience awareness; others as writing a PRD for a grade rather than a product, which muddies the otherwise clean product fiction (Dana/Yossi, the incidents). Consider rephrasing as "Definition of done for this submission."

---

## 2. Architecture — Adequate

**Evidence:**
- G2 names the exact graded criteria (new sensor/vehicle type without touching existing components; pipeline decoupled from UI). The addendum repeats the decoupling criterion verbatim and records the stack decision with real alternatives (Angular/RxJS trade-off, vanilla JS trade-off) — good decision hygiene.
- Group B is framed cross-cutting ("no raw value is ever rendered as current truth") and sequenced first with tests alongside — structurally the right shape for a decoupled pipeline.
- FR-28 (widget failure containment) is a concrete architectural requirement most candidates never write down.

**Findings:**

- **[ARCH-1 | MEDIUM] Extensibility is a goal, not a requirement — nothing traceable enforces it.** No FR or NFR makes the plugin/registry shape concrete (e.g., "a sensor is defined by a validator + renderer registered in one place; adding one touches zero existing modules"). Every FR could be satisfied by hardcoded truck/sensor logic and the PRD would still be "met." Defense question: "Which requirement guarantees I can add a coolant sensor without touching existing components?" Today the only answer is a goal statement. Deferring detail to the architecture doc is legitimate, but one extensibility NFR with an acceptance criterion ("demonstrated in README with a worked example") would make the graded criterion traceable.
- **[ARCH-2 | LOW] Addendum process residue.** "Notes for Architecture (to be filled during PRD conversation)" reads as an unfinished template if it ships verbatim. Retitle ("Constraints handed to architecture") — the content itself is good.
- **[ARCH-3 | LOW] PRD is truck-only in vocabulary.** All requirements say "truck"; the vehicle-type dimension of G2 appears nowhere else. Harmless if the architecture doc picks it up; a one-line note that "truck" is the only concrete vehicle type of an extensible set would cost nothing.

---

## 3. Security — Sets up to excel

**Evidence:**
- All four graded security behaviors have dedicated NFRs: identity on every mutation (NFR-4), If-Match optimistic locking with no silent stale wins (NFR-5), confirmation on destructive cancel/reassign (NFR-6 + FR-14), input validation before submission (NFR-7, FR-10, FR-22).
- NFR-8 (server-originated text rendered, never interpreted) exceeds the brief — an XSS-awareness signal graders rarely see in take-homes.
- Addendum names the exact transports: `X-Dispatcher-Id` header, `If-Match` with route version.

**Findings:**

- **[SEC-1 | LOW] Header names live only in the addendum.** NFR-4/NFR-5 in the PRD body say "identity" and "version-checked" generically. Fine if both files always travel together; naming `X-Dispatcher-Id`/`If-Match` in the NFRs makes the graded checklist item findable in one place.
- **[SEC-2 | LOW] Re-apply semantics after a conflict are unspecified.** UJ-1 step 3 lets Dana "re-apply her change on top of the fresh version," but no requirement states the retry must carry the *new* version's If-Match (i.e., re-fetch, re-stamp, resubmit). Obvious to a good implementer, but the interview question "what version header does the retry send?" deserves a written answer — otherwise the spec permits an If-Match retry loop.
- **[SEC-3 | MEDIUM] The mid-processing 409 race (failure mode #8) has no requirement.** FR-12/13 cover a *stale* write being rejected. The mandated eighth mode is a PATCH that races another mutation and 409s even though the client's version was current at send time — which implicates in-flight request state, any optimistic UI update needing rollback, and double-submit protection while a mutation is pending. The PRD never says whether mutations are optimistic or pessimistic, or what state the UI rolls back to on a mid-flight 409. See TEST-2.

---

## 4. Performance — Sets up to excel

**Evidence:**
- NFR-1/2/3 hit the graded points in their own words: 12 trucks × 2s sustained, batches processed as a unit with no visible stall, every collection bounded, "an 8-hour shift must not leak; memory plateaus."
- The Tunable Constants table is a standout: render coalescing ceiling (≤10 updates/sec), bounded history (~300 readings ≈ 10 min — arithmetic checks out at the 2s cadence), each constant with a rationale and a single place to change. This table wins interview defenses on its own.

**Findings:**

- **[PERF-1 | MEDIUM] No verification plan for the load/leak claims.** The test matrix contains zero performance cases and the PRD states no method for demonstrating "memory plateaus" (bounded-buffer unit tests, a soak note in the README with heap-snapshot methodology, anything). "Survives 8 hours without a leak" is a graded claim; as written it is asserted, not evidenced. Defense question with no prepared answer: "How do you know it plateaus?" Cheapest fix: unit-test the ring-buffer bounds (history, anomaly log, audit trail) and say so in the matrix; one README paragraph describing a soak check.
- **[PERF-2 | LOW] Trail polylines (FR-3) are not explicitly named among bounded collections.** NFR-3 says "every in-memory collection," and trails presumably derive from the bounded history — but FR-3 is the one place a second, unbounded position buffer could sneak in. One clause ("trails render from the bounded history window") closes it.

---

## 5. Observability — Sets up to excel

**Evidence:**
- Stale-data indication is layered exactly as graded: per-truck freshness badges (FR-4), global degraded banner with "old data never presented as fresh" (FR-26), staleness threshold rationale (five missed cycles).
- Anomaly logging is a first-class requirement (FR-9) feeding a dispatcher-facing view (FR-29) — matching "logging/metrics for anomalies."
- FR-30 mirrors the bonus panel spec nearly verbatim (SSE events/sec, WS latency, reconnection counts) and adds dropped/discarded events. Correctly separated from the dispatcher workflow.

**Findings:**

- **[OBS-1 | LOW] Non-409 mutation failures have no specified error state.** The conflict path is fully designed, but a PATCH that times out or 500s has no stated UX ("visible error states" is a graded phrase). Likely handled in practice; one sentence in Group F would cover it.
- **[OBS-2 | LOW] WS latency metric has no defined measurement.** Presumably keepalive ping RTT (FR-16 provides the ping) — say so, since FR-30 is precisely the row an interviewer will ask to explain.
- Note: FR-30 sits in Tier 2 — acceptable, it is a bonus item; if time runs out this loses the bonus only, not core points.

---

## 6. Tests — Adequate; would lose points as specified

**Evidence:**
- The matrix maps every mandated area to an FR, the fuel classifier gets 3 cases across its policy branches, "no it-renders tests" is stated, and pipeline tests are sequenced alongside implementation, not deferred.

**Findings:**

- **[TEST-1 | HIGH] Internal contradiction: CM1 promises a real sustained overspeed still alerts; FR-7 + the 120 km/h constant guarantee it never can.** FR-7's policy is: implausible speed → show last plausible speed + "sensor fault" badge "until plausible readings resume." With plausible-max at 120 km/h, a truck genuinely doing 135 is classified as a sensor fault indefinitely — the exact suppression CM1 forbids and claims is "tested explicitly." Fuel got a persistence/debounce escalation policy (FR-8c: anomaly persisting beyond the window → accepted as real); speed got none, even though the brief documents the stuck-sensor as lasting 5–10s — a duration signature a persistence policy could key on. The test matrix has no CM1 speed case, so the contradiction would ship unnoticed until the interviewer reads CM1 aloud next to FR-7. This is the single worst defense moment in the document: a self-contradiction inside the anomaly-detection area, the hardest-graded test surface. Fix: give FR-7 a persistence rule (e.g., implausible-but-internally-consistent readings persisting well beyond the documented 10s stuck window escalate to an alert, or distinguish "physically impossible" 999 from "above-threshold plausible" values) and add the CM1 test case.
- **[TEST-2 | HIGH] The eighth failure mode (PATCH race → 409 mid-processing) has no requirement and no test.** The matrix's locking row covers the stale-write flow only. No case exercises a 409 arriving on a request whose version was fresh at send time, and no requirement defines rollback of in-flight/optimistic state (SEC-3). Since G1 claims all eight modes handled, this is simultaneously a test gap and an SDD overclaim — a cross-check any evaluator with the failure-mode list will run.
- **[TEST-3 | MEDIUM] One-case minimums on the hard parts read thin against "meaningful coverage."** FR-19 alone names three distinct behaviors (late, duplicated, out-of-order disconnect) yet is budgeted 1 case; out-of-order timestamps gets 1 case with no named edges (equal timestamps, out-of-order *inside* a batch, interleaving across trucks); GPS batch gets 1. "Minimum" is defensible wording, but the PRD sets the floor at the least impressive level for the exact areas the grading singles out. Raising the ghost-presence minimum to 3 (one per named behavior) and out-of-order to 2 costs little and moves this parameter to excel.
- **[TEST-4 | MEDIUM] The "nine or more" count leans on a Tier-2 feature.** The ninth case is the self-imposed circuit-breaker test — but FR-25 lives in Tier 2. If Tier 2 is cut, the matrix lands at exactly 8 with zero slack, and three of those eight are sub-cases of one classifier, which a strict evaluator might count as one area covered deeply rather than eight cases. The claim "exceeding the mandated minimum" should not depend on a cuttable tier.
- **[TEST-5 | MEDIUM] FR-19's acceptance rule is vague on the mandated scenario's nastiest variant.** A dispatcher disconnects, reconnects (re-registers), and *then* the delayed disconnect event (10s late, 20% chance) arrives. "Never leaves phantom presence state" covers a ghost that stays; it does not clearly forbid the inverse — a late disconnect wrongly removing a live, re-registered dispatcher. No resolution rule is written (e.g., ignore disconnect events older than the identity's latest registration). This is the precise scenario an interviewer constructs from the failure-mode list, and the current wording doesn't pin the answer.

---

## Contradictions with the assignment / internal contradictions

1. **CM1 vs. FR-7 + 120 km/h constant** (TEST-1) — internal contradiction; also collides with the brief's expectation of thoughtful anomaly handling (suppressing a real emergency is the naive failure mode inverted).
2. **G1 "all eight failure modes handled" vs. the missing eighth** (SDD-1, SEC-3, TEST-2) — overclaim relative to the brief's failure-mode list.
3. **Brief flags conflict-resolution UX as *the* senior-level design challenge; the PRD tiers the full FR-13 side-by-side flow as cuttable Tier 2.** *(Rated HIGH, filed here as it spans parameters.)* Tier 1's minimum (conflict message + attribution) is honest and functional, and depth-over-breadth is the brief's own rule — but voluntarily marking the one area the brief spotlights as the first candidate for cutting is a strategic misallocation. If anything in Tier 2 deserves promotion into Tier 1, it is FR-13's full flow; the circuit breaker (FR-25) is the better sacrifice, being self-imposed. Also note the test-matrix row "FR-12, FR-13 | 1" silently spans both tiers.
4. No other contradictions found: submission mechanics (§7) match the brief exactly (npm start/test, unchanged server, README, PROMPTS.md), scope exclusions are safe, and the map-vs-grid hedge (OQ-1) is consistent with "map quality not graded."

---

## Findings index

| ID | Severity | Parameter | One-liner |
|---|---|---|---|
| TEST-1 | High | Tests / SDD | CM1 promises real overspeed alerts; FR-7 + 120 km/h cap suppresses them forever; no test |
| TEST-2 | High | Tests / Security / SDD | 8th failure mode (mid-flight 409 race) has no requirement, no rollback spec, no test |
| CONTRA-3 | High | Cross-cutting | Brief's flagged senior challenge (full conflict UX, FR-13) parked in cuttable Tier 2 |
| SDD-1 | Medium | SDD | No failure-mode → FR map; G1 overclaims "all eight" |
| ARCH-1 | Medium | Architecture | Extensibility is a goal with no traceable requirement or acceptance criterion |
| PERF-1 | Medium | Performance | No verification plan for 8-hour leak / bounded-memory claims |
| TEST-3 | Medium | Tests | One-case minimums on the hardest graded areas (esp. FR-19's three behaviors) |
| TEST-4 | Medium | Tests | ≥9 count depends on a Tier-2 feature; strict count could read as 8-with-no-slack |
| TEST-5 | Medium | Tests | Reconnect-then-late-disconnect resolution rule unwritten for FR-19 |
| SDD-2 | Low | SDD | `status: draft` on the shipped SDD anchor |
| SDD-3 | Low | SDD | Open questions must be visibly closed in DECISIONS.md before ship |
| SDD-4 | Low | SDD | "Evaluator-shaped" meta-voice is a gamble |
| ARCH-2 | Low | Architecture | Addendum "(to be filled)" template residue |
| ARCH-3 | Low | Architecture | Truck-only vocabulary; vehicle-type dimension unmentioned beyond G2 |
| SEC-1 | Low | Security | X-Dispatcher-Id / If-Match named only in addendum, not in NFRs |
| SEC-2 | Low | Security | Post-conflict re-apply doesn't state fresh If-Match semantics |
| PERF-2 | Low | Performance | Trail polyline bounding not explicit |
| OBS-1 | Low | Observability | Non-409 mutation failure UX unspecified |
| OBS-2 | Low | Observability | WS latency measurement method undefined |

**Totals: 0 critical · 3 high · 6 medium · 10 low** *(19 findings; low count includes minor items listed within parameter sections)*

## Pre-ship fix list (priority order)

1. Resolve CM1↔FR-7: add a speed persistence/escalation rule and its CM1 test case (TEST-1).
2. Add an FR + test for the mid-flight 409 race, including in-flight/optimistic state rollback (TEST-2, SEC-3).
3. Promote full FR-13 into Tier 1; demote FR-25 to Tier 2's head (CONTRA-3, fixes TEST-4's fragility too).
4. Add the eight-failure-modes → FR → test traceability table (SDD-1) — one table, three parameters strengthened.
5. Write the FR-19 reconnect-vs-late-disconnect rule; raise its case minimum to 3 (TEST-5, TEST-3).
6. Add bounded-buffer tests + a soak-verification note for NFR-3 (PERF-1).
7. Sweep the lows: flip `status`, close OQs in DECISIONS.md, retitle addendum section, name the headers in NFR-4/5.
