# FleetPulse — Trust Model

The product's core domain vocabulary. Every view, badge, selector, and test uses these five states and these classification policies; nothing invents a sixth state or a parallel rule. Thresholds referenced here live in [constants.md](constants.md); the requirements that impose them are FR-4 through FR-9, FR-20, FR-26 in [requirements.md](requirements.md).

## The five trust states

A displayed value is always in **exactly one** state, and each is visually distinct.

| State | Meaning | What the dispatcher sees | Assigned by |
|---|---|---|---|
| **Trusted** | Validated and current | The value, plain | Pipeline classification |
| **Suspect** | Plausibility under review | Last trusted value + "validating" badge | Pipeline classification |
| **Sensor fault** | Reading rejected as impossible | Last plausible value + fault badge; raw value in the anomaly log | Pipeline classification |
| **Stale** | No fresh contact beyond the staleness threshold | Age badge on the truck | Store selector (arrival clock) |
| **Degraded** | A system-level data source is down | Global banner naming the condition | Store selector (health slice) |

**Where each is decided.** Plausibility trust (trusted / suspect / sensor fault) is assigned by pipeline filters and nowhere else. Stale and degraded are layered on top by one store selector — the single trust source every widget reads. This is what keeps "exactly one state" true across views instead of each widget re-deriving it.

**Granularity.** Trust is per **signal**, not per truck: speed, fuel, temperature, and position each carry their own trust envelope, so a faulty speed sensor does not make the fuel reading look suspect.

**Cold start.** Before any trusted history exists — first load, or after a fleet reset — a value renders "no trusted reading yet". Never a guess, never a zero (FR-5).

## Classification policies

### Speed (FR-7)

Two thresholds, three outcomes:

- `speed > sensor-fault ceiling` → **sensor fault**. Truck #7's stuck 999 km/h sits far above the ceiling. The raw value is logged, the last plausible speed is shown, and recovery clears the badge.
- `overspeed limit < speed ≤ ceiling` → **trusted, and a real overspeed alert** reaches the dispatcher immediately, from the first reading. This branch is the CM1 guarantee: a genuine emergency is never explained away as a sensor bug.
- `speed ≤ overspeed limit` → **trusted**.

### Fuel 0% (FR-8) — hybrid policy

A 0% reading is not a value, it is a question. Which branch it takes depends on what was trusted before it:

- **(a) Prior trusted level already low** (≤ the "already low" threshold) → plausible → **alert immediately**.
- **(b) Cliff-drop from a healthy level** → implausible → **suspect**: the last trusted value is shown with a "validating" badge while the window runs.
- **(c) 0% persists past the suspect window** → **accepted as real and alerted**.

Three rules govern the window:

1. **The window is measured in reading timestamps, not wall-clock arrival.** A batch whose readings already span the window — recovery included — resolves on the spot with no artificial wait.
2. **A window that closes with no further readings at all resolves to real** and alerts. Silence is not reassurance.
3. **Ordering runs first.** A 0% older than the current trusted state is discarded by FR-6 upstream and never reopens a window.

### The tie-break rule

**Uncertainty always fails toward alerting, never toward suppression** (CM1). This binds every classifier, including ones registered later: a rule that cannot decide must alert. A masked real emergency is a far worse failure than a false alert, and the counter-metric is tested explicitly.

## The two clocks

Confusing these two is the single easiest way to get this product wrong, so they are named separately everywhere in code and tests.

| Clock | What it is | What it drives |
|---|---|---|
| **Reading timestamp** (`readingTs`) | When the sensor took the reading | Ordering, backfill, dedupe, the fuel suspect window |
| **Arrival clock** (`arrivalTs`) | When the client accepted the reading | Staleness only |

Consequences that follow directly:

- A GPS batch replaying ten-minute-old timestamps still counts as **fresh contact** — the truck is talking to us. It is not stale.
- Staleness means **silence**, not rejection: every parsed reading refreshes the arrival clock, accepted or rejected.
- A suspect window never expires because wall-clock time passed with the stream idle; it expires on reading timestamps, or on the no-further-readings rule above.

## Anomaly record

Every rejection and every suspect resolution writes one entry — `{ruleId, truckId, rawValue, readingTs, arrivalTs}` — to the single bounded anomaly log (FR-9). Raw rejected values exist **only** there; they never reach a widget as a value. The log is what makes FR-29 ("is this a real problem or a sensor bug?") answerable, and it is wiped by a fleet reset along with the rest of derived state.
