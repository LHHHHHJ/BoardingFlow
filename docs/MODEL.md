# Phase 1 model

## Synthetic inputs

All assumptions are configurable in `src/config.js`; `--config` accepts partial JSON overrides during generation. The generated manifest stores the complete configuration. Geometry defaults to 30 rows with A–F; smaller row counts support controlled tests. This model always has six seats per row.

| Assumption | Default |
| --- | --- |
| Capacity | 180, full flight |
| Time origin | Synthetic boarding opening, November 7, 2026, 17:00 UTC (noon Waterloo time) |
| Party construction | 55% probability of proposing a party; configurable requested size, default 2–3. Default bounds retain row-side clipping; custom bounds keep parties intact across sides/rows, limited by the final capacity remainder |
| Travel class | Independent synthetic fare labels: Economy 85%, Premium Economy 10%, Business 5%; configurable probabilities summing to one |
| Priority entitlement | Independent 12% probability per passenger |
| Assistance | Independent 2.5%; equal chance of `MOBILITY` or `EXTRA_TIME` |
| Other mandatory preboarding | 1% probability among passengers without assistance |
| Cabin allowance | One overhead piece, up to 10 kg; one personal item |
| Actual baggage | Overhead piece probability 65%; personal-item probability 85%; overhead weight uniformly 2–10 kg |
| Arrival | Party-level uniform integer seconds, normally −900 to −60; 8% late component at +30 to +480 |
| Preboarding arrival | Capped at configured early-arrival maximum, default −60 seconds, for every party member |
| Security clearance | 120–600 seconds before gate arrival |
| Check-in clearance | 600–3600 seconds before security clearance |
| Normal walking | 1 second per row |
| Assisted walking | 2 seconds per row |
| Stowing | Uniform 10–20 seconds per overhead piece, sampled per passenger |
| Personal-item handling and sitting | Uniform 3–5 seconds, sampled per passenger |
| Seat interference | 8 seconds per already seated blocker on the same side |
| Additional assistance at seat row | Mobility 40 seconds; extra-time 20 seconds |
| Gate minimum admission headway | 2 seconds; first admission can occur at t=0 |
| Simulation time step | 1 second |
| Timeout | 7200 seconds after boarding opening; failure if incomplete |

Probability draws do not guarantee exact percentages. Priority entitlement, party promotion and preboarding overlap. Parties are given the earliest stage held by any member; counts of stages can exceed counts of individually eligible passengers.

Travel class, boarding zone, priority entitlement and assistance are separate fields. Class does not infer any of the others, change the uniform seat geometry, or automatically increase the synthetic cabin allowance. Class sampling uses a separate random stream so changing only class probabilities leaves physical inputs unchanged. Party bounds use `generation.partySizeMin`/`partySizeMax`; see [Stage 1 configuration and migration details](STAGE1_AUDIT.md).

The baggage generator produces compliant cabin baggage. Imported excess or overweight cabin baggage is rejected for resolution before simulation; the prototype does not silently allow it aboard. `audit-dataset` can inspect and report those violations without running a simulation. Personal items use the sampled seating/handling time and do not consume overhead stow time. Check-in and security fields represent completed clearance, not a check-in/security queue simulation. Any uncleared status or inconsistent timestamp sequence is rejected.

All `*Seconds` timestamps are relative to the manifest's `flight.boardingOpenTime`. CSV exports include UTC clearance timestamps and retain the original `estimatedGateArrivalUTC` alias for compatibility. `gateArrivalSeconds` is execution truth; dataset auditing does not change arrival timing.

## Shared boarding policies

1. Build one unit per travel party, or per solo passenger. It becomes ready at the latest member's gate arrival. Within a unit, use window-to-aisle order, then passenger ID, identically for all strategies.
2. Promote the whole unit to the earliest entitlement: preboarding, priority, or general. A recorded assistance companion must exist in that same party. A solo assisted passenger uses the model's staff escort without an onboard companion.
3. Keep unit admissions consecutive. Ordinary parties can share the aisle with other units. An assisted unit starts with an empty aisle and reserves it until all members are seated; one escort is implicitly available. Its own members may move together in the aisle.
4. Finish seating all preboarding passengers before priority admission. Admit all priority passengers before general admission, allowing priority passengers still in the aisle while general boarding begins.
5. Within the current stage, choose the highest-ranked ready unit, skipping units that have not arrived. A stage cannot close until all its units have entered. A late protected unit therefore delays later stages; no priority right is discarded.
6. For zone boarding's general stage, zones are called rear (1), middle (2), front (3). Do not open the next zone until the current zone's units have entered, including late arrivals. A cross-zone imported party uses its earliest zone.

These are deliberately conservative prototype policies. They are not a claim about any airline's actual boarding rules or legal requirements. Their waits are included in the reported completion time.

## Strategy definitions

All strategies preserve the same preboard/priority ordering and policies above. A seeded shuffle supplies the common lottery and tie-break ranks.

- **Random:** lottery order among ready units in the current stage.
- **Zone:** common lottery within each general zone; protected stages remain unchanged. For 30 rows, zone 1 is rows 21–30, zone 2 rows 11–20 and zone 3 rows 1–10.
- **Baggage-aware:** in general boarding, sort by average seat depth (window 0, middle 1, aisle 2), then descending expected stow work (mean overhead-piece count × sampled stow duration across members), then even rows before odd rows, rear before front, then lottery rank. Row order only breaks ties in the preceding scores. Parties remain intact, so mixed window/aisle parties constrain seat ordering.

The baggage-aware strategy is a deterministic rule using known synthetic baggage/service inputs. It does not train a model or claim an optimal boarding sequence.

## Spatial simulation

Cell 0 is the aircraft entrance. Cells 1–30 are aisle positions beside the seat rows. Each cell holds at most one passenger; passengers cannot pass. At each tick:

1. Finish row services due at that time and release their aisle cells.
2. Update walking from rear to front. A passenger ready to walk advances by exactly one cell if it is free. A following passenger can enter a cell released during that tick, allowing a line to move together. Slower walkers still obey their sampled step interval.
3. On reaching the assigned row, reserve that cell for assistance, baggage stowing, interference, and sitting, in that order.
4. Admit at most one ready passenger at the door if headway, cell occupancy and shared policies allow it.

Walking and service intervals round up to whole ticks. Gate arrivals round up implicitly to the next simulation tick. Internal scheduling uses integer tick indices, avoiding floating-point event-order drift. Occupancy uses half-open intervals: a cell released at time t can be entered at time t.

For seat A, already seated B and C obstruct access; for B, C obstructs. For F, D and E obstruct; for E, D obstructs. C and D have direct aisle access. Opposite-side seats cause no interference. The incoming passenger's row-service penalty represents blockers standing and reseating; individual blocker movements are not simulated.

Each passenger's time must reconcile:

```text
seatedAt − boardedAt = freeWalking + aisleBlocking + rowService
rowService = assistance + stowing + seatInterference + seating
```

Stowing at different rows overlaps. A passenger stowing at an earlier row can block walkers behind, including the entrance queue. The tests verify both effects with analytically known small examples and replay every movement event of the default flight for all strategies.

## Metrics

| JSON metric | Definition |
| --- | --- |
| `totalBoardingSeconds` | Last seating time minus t=0; includes all gate/stage idle periods |
| `activeBoardingSeconds` | Last seating time minus first admission |
| `totalGateWaitSeconds` | Sum of aircraft entry minus gate arrival for all passengers |
| `meanGateWaitSeconds` | Total gate wait divided by passenger count; includes waiting before opening |
| `maxGateWaitSeconds` | Largest individual gate wait |
| `aisleBlockingPersonSeconds` | Sum of ready-to-walk time lost to an occupied next cell; excludes own row service |
| `aisleBlockingPersonMinutes` | The same aggregate divided by 60, explicitly exported in JSON/CSV |
| `meanAisleBlockingSeconds` | Above sum divided by passenger count |
| `gateEntranceBlockedSeconds` | Elapsed ticks when a ready admission with satisfied headway waits for occupied cell 0 |
| `rowServicePersonSeconds` | Sum of all row-service durations; services at different rows may overlap |
| `stowPersonSeconds` | Sum of luggage stowing durations |
| `seatInterferencePersonSeconds` | Sum of additional row-service delay from seat blockers |
| `seatInterferenceCount` | Number of blocker interactions; two blockers count twice |
| `maxConcurrentInAisle` | Peak number aboard but not yet seated, including cell 0 |

Gate entrance blocking is also experienced as gate waiting. Aisle blocking and row-service totals are passenger-time aggregates. These metrics must not be added together as independent elapsed-time components. Empty partial flights are supported by the test API with zero metrics; normal CLI validation requires a full configured aircraft.

## Reproducibility and boundaries

Passenger generation and boarding lotteries use separate deterministic random streams. Movement and service behavior are sampled once into the manifest, with no strategy-specific resampling. Comparisons freeze the input and check a canonical SHA-256 fingerprint before and after all runs. Identical input and code produce identical JSON/CSV/trace bytes; no wall-clock generation timestamp is added.

Every simulation audits unique seating, arrival restrictions, stage order, preboarding completion, party adjacency, escort exclusivity, completion time and per-passenger aisle-time reconciliation. Tests cover duplicates, uncleared status, late passengers/priority/companions, empty and single-passenger cases, all/no baggage, all priority, all assisted, seat interference, fractional ticks, slow walking, collision-free traces, invalid configuration, timeout and the full CLI workflow.

This version has no bin-capacity/search model, gate-check process, jetbridge, second door, passing, cabin crew congestion, live data, departure cutoff, no-shows or abandonment. Seat interference is a time penalty rather than a full standing-passenger geometry model. All passengers eventually arrive or the run times out. Parameters have not been calibrated against real boarding observations. Broader claims would need multiple scenarios, sensitivity analysis and operational validation.

## Stage 2 verification and trace contract

Traced runs now include aircraft/passenger replay metadata, chronological `eventIndex` values, assistance/interference completion events and explicit aisle/entrance blocking intervals. Every traced run independently replays each simulation tick, checking sampled walking speeds, occupied cells, row service phases, protected boarding arrangements and recomputed metrics. A ready walker may wait only for an occupied next cell; this does not prohibit valid gate waits for arrivals, protected stages, escorts or existing policy decisions.

`validate-trace` can repeat this audit on an exported trace and its matching manifest. Passenger-timing artifacts stay identical between traced and untraced runs. Full traces are post-run evaluation/viewer data and are not provided to adaptive decisions. See [STAGE2_AUDIT.md](STAGE2_AUDIT.md) for the schema, compatibility notes, assumptions and measured results.
