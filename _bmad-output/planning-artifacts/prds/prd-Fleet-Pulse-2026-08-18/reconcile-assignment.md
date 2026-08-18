# Source Reconciliation — Assignment PDF vs. prd.md + addendum.md

Input: `FE-Senior-FleetPulse-Fleet-Management-Kit-Assignment.pdf` (v1.0, Feb 2026).
Run parent-side (assignment fully in facilitator context; no savings from a subagent).

## Coverage

| Assignment item | PRD coverage |
|---|---|
| Req 1 — Fleet overview: 12 trucks live via SSE; status distinction; GPS batch; out-of-order; stuck speed; fuel glitch; 503 retry | FR-1, FR-2, FR-3, FR-6, FR-7, FR-8, FR-24 |
| Req 2 — Routes: create; status transitions; 409 + WHO; If-Match; reassign; audit log | FR-10, FR-11, FR-13, FR-12, FR-14, FR-15 |
| Req 3 — Presence: register; active list; viewing indicator; ghost handling | FR-16, FR-17, FR-18, FR-19 |
| Req 4 — Detail panel: telemetry; charts/gauges; alerts; route details | FR-20, FR-21, FR-22, FR-23 |
| Req 5 — Tests: 6 mandated areas, ≥8 cases | §5 test matrix (9+ cases) |
| Bonuses chosen: circuit breaker; observability panel; side-by-side conflict resolution | FR-25, FR-30, FR-13 (full form); Tier 2 in §6 |
| Bonuses declined: geofencing; anomaly dashboard; keyboard shortcuts; filterable view | §6 Tier 3 (stretch, ranked) + explicit exclusion rationale |
| Technical: npm start / npm test; unchanged server; README; PROMPTS.md; Chrome-only | §7 deliverables; §6 out-of-scope |
| Evaluation parameters (6) | §2 mapping table |
| Security specifics: X-Dispatcher-Id, If-Match, confirmations, input validation | NFR-4–NFR-8, FR-10, FR-12, FR-14 |
| Performance specifics: 12×2s, bursts, bounded history, 8h no-leak, throttled rendering | NFR-1–NFR-3, §5 constants |
| Observability: stale indicators, visible errors, anomaly metrics | FR-4, FR-26, FR-9, FR-29, FR-30 |
| Qualitative: "dashboard dispatchers can actually trust"; conflict UX as design challenge; data pipeline over CSS | North star (§1); UJ-1 (§4); §6 out-of-scope |

## Gaps found → resolved

1. **`truck_alert` WS broadcast had no consumer.** Req 4 only mandates *sending* alerts, but the server broadcasts them to all dispatchers — shared awareness was silently dropped. → **FR-32** added.
2. **`fleet_reset` (and unknown) WS messages unhandled.** A dev reset mid-session could desync or break the UI. → **FR-33** added.

## Remaining gaps

None. All assignment requirements, quirks (8/8), WS message types, endpoints, evaluation parameters, and qualitative signals are covered or explicitly scoped out with rationale.
