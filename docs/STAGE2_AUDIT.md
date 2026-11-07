# Stage 2 — Core Aircraft Boarding Simulator

This checklist stage audits the existing aircraft engine. It is distinct from the earlier locally developed **Phase 2 passenger-aware boarding** features. Those uncommitted files and behaviors are preserved locally and excluded from this commit, except for the pure post-run constraint checker reused here as a core simulator-verification dependency. This work adds verification, metrics and trace-contract gaps; it does not add strategies, a dashboard, a viewer UI or machine learning.

## Five-item completion checklist

| Item | Initial assessment | Missing pieces implemented | Verified status |
| --- | --- | --- | --- |
| 1. Entry, single-aisle walking, stowing and seating | Complete: existing spatial tick engine handles all four, with concurrent work at different rows | No physics rewrite; additional analytical trace tests | Complete |
| 2. Occupancy/blocking, interference, parties and additional time | Complete: one occupant per cell, no passing, same-side seat blockers, party adjacency, assistance time and escort reservations | Explicit start/end events for blocking, assistance and interference; tests for both seat sides and late companions | Complete |
| 3. Completion, mean gate wait and passenger-minutes blocked | Partial: all calculations existed, but blocking minutes were only derived for CLI display | Added structured `aisleBlockingPersonMinutes` and stronger per-passenger/aggregate reconciliation | Complete |
| 4. Trace inspection for impossible movement, collisions, queues and timing | Partial: prior tests replayed cell exclusion but did not fully verify speed, unexplained waits, service phases or corrupted timestamps/totals | Independent tick-by-tick validator, stricter timing audit and adversarial tests | Complete within the stated cell model |
| 5. Structured events for a future viewer and one engine across strategies | Partial: existing structured events and shared engine; no versioned replay geometry/contract or complete blocking/phase intervals | Version 1 trace envelope, deterministic chronological indices, replay metadata, validation CLI and documented event contract | Complete; viewer UI intentionally absent |

No additional Stage 2 checklist requirement remains missing. Modeling limitations below are retained assumptions, not claims of real-world calibration.

## Existing physics retained

Cell 0 represents the aircraft entrance; cells 1–30 represent aisle positions beside the seat rows. Each holds at most one passenger. Walkers move at most one cell per tick and honor their sampled walking interval. Rear-to-front updates allow a line to advance together without passing. A passenger holds the assigned row cell through assistance, luggage stowing, seat interference and seating. Other rows can work concurrently.

Additional time includes the configured assistance duration and the fixed penalty per already seated same-side blocker. It does not add these durations globally to calculate completion. Parties remain consecutive, wait for all members' actual arrivals, and retain existing protected-stage/companion rules. Assisted parties reserve an empty aisle and escort until the entire party is seated.

The new event bookkeeping does not change admission order, movement, service samples or eligibility. Tests compare traced and untraced metrics/timings directly and retain original seed-42 completion times. Existing local adaptive policies still receive only their prior observation/cabin allowlist; trace metadata and completed-run truth are not policy inputs.

## Run and inspect

From `BoardingFlow`:

```powershell
node src/cli.js demo --seed 42 --output results/stage2 --trace
node src/cli.js validate-trace --input results/stage2/manifest.json --trace-file results/stage2/events-random.json --output results/stage2/validation-random.json
node src/cli.js validate-trace --input results/stage2/manifest.json --trace-file results/stage2/events-zone.json --output results/stage2/validation-zone.json
node src/cli.js validate-trace --input results/stage2/manifest.json --trace-file results/stage2/events-baggage-aware.json --output results/stage2/validation-baggage-aware.json
node --test
```

Normal `simulate --trace` and `compare --trace` use the same engine and automatically validate their new traces. The separate unpublished Phase 2 scenario commands continue working in the full local workspace. `validate-trace` exits nonzero for invalid files; `--output` is an optional JSON validation report. The CLI requires a full configured aircraft, while the test API supports explicitly partial/empty flights.

Generated evidence stays under the already gitignored `results/stage2/`; earlier datasets and output folders are not overwritten by these commands.

## Version 1 trace envelope

`events-<strategy>.json` retains the existing `dataKind`, `strategy`, `inputHash` and `events` keys and adds:

| Field | Meaning |
| --- | --- |
| `traceSchemaVersion` | Trace contract version, currently 1; separate from passenger-manifest schema version |
| `metadata` | Engine name, time unit/origin, tick interval, geometry, supported event types and passenger-to-seat/unit/stage mapping |
| `metadata.geometry` | Row count, A–F seat letters, entrance cell 0 and capacity one per aisle cell |
| `metadata.passengers` | IDs, seats, target rows, boarding units/stages and quantized walking-step seconds |
| `metrics` | Reported run totals, checked against independent replay |
| `validation` | Engine's post-run replay report; a later validator recomputes rather than trusting it |

Each event has `timeSeconds`, `type`, `sequence` and `eventIndex`, plus type-specific fields. Times are relative to boarding opening and aligned to the configured tick grid. `eventIndex` is the chronological array position. `sequence` is a unique emission identifier; it need not increase chronologically because service-boundary events are scheduled in advance. Same-time physical ordering is cell release, walking, then gate admission. Cell occupancy uses half-open intervals.

| Event family | Payload and interpretation |
| --- | --- |
| `stage_opened`, `unit_called` | Current protected stage, unit ID, member IDs and assistance arrangement |
| `boarded` | Passenger ID, assigned seat, unit/stage and entrance cell 0 |
| `moved` | Passenger ID, `fromCell`, and destination `cell`, always one cell forward |
| `row_service_started` | Row cell, actual seated blockers, assistance/stow/interference/seating durations and service-end time |
| `assistance_started/completed`, `stow_started/completed` | Explicit service-phase boundaries; stow start includes piece count |
| `seat_interference_started/completed`, `seating_started`, `seated` | Seat access and final seating; zero-duration phases have no start/end pair |
| `aisle_block_started/ended` | Waiting cell, occupied next cell/blocking passenger at start, and total interval seconds at end |
| `gate_entry_block_started/ended` | Ready passenger prevented from entering by occupied cell 0, then the blocking interval's end immediately before admission |
| `escort_released`, `boarding_completed` | Party assistance reservation ends; all passengers are seated |

A viewer can reconstruct cell positions and service/waiting states from this contract. Positions are discrete row cells, not measured aircraft coordinates. Timing JSON/CSV intentionally excludes trace-only metadata so physical outcomes are identical with and without `--trace`.

Older unversioned trace files are left untouched. Their `events` arrays remain readable by existing consumers, but the new strict validator requires the new metadata/interval contract: regenerate an old trace with the current engine and `--trace` to validate it. Existing passenger schema 1 inputs remain supported.

Full trace files contain completed-run truth, including future service boundaries. They are replay/evaluation artifacts and must not be used as live adaptive-policy input.

## Independent validation

The validator replays every tick, including ticks without events. It checks:

- Manifest fingerprint, replay metadata, event types, unique identifiers, chronological indices, finite nonnegative grid-aligned times and exactly one final completion.
- Exactly-once admission/seating, correct seats and actual arrival/clearance restrictions; no skipped priority/preboarding, party splitting or escort overlap.
- Gate headway, one-cell moves, sampled speed, correct target rows, exclusive cells, no passing and no movement during row service.
- Every ready aisle walker progresses when its next cell is clear. Waiting must identify an occupied next cell and have a matching blocking interval. Peak occupancy cannot exceed the entrance plus row cells (31 for this aircraft).
- Assistance, stowing, interference and seating boundaries match the configured/sample durations and actual same-side blockers. Missing, duplicate, early or overdue service phases fail.
- Closed gate/aisle blocking intervals, individual time reconciliation and recomputed completion, gate waiting, blocking, stowing, interference and occupancy totals.

The regular timing audit also rejects non-finite/negative values, off-grid times, impossible headway, false gate waiting, wrong service durations and inconsistent aggregate metrics without requiring a trace.

Intentional gate idle time for late arrivals, required stages, assistance or an existing strategy is valid. “No unexplained queues” refers to physically ready **aisle** walkers; it does not prohibit operational gate holds or assert that all queues are short in real life.

## Actual verification results

Baseline: **59/59 tests passed** before Stage 2 edits. The full workspace suite passes **76/76 tests**, including unpublished Phase 2 integrations. The standalone Stage 2 snapshot passes **55/55 tests**: the 38 published Stage 1/core tests plus all 17 new Stage 2 tests. Neither suite has failures, skips or cancellations. Logs are generated evidence and excluded from the commit.

The new tests include analytical single-passenger assistance, concurrent stowing, the known nine-second follower delay, both seat sides, a slow leader/fast follower, late companions, 0.1/0.5/1-second ticks, a dense all-bag 180-passenger queue, empty flights, deterministic exports, invalid traces and CLI validation.

Measured seed 42, unchanged default Stage 1 manifest:

| Strategy | Completion m:ss | Mean gate wait, min | Aisle blocking, passenger-min | Peak aisle occupants | Events validated | Constraint violations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Random | 27:04 | 20.55 | 179.73 | 22 | 5530 | 0 |
| Zone | 29:56 | 21.26 | 258.67 | 30 | 5986 | 0 |
| Baggage-aware | 23:46 | 20.38 | 172.47 | 25 | 5672 | 0 |

All three exported traces were independently revalidated by CLI: 180 seated exactly once each. The original shared-input fingerprint remains:

```text
eb9f89cd273967c5c31cf31b566818af49694bcd7449ac2a89cdc5f4c051973f
```

Gate wait includes pre-opening time. Aisle blocking is passenger-time, not wall-clock time; the explicit JSON value is seconds divided by 60, rounded to six decimals. Own row service is excluded from aisle-blocking time. Gate-entry blocking is also experienced as gate wait, so those metrics should not be added as independent elapsed components.

## Files changed and remaining limitations

- `src/simulate.js`: additive event boundaries/metadata, explicit blocking minutes and stronger timing/metric audits; existing ordinary strategy selection retained; optional Phase 2 hooks remain local outside this commit.
- `src/trace.js` (new): trace schema/envelope and independent replay validation.
- `src/constraints.js` (new): shared pure post-run checks of arrival, seating, priority, party and assistance constraints; contains no terminal model, readiness observer or adaptive policy.
- `src/io.js`: versioned trace export and minute-unit documentation; preserves trace-independent timing artifacts.
- `src/cli.js`: `validate-trace` command.
- `test/stage2.test.js` (new): 17 Stage 2 verification tests.
- `README.md`, `docs/MODEL.md`, this file: usage, schema, audit and evidence.

This validates consistency of the simplified model, not real-world realism or calibrated performance. There is no finite overhead-bin capacity/search, passing/backtracking, second door, detailed standing-passenger geometry, crew congestion, departure cutoff or no-show policy. Seat interference remains a fixed time penalty; terminal/security modeling is not changed. Trace validation covers completed runs, not streaming/partial logs. No Stage 3 implementation, dashboard or ML is included. The standalone publication excludes all passenger-aware Phase 2 implementations, generated datasets and test outputs.
