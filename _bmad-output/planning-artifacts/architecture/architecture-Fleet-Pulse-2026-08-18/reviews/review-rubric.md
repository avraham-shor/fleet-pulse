# Rubric Review — ARCHITECTURE-SPINE.md (Fleet-Pulse)

**Reviewer:** rubric walker (architecture-spine reviewer gate)
**Date:** 2026-08-18
**Target:** `_bmad-output/planning-artifacts/architecture/architecture-Fleet-Pulse-2026-08-18/ARCHITECTURE-SPINE.md`
**Inputs read:** spine (full), `prd.md`, `addendum.md`

## Verdict: CONDITIONAL PASS

No critical findings. One high finding (an internal contradiction inside the spine's load-bearing dependency rule) plus three mediums; all are one-line fixes. Fix H1 and the mediums before the epics build against the spine — everything else is polish.

---

## Findings

### Critical

None.

### High

**H1 — AD-1's rule text contradicts its own diagram on who may import the store.** *(checklist 2, 7)*
- **Anchor:** AD-1 — "the only legal import directions are the arrows below" + "`pipeline/` imports only `contract/` and `shared/constants.js`", vs. diagram edges `PIPE --> STORE`, `WS --> STORE`, `API --> STORE`.
- The rule declares the arrows to *be* the legal import directions, then the text forbids `pipeline/` from importing anything but `contract/` and constants — while the diagram draws pipeline→store, ws→store, and api→store edges. Two builders can legitimately read this two ways: pipeline imports the store directly, or `app/` injects a commit callback. That is exactly the class of divergence AD-1 exists to prevent, sitting inside AD-1 itself.
- **Fix:** one sentence deciding it — e.g. "diagram arrows are dataflow; store access from transport/pipeline is via commit/action callbacks wired by `app/`" — or drop the import-restriction sentence and let the arrows be imports.

### Medium

**M1 — NFR-7 input-validation placement is undecided.** *(checklist 1, 6)*
- **Anchor:** Capability Map "Security (NFR-4..8)" row; AD-7; Consistency Conventions (no validation row).
- FR-10, FR-22, and NFR-7 require validation "before submission", but no AD or convention says *where* it lives — route-dialog components, `api-client`, or a shared validators module. Two mutation surfaces (route create/edit, truck alert) can diverge.
- **Fix:** one convention row: e.g. "input validation: shared validator functions per mutation, called by forms pre-submit; `api-client` refuses payloads that fail them."

**M2 — The staleness clock has no tick owner.** *(checklist 1, 2)*
- **Anchor:** AD-3 ("one store selector derives effective trust by layering stale (per-truck arrival clock)"), AD-9 (age badges from that selector).
- Stale flips as wall time passes with *no* event arriving, so something must periodically re-evaluate the selector. Unowned, each widget grows its own `setInterval` — a divergence AD-3 half-prevents. (Contrast: the presence liveness sweep *is* assigned, to the presence slice, in AD-8.)
- **Fix:** one clause assigning a single constants-defined staleness tick (in `app/` or the health/fleet slice) that all consumers ride.

**M3 — Ghost-disconnect delay: spine says "fixed 10 s", PRD says "delayed up to 10 s".** *(checklist 5)*
- **Anchor:** AD-2 ("ghost disconnect 20% chance with a fixed 10 s delay") vs. PRD §3 failure-mode table #6 and FR-19 ("disconnect arriving late (up to 10 s)").
- AD-2's own rule is "where the brief fixes a value, the constant is the brief's." If the assignment PDF says *up to* 10 s, a fixed delay is a contract deviation authored into the constants module; if the PDF fixes 10 s, the PRD wording is loose. The reconcile pass should have caught whichever way it falls.
- **Fix:** verify against the PDF; if "up to", make the constant a 0–10 s range (a free-parameter distribution per AD-2's own free-parameter clause).

### Low

**L1 — Capability Map rows omit governing ADs their FRs depend on.** *(checklist 5)*
- **Anchor:** Capability → Architecture Map rows E, F, G.
- Row E (FR-22 alert mutation, FR-32 broadcast) omits AD-7 and AD-8; row F (FR-28 widget containment) omits AD-6, whose error-boundary rule is FR-28's actual enforcement; row G (ping/pong RTT) omits AD-8, where the measurement lives.
- **Fix:** add AD-7/AD-8 to E, AD-6 to F, AD-8 to G.

**L2 — FR-15 audit-trail source is ambiguous.** *(checklist 1)*
- **Anchor:** ER diagram (`ROUTE ||--o{ AUDIT_ENTRY`), Deferred ("Route audit-trail entry shape"), AD-11 (endpoint list).
- The deferral covers the entry *shape*, but not whether the trail is client-accumulated from WS route events (session-scoped, late joiners see a partial trail) or served by an endpoint. The server epic and the routes epic could each assume the other owns it.
- **Fix:** one line: "audit trail is client-accumulated from WS route events, session-scoped; no endpoint" (or the reverse, if the PDF's ten endpoints include one).

**L3 — `status: draft` after the reconcile pass.** *(checklist 8)*
- **Anchor:** frontmatter line 8.
- With reconcile fixes applied and submission due 2026-08-19, `draft` misstates the artifact's maturity to downstream consumers.
- **Fix:** flip to `reconciled` / `approved` when this gate closes.

**L4 — Lint/format dimension is silent.** *(checklist 6)*
- **Anchor:** Consistency Conventions (styling/tests rows exist; no lint row); Structural Seed.
- Minor for a two-day solo build, but the scaffold ships ESLint config and nothing says it governs; a one-liner closes the dimension instead of leaving it implicitly decided.
- **Fix:** one convention line: "lint: scaffold ESLint config as-is; no added tooling."

**L5 — AD-7 reads `dispatcherId` from "presence/session state", but no session slice exists.** *(checklist 2)*
- **Anchor:** AD-7; Structural Seed store slice list (fleet, routes, presence, health, obs).
- "presence/session" hedges between two homes for the client's own identity.
- **Fix:** name it — "own identity lives in the presence slice" (and delete "/session").

---

## Checklist walk

1. **Divergence points fixed?** Largely yes — the fifteen ADs hit every real seam between the eight epics (constants coupling, trust vocabulary, clocks, single commit path, mutation gate, connection ownership, contract fidelity, history path). Gaps: M1 (validation placement), M2 (staleness tick), L2 (audit-trail source).
2. **Rules enforceable?** Yes — nearly all are grep-able or review-decidable ("a tunable literal anywhere else is a defect", "no component calls fetch", boundedBuffer-only, contract test). Exception: H1's self-contradiction makes AD-1 enforceable in two incompatible ways; L5 is a wording wobble.
3. **Deferred safe?** Yes. Each deferral is bounded by a named AD (wire schemas by AD-13's verbatim rule + contract test; backfill by AD-15's single path; widget internals by AD-6; slice internals by AD-5). No deferral lets two units diverge. L2's ambiguity sits *next to* a deferral, not inside it.
4. **Tech verified-current?** **Independently confirmed 2026-08-18**: all nine npm packages in the stack table match the registry's latest exactly (react 19.2.8, zustand 5.0.15, vite 8.2.1, vitest 4.1.10, express 5.2.1, ws 8.21.3, concurrently 10.0.5, @testing-library/react 16.3.2, typescript 7.0.2). Node 24 LTS is consistent with the current LTS line. The "lockfile governs after install" and "keep scaffold TS pin" hedges are correct practice.
5. **Covers the PRD?** Yes — the Capability Map accounts for FR-1..34 with no gaps (A:1-4, B:5-9, C:10-15+31+34, D:16-19, E:20-23+32, F:24-28+33, G:29-30), all of NFR-1..9, and the server deliverable with its 8 failure modes. Deductions: M3 (a parameter that may contradict the brief) and L1 (map rows under-citing their governing ADs).
6. **All owned dimensions decided/deferred/open?** Yes — notably the operational envelope is *explicitly* decided, not silent: "Local-only: no deploy, no persistence, no CI — the submission runs on the evaluator's machine", plus run/test commands, proxy topology, port, browser target, git convention. Error handling, testing, security, styling, state, naming, time, ids all have homes. Only L4 (lint) is silently inherited.
7. **Mermaid valid and real?** Yes — all three diagrams parse (flowchart TD, flowchart LR with subgraphs and `<-->`/`-.->` edges, erDiagram with valid cardinalities) and carry real structure: the layer/import graph, the runtime three-channel topology, and entity relationships. Deduction folded into H1: the first diagram's edges are declared "import directions" while the text contradicts three of them.
8. **Terse?** Yes — decisions over rationale throughout, seed is minimal, no placeholders or template comments. AD-14's one rationale clause ("deterministic, dependency-free, offline-safe…") is a forgivable single line. L3 (stale `status: draft`) is the only housekeeping smell.

## Condition for pass

Apply H1 and M1–M3 (four one-line edits plus one PDF check). L-items at the author's discretion before submission.
