# PROMPTS.md — AI Usage Journal

Chronological journal of AI usage across this project. Each entry records: the goal, how AI was used, what the AI produced, and — most importantly — **what I decided, corrected, or rejected**. Maintained live during the work, not reconstructed afterwards.

---

## Entry 1 — 2026-08-18 — PRD authored with AI facilitation

**Tool:** Claude Code (Fable 5) with the BMad PRD skill — a facilitated, coaching-style PRD workflow.

**Goal:** Break the assignment down into a spec before writing any code (spec-driven development). Produce a PRD with stable requirement IDs that commits, DECISIONS.md, and tests can trace back to.

**How the AI was used:**
- I provided the assignment PDF as the source input; the AI reconciled every assignment requirement, server quirk, WS message type, and evaluation parameter against the draft and reported coverage.
- I chose to hand over the full PDF rather than retype its contract by hand — full-document context avoids the transcription drift a manual, partial copy would risk across 34 requirements, 8 quirks, and 9 endpoints, and it's what let the reconciliation above catch every one of them instead of only the ones I happened to remember to mention. The "used AI tools iteratively" bar the assignment's SDD criterion actually names is everything that follows from here: the section-by-section coaching below, the two-pass review gate, the fuel-glitch policy I pushed back on and corrected, and the ten build-phase entries in the repo's own `PROMPTS.md` that carry this same discipline through every story.
- The AI facilitated section-by-section: it asked, I decided. It drafted prose from my decisions and flagged its own inferences as `[ASSUMPTION]`.
- The AI ran an adversarial review gate: three parallel reviewers (quality rubric, a simulated assignment evaluator, an adversarial edge-case hunter) against the draft. Findings were triaged with me one by one.

**What I decided (not the AI):**
- The vision and framing ("the problem is trust, not data") and the project north star: *we are not building the prettiest dashboard; we are building a dashboard the dispatcher can trust.*
- Scope: which three bonus features to build (circuit breaker, observability panel, side-by-side conflict resolution) and which to cut, with a ranked stretch tier.
- All telemetry display policies: last-known-good + fault badge for stuck speed, latest-position + trail for GPS batches, global banner + per-truck age badges for degraded mode.
- The fuel-glitch policy — where I **corrected the AI**: its first proposal was a time-debounce only; I pushed back ("why is checking the prior value hard?") and the final hybrid policy (plausibility check + debounce, failing toward alerting) came out of that exchange.
- The conflict UX narrative (UJ-1): what each dispatcher sees before, during, and after a clash — narrated by me, structured by the AI.

**Output:** `prd.md`, `addendum.md`, source-reconciliation report, three review files, and this journal. The AI's review gate caught a real contradiction in my spec (overspeed masking vs. the no-suppressed-emergencies principle) before any code existed — that is exactly what the spec-first pass was for.

---

## Entry 2 — 2026-08-18 — Decision transcript, PRD session

The PRD session ran as facilitated Q&A: the AI asked, I ruled. This transcript records every question put to me and my decision, translated from Hebrew (the session language). The AI's recommendations are omitted by design — this journal documents **my** steering; the resulting spec text lives in `prd.md`.

### Setup

| The question put to me | My decision |
|---|---|
| Which working mode — fast batch-draft, or coached section-by-section? | Coaching path — we build it together; better preparation for the defense interview. |
| Should the PRD ship in the submission repo as SDD evidence? | Yes — written so an evaluator can trace every requirement to its implementation and test. |
| Which stack? | React + TypeScript. |
| Entry point — capability-first or journey-led? | Vision + Features (capability-first). |

### Vision and framing (my own words)

| Prompt | My input |
|---|---|
| State the vision in your own words. | "FleetPulse gives the dispatcher a real-time picture they can trust — truck positions, status, and sensors — alongside route management coordinated between dispatchers. The system detects and isolates unreliable data and conflicts in real time, so the dispatcher makes correct decisions instead of acting on wrong or stale information." |
| What does success mean for you personally? | "A small but production-minded system where the hard parts are handled correctly, not just 'working' in the ideal scenario. I want to stand out on architecture, real-time data and concurrency handling, and test quality. The evaluator should see code that is easy to understand and extend, be able to trace an assignment requirement to its implementation and test, and feel the system was designed for real faults, not just the happy path." |
| *(Volunteered, unprompted)* | "We are not trying to build the prettiest dashboard. We are trying to build a dashboard the dispatcher can trust." — became the PRD's north star. |

### Scope

| The question put to me | My decision |
|---|---|
| Does the A–G feature grouping fit how you think about the system? | Approved as proposed. |
| Which bonus features are in? | Circuit breaker, observability panel, side-by-side conflict resolution. |
| *(Volunteered)* Deadline extended to 2026-08-19. | Remove the 4–8h time-box from the PRD. |
| *(Volunteered)* Can we add more bonuses if time remains? | Yes — a ranked stretch tier, entered only after everything else is green. |

### Telemetry policies

| The question put to me | My decision |
|---|---|
| What does the dispatcher see during the stuck-speed fault? | Last plausible speed + a sensor-fault badge; the raw value goes to the anomaly log. |
| How do we distinguish a fuel glitch from a real 0%? | I challenged the initial time-debounce-only direction — "why is checking the value before the 0% hard to implement and test? and can the glitch exceed 5 seconds?" — and chose the hybrid policy: plausibility check + debounce, always failing toward alerting. |
| How does a GPS batch render on the map? | Latest position + a thin trail polyline of the batch. |
| How does staleness look in degraded mode? | Global banner + per-truck age badges. |

### Conflict journey (I narrated; the AI structured it into UJ-1)

| Prompt | My input |
|---|---|
| What does Dana see the moment she opens the route? | An indicator that Yossi is currently looking at it — like a shared document showing who is on it. |
| What happens on her screen when Yossi saves first? | If a change can be marked live without complicating the system — it is worth doing. |
| She saves and gets a 409 — what exactly is on her screen? | A clear message that the route was changed, and who changed it. |
| What does Yossi see meanwhile? | That Dana is on it; not necessarily anything beyond that. |

### Review-gate rulings (three AI reviewers ran; each fix was proposed to me, I ruled)

| The question put to me | My decision |
|---|---|
| Which review gate to run before polish? | The full gate: quality rubric + simulated evaluator + adversarial reviewer. |
| How to handle the six critical/high findings? | Walk them one by one. |
| When does a real overspeed (between the limit and the ceiling) alert? | Immediately, from the first reading. |
| UI behavior while a route mutation is in flight? | Pessimistic UI with an in-flight indicator — the screen changes only on server confirmation. |
| Where does the full side-by-side conflict resolution live? | Promoted to Tier 1 — not cuttable. |
| The fuel suspect window closes with no further readings — what happens? | Alert (fail toward alerting). |
| How does a presence entry with no sign of life leave the list? | Single-stage removal after ~30 seconds. |
| Creating a route for a truck that already has an active one? | Warning + explicit confirmation — not a hard block. |
| The remaining medium/low findings? | Apply all as proposed. |

### This journal

| Prompt | My input |
|---|---|
| How should the journal record the session? | My call: record the questions put to me and my rulings, omitting the AI's recommendations — the journal documents my steering, and the evaluators need to see my prompts. |

---

## Entry 3 — 2026-08-18 — PRD update: the mock server is self-built

**Trigger:** I confirmed verbally with the interviewer that the mock server is **not** provided — the PDF's "provided as a single file" wording is inoperative. I author `server.js` myself, from the brief's client requirements. The contract itself is unchanged: Express + `ws` only, HTTP :3000, WS at `/ws`, SSE at `GET /api/telemetry/stream`, 12 trucks, eight failure modes.

**How the AI was used:** I had the AI run a contained update pass over the finalized PRD with this change signal. It located every spot the provided-server assumption touched — context header, failure-mode table, FR-13, FR-18, UJ-1, scope, sequencing, deliverables, open questions, and the addendum's server-contract notes — applied the reconciliation, and swept the documents for stale wording afterwards.

**What changed (my rulings):**
- OQ-4 and OQ-5 flipped from protocol verifications to design decisions resolved in our favor: every 409 carries the conflicting dispatcher's identity (FR-13, fallback deleted); `viewing_truck` accepts null meaning "viewing nothing" (FR-18).
- OQ-3 reframed: the tunable constants are now authoritative, not observed — server emission parameters and client thresholds get fixed together at architecture, from one source of truth.
- Building `server.js` becomes the first story and an architecture design surface; new OQ-6 records dev-only, contract-neutral deterministic quirk triggers as a testing and defense-demo asset.
- The contract boundary held: we implement the brief's protocol faithfully rather than extend it — truck-level presence stays the honest proxy in UJ-1.

---

## Entry 4 — 2026-08-18 — SPEC kernel distilled, and the build sliced into stories

**Tool:** Claude Code (Opus 5) with the BMad spec skill, run against the finalized PRD, its addendum, and the architecture spine.

**Goal:** Collapse three planning documents into one machine-readable contract the build phase consumes directly, then slice that contract into independently reviewable stories before writing any code.

**How the AI was used:**
- I pointed the spec skill at the finished planning set. It distilled the five-field kernel — why, capabilities, constraints, non-goals, success signal — and pushed the line-item detail into four companion files rather than bloating the kernel.
- It ran a two-pass self-validation: a coherence pass against the spec rules, and a preservation pass walking the sources claim by claim to confirm nothing load-bearing was dropped. A sweep verified FR-1 through FR-34 and NFR-1 through NFR-9 all survived the distillation, and that every companion path resolves on disk.
- The architecture spine is referenced as an adopted companion rather than absorbed — it keeps its own owner, and the spec cites it instead of copying it.
- Story breakdown ran as a conversation: the slicing was put to me, I revised it, and I set the review gates.

**What I decided (not the AI):**
- Distil to a spec kernel now rather than going straight from PRD to epics — the build phase gets one contract to read instead of three documents to reconcile.
- The journal convention holds for this session too: record the questions put to me and my rulings, omitting the AI's recommendations.
- **The slicing.** I first took a fourteen-story breakdown, then pulled it back toward consolidation. Final call: **ten stories** — server contract and failure modes merged into one, store and pipeline merged, detail panel merged with resilience, observability merged with documentation. The one merge I refused was routes with conflict resolution: the side-by-side chooser is the challenge the brief flags as senior-level, and folding it in with routine route CRUD would have diluted the review gate I wanted on exactly that slice.
- **Presence before routes.** Mutations stay disabled while a dispatcher is unregistered, so the presence story has to land before the route stories or the route work cannot be exercised end to end.
- **Two spec review gates:** the trust engine (where the mandated tests live) and the conflict flow. Nothing else needs a human read of the story spec before implementation.
- **One dispatch pause:** after `server.js` is complete and every failure mode can be fired by hand. Nothing client-side is worth starting until the substrate it classifies is real and controllable.
- **No per-story dispatch notes.** Everything binding already sits in the spec and its companions; a note appended to the dispatch prompt would only be a second, drifting copy.

**Output:** `_bmad-output/specs/spec-Fleet-Pulse/` — `SPEC.md` (ten capabilities, thirteen constraints, seven non-goals, five assumptions, no open questions), companions `requirements.md`, `trust-model.md`, `constants.md`, `test-matrix.md`, and `stories.yaml`. All six open questions carried by the PRD are now closed.

**Still open in this journal:** the architecture spine was produced in an unattended run and has no entry of its own here. Its four resolved open questions — the SVG grid over a map library among them — are recorded as assumptions in the spec and are mine to override before the build starts.
