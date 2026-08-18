# PRD Quality Review — FleetPulse

Reviewed: `prd.md` + `addendum.md`, 2026-08-18. Context calibration: interview-assignment PRD, internal-tool depth, chain-top (feeds architecture and epics/stories), shipped in the submission repo as SDD evidence and defended live. Judged against that — not against a green-light-to-build enterprise bar.

## Overall verdict

This is a genuinely good PRD: it has a real thesis ("The problem is trust, not data," §1), decisions stated as decisions with their trade-offs on the table, and FRs that are unusually testable for a document this lean. What's at risk is verifiability of its own headline claim — G1 promises "all eight server failure modes are handled deliberately" but the PRD never enumerates the eight, and the trust-state vocabulary the whole integrity engine hangs on (validated / suspect / stale / fault / degraded) is used piecewise across FRs without ever being pinned as a set. Both are small fixes that matter disproportionately for a document that will be defended as traceability evidence.

## Decision-readiness — strong

Decisions read as decisions throughout. The north star (§1, "Every trade-off in this document resolves toward data trustworthiness over visual polish") is a stance, not a platitude, and it's actually invoked downstream — the Tier 3 exclusion of the anomaly dashboard (§6, "deliberately excluded: FR-29 already delivers its value"), the out-of-scope line "we are building trust, not beauty," and FR-8's tie-break rule ("Uncertainty always fails toward alerting, never toward suppression") all resolve against it. The FR-8 hybrid fuel policy is the standout: a three-branch decision with a named failure direction, not a "system handles fuel glitches gracefully" dodge.

Open Questions are real: OQ-1 (Leaflet vs. coordinate grid) and OQ-2 (chart backfill vs. live-only) are genuinely undecided, with owner and decision point named, and the closing line "No open question blocks UX, architecture, or story breakdown" is an honest, checkable claim. The addendum's stack decision names what was given up ("RxJS is a genuine advantage for SSE stream processing") rather than pretending the alternative had no merits. There are no `[NOTE FOR PM]` callouts, which is correct here — the author is the PM, the dev, and the defender; UJ-1's "*Honest limit:*" note (§4 beat 1) does that job where a real tension exists.

## Substance over theater — strong

Nothing here is furniture. There are no personas beyond the two protagonists of UJ-1, and they exist to earn a requirement (FR-31 is explicitly "*added from UJ-1*"). The NFRs are product-specific to the point of being quotable: "12 trucks × 2-second updates" (NFR-1), "An 8-hour shift must not leak; memory plateaus" (NFR-3), "rendered, never interpreted" (NFR-8) — no "scalable/secure/reliable" boilerplate anywhere. The Vision could not swap into another PRD: it's built from this server's documented pathologies ("truck #7's speed sensor sticks at 999 km/h," "the fuel sensor reads a false 0% during hard braking") and three concrete incidents. The Tunable Constants table (§5) is the anti-theater move — every threshold has a default and a rationale instead of an adjective. The evaluation-parameter mapping table (§2) might look like furniture in a normal PRD; here the evaluator *is* the customer, so it's load-bearing.

## Strategic coherence — strong

The thesis is stated in one sentence and everything hangs off it. Prioritization follows the thesis, not convenience: the Telemetry Integrity Engine (Group B) is named "the heart and is built first, with its tests written alongside" (§6), and tier gating is explicit ("a tier begins only when the previous one is done and green"). Counter-metrics exist and are the right ones — CM1 (no suppressed emergencies) is the exact failure mode of an anomaly-filtering thesis, and it's wired into FR-8 and the test matrix rather than left decorative. CM3 (depth over breadth) is a real bet with a stated warrant ("the brief explicitly scores a thoughtful partial solution above a naive complete one"). MVP scope kind is coherently problem-solving-shaped. This does not read as a backlog with headings.

## Done-ness clarity — strong

The mandated-test FRs are exemplary: FR-3 carries negative conditions ("never renders as separate markers and never visibly stalls the UI"), FR-6 states the invariant as a prohibition ("A reading older than the truck's current state never overwrites newer data"), FR-8 enumerates its three branches, FR-19 bounds the ghost window ("up to 10s"). FR-4's threshold and FR-21's window both resolve to concrete values in the Tunable Constants table. The test matrix (§5) closes the loop from FR to minimum case count. Findings below are edge-trimming, with one exception that touches the PRD's central claim.

### Findings
- **medium** The eight failure modes are never enumerated (§2 G1) — G1 claims "All eight server failure modes are handled deliberately" and G5 claims "full traceability," but no list of the eight exists anywhere in the PRD or addendum; the Vision names four, the test matrix covers seven areas, and a reader (or the candidate mid-defense) cannot verify coverage of the headline goal from the document alone. *Fix:* add an eight-row table (failure mode → FR(s) → test area) near G1 or the test matrix; the FRs almost certainly already cover all eight, so this is pure indexing.
- **low** Perceptual bounds without budgets (§5 NFR-1/NFR-2) — "runs indefinitely without degradation" and "no dispatcher-visible stall" are eyeball criteria; the coalescing ceiling (≤10 updates/sec) gives a mechanism but not a pass/fail line. *Fix:* pin one number, e.g. "no main-thread block > 100ms during a max-size burst," in the constants table.
- **low** Two of three bounded collections have no bound (§5 NFR-3 vs. Tunable Constants) — NFR-3 requires telemetry history, anomaly log, and audit trail all bounded, but the constants table sizes only telemetry history (~300 readings); FR-9's "bounded anomaly log" has no number. *Fix:* two more rows in the constants table.
- **low** FR-11's legal-transition set is underspecified (§3) — `assigned → in-progress → completed / cancelled` leaves ambiguous whether `cancelled` is reachable from `assigned`, and what reassignment (FR-14) does to status. *Fix:* a one-line transition table or an explicit "cancellable from any non-terminal state."

## Scope honesty — strong

Omissions are explicit, not inferred: the Out-of-scope list (§6) names server changes, auth, persistence, browser matrix, and polish. Deferrals are labeled by tier with the split stated precisely ("FR-13 in its minimum form — conflict message plus attribution" in Tier 1; the side-by-side chooser in Tier 2). All assumptions are consolidated and flagged ("All values below are `[ASSUMPTION]`," §5), with OQ-3 honestly noting they may shift after watching the real stream. The best moment in the document is UJ-1's "*Honest limit:*" — admitting truck-level presence is a proxy for route-level editing, with the addendum carrying the protocol proof ("client→server WS messages are limited to `register_dispatcher` / `ping` / `viewing_truck`"). Open-items density (3 OQs, one assumption block) is right for the stakes. Two small consistency wrinkles:

### Findings
- **low** FR-26 (Tier 1) half-depends on FR-25 (Tier 2) (§6) — degraded mode is triggered by "open circuit or dropped streams," but the circuit only exists once Tier 2's FR-25 lands; if Tier 2 is cut, the "open circuit" half of a Tier-1 requirement is unreachable. *Fix:* one sentence in §6 noting FR-26's Tier-1 form covers stream-drop degradation and gains the circuit-open trigger with FR-25.
- **low** UJ-1 narrates the Tier-2 form of FR-13 (§4 beat 3) — "adopt Yossi's version, re-apply her change on top of the fresh version, or back out" is the full side-by-side chooser, which Tier 1 explicitly does not include; the journey doesn't flag this, so a reader could take Tier 1 to promise it. *Fix:* a parenthetical "(full chooser is Tier 2; Tier 1 shows the conflict message with attribution)."

## Downstream usability — adequate

This is chain-top — §6 explicitly hands off to an epics/stories phase — so this dimension carries weight. IDs are clean: FR-1–33 unique and complete, with the late additions (FR-31/32/33) each annotated with provenance ("*added from UJ-1*," "*added at source reconciliation*"). Every cross-reference I chased resolves (NFR-6→FR-14, FR-8→CM1, UJ-1→FR-12/13/15/18/31, test matrix→FRs, §2 table→§5/addendum). UJ-1 has named protagonists carrying context inline. What's missing is the one artifact this particular PRD needs most: a pinned vocabulary for its own core abstraction.

### Findings
- **medium** No glossary, and the trust-state taxonomy is implicit (§3 Group B, §5) — the integrity engine's states are named piecewise across FRs: "validated" (FR-5), "suspect state… 'validating' badge" (FR-8), "'sensor fault' badge" (FR-7), staleness (FR-4), "degraded mode" (FR-26). Architecture will need a canonical state enum and story creation will need consistent badge names; today each consumer must reverse-engineer the set and guess whether "suspect" and "validating" are one state or two. *Fix:* a six-line glossary pinning the reading states (e.g., validated / suspect / stale / faulted) and the dispatcher-visible badge for each.
- **low** Label drift on the same concept (FR-4 vs. FR-26) — FR-4's "freshness indicator" and FR-26's "per-truck age badges" appear to be the same UI element under two names. *Fix:* pick one term (the glossary above absorbs this).

## Shape fit — strong

The shape is exactly right for the product and audience: capability-spec FR groups (A–G) for an internal single-role tool, with precisely one UJ deployed where narrative earns its keep — the two-dispatcher concurrency flow, which is the only part of this product that needs a story to be understood, and which paid for itself by generating FR-31. Success criteria are evaluator-shaped rather than DAU-shaped, which matches the real customer. Tech choices living in the addendum is a stated house decision, and the addendum correctly limits itself to material the PRD's consumers (architecture, DECISIONS.md, README) will extract. No over-formalization — four personas and a market-differentiation section would have been theater here, and none exist.

## Mechanical notes

- **Assumptions roundtrip:** no scattered inline `[ASSUMPTION]` tags; all assumptions are consolidated in the Tunable Constants table and referenced by OQ-3. Roundtrip trivially satisfied — arguably a better pattern than tag-and-index at this scale.
- **ID continuity:** FR-1–33 complete, no duplicates. FR-31/32/33 are filed in their functional groups (C, E, F) rather than in numeric sequence — deliberate and annotated, but story tooling that assumes numeric ordering within sections should be warned.
- **Test-count claim checks out:** §5's "Nine or more cases total" = 1+1+3+1+1+1+1 = 9. Note the ninth (circuit breaker, FR-25) is self-imposed Tier-2 work; if Tier 2 is cut, the count lands exactly on the mandated 8 with no margin.
- **Name drift, trivial:** front-matter/addendum say "Fleet-Pulse," body says "FleetPulse."
- **Stale scaffolding label:** addendum heading "Notes for Architecture (to be filled during PRD conversation)" — the section is already filled; drop the parenthetical.
- **Cross-refs:** all spot-checked references resolve (see Downstream usability). "§5" is used for both NFRs and the test matrix/constants since they share a section; unambiguous in context.
