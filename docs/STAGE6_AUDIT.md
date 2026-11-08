# Stage 6 - Passenger-Aware Adaptive BoardingFlow and WilMA

This stage reuses the local Phase 2 controller, Stage 4 observation/ETA model, Stage 5 policy and the one shared aircraft simulator. All passengers, staff confirmations, route lengths and timing samples remain SYNTHETIC. Nothing is committed/pushed automatically. No separate Stage 7 experiment expansion, dashboard, submission feature or ML is implemented.

## Release isolation verification

For the separately requested Stage 6 release, the complete local workspace passes **170/170 tests**. The isolated release passes **157/157 tests**: 128 previously committed tests and the 29 Stage 6 tests. The additional local Phase 2 tests and unrelated test edits remain local; no previously committed tests are removed. The release includes `src/adaptive.js` and its `src/phase2-config.js` defaults as necessary legacy-replay/controller dependencies. The older Phase 2 scenario-suite CLI, package/version edits, extra reports and unrelated configuration examples are excluded.

Shared CLI, comparison, export and README changes are isolated by content. In the release, `compare` and `baselines` retain the previously committed three-baseline selection; `compare-all` and `stage6` explicitly select all five. The optional local Phase 2 default-selection change is preserved outside the commit. Generated datasets, raw experiment outputs and test logs are excluded; the measured Stage 6 Markdown report is intentional documentation.

## Audit before implementation and original six-item checklist

| Stage 6 requirement | Before | Verified completion |
| --- | --- | --- |
| 1. Decision-time passenger readiness estimation | Partial: observation-only ETA and gate readiness existed, but controller feasibility ignored staff/gate confirmations and baggage allowance | Complete: required-member evidence and current staff confirmations filter candidates. Security entrance remains distinct from clearance. Declared baggage must fit allowance. Forecasts plan unready groups conditionally and cannot grant readiness. |
| 2. Feasible group/subgroup and release interval recommendation | Partial: whole-group releases and a score existed; congestion proxy, staff eligibility and interval explanations were incomplete | Complete: only full required units are selected; expected completion/path/interference/induced-blocking/baggage terms score general units. Current entrance occupancy can cause a one-tick hold. Release intervals state a not-before time and minimum headway duration, with actual entry guarded by the engine. |
| 3. Dynamic recalculation after observations change | Partial: scans/arrivals and periodic review triggered updates; staff confirmation and observable cabin changes did not explicitly trigger them | Complete: passenger observations, staff observations, current aisle/seating progress, stage changes and review-time ETA changes trigger recomputation. Each v2 record identifies its trigger. |
| 4. Actual gate arrival and passenger-rights constraints | Core constraints implemented; controller proposals relied on a later policy fallback for confirmations | Complete: preserve all policy stages, confirmed assistance, whole parties/families, staff approval and gate verification. Independent policy review and actual/observed presence guards remain in the shared engine. Future-information perturbation/getter tests cover decisions and movement prefixes. |
| 5. Fair Random/Traditional comparison | Immutable comparisons existed; WilMA and a five-strategy/multi-seed policy-enabled suite were missing | Complete: explicit five-strategy API/CLI, seeds 0-9 and 42, normal/security-delay/late cases, one frozen manifest per case, full hashes and common physics. Before/after legacy replays and all baseline invariance checks are retained. |
| 6. Explanations and safe fallback | Partial: reason codes and bounded anticipation existed; recommendation explanations, forecast uncertainty and unreliable-input handling needed completion | Complete: natural-language reasons, score components, conditional gate ETA/uncertainty, policy/staff holds and work-conserving confirmed-ready selection. Missing/unreliable information holds rather than authorizing entry. All advice remains simulation-only and subject to staff/gate checks. |

The additional requested WilMA strategy, confirmed animal-arrangement handling, complete five-strategy test matrix and before/after investigation are also implemented. The complete workspace suite passes **170/170 tests**, including 29 new Stage 6 tests (zero failures, skips or cancellations). The final experiment completes **165 five-strategy runs plus 33 legacy Adaptive replays**, with zero constraint violations. The final run exactly reproduces the first validated v2 run's 165 outcomes and statistics; all 33 complete legacy replay payloads match the preserved before snapshot, and the runtime source hashes match the executed files.

## Policy and required-group handling

The selected policy remains `BF-SWISS-INSPIRED-V1`, the simplified research policy documented in [STAGE5_AUDIT.md](STAGE5_AUDIT.md), with [SWISS boarding](https://www.swiss.com/ca/en/fly/airport/boarding) as its reference. This does not fully reproduce SWISS operations. PREBOARD takes precedence over the combined First/Business/eligible elite/VIP PRIORITY tier, followed by GENERAL. VIP must have an explicit confirmed priority entitlement; a claimed label does not grant one. General zones and strict zone calls remain the traditional baseline's model rules.

Original travel parties and required families merge transitively under the existing policy. The full group receives its earliest confirmed entitlement; guardians/companions are neither split nor promoted through a new ad-hoc rule. Confirmed under-five families preboard. Confirmed assistance retains the empty-aisle escort reservation and existing operational service times. Late protected members and missing confirmations keep their stage open.

No age/senior/pet label changes walking, seating or priority. An optional `boardingPolicy.confirmedAnimalArrangements` array records only `{ passengerId, kind, confirmed, boardingRequirement }`, with kind `PET` or `SERVICE_ANIMAL`. `boardingRequirement=NONE` has no timing/priority effect. `EXTRA_TIME` or `MOBILITY` must match a separately requested and confirmed existing assistance arrangement. Unconfirmed/mismatched records fail for staff review. No diagnosis field is accepted. This is an operational-confirmation record, not a new airline pet eligibility or documentation system.

The default suite's Stage 5 synthetic fixture labels First/elite/family entitlements identically across seeds and explicitly confirms each seed's requested assistance. Staff approval occurs at actual simulated gate arrival and gate verification five seconds later, created by offline fixture preparation. These timestamps remain hidden on the staff observation tape until due. They are not real staff approvals or demographic inferences. Custom `--policy-config` files are respected and validated rather than guessed.

## Independent WilMA

WilMA is a separate `wilma` strategy alongside the three historical baselines and Adaptive. For solo general passengers, A/F precede B/E, which precede C/D. A required mixed group uses **mean member seat depth**: window=0, middle=1, aisle=2; the common seeded unit lottery breaks ties. Its internal order remains the engine's window-to-aisle/member-ID rule. This intentionally relaxes individual WilMA order for mixed groups without splitting them. Luggage, row parity and rear-first tie scores are absent from WilMA.

WilMA preserves the common protected-stage lottery. It never promotes a window passenger over protected rights, bypasses confirmations, or reorders an authorized assisted family into separate seat-type groups. It reuses the existing stowing, cell occupancy, seat interference, escort and timing physics. Tests isolate its seat order, mixed-group rule, tie lottery and independence from baggage scores.

## Reused legacy controller and revised expected-delay model

`src/adaptive.js` is preserved byte-for-byte as `legacy-v1`. The revised implementation in `src/adaptive-v2.js` reuses its protected-stage recommendation logic after filtering currently confirmed-ready members. General boarding uses a new deterministic analytical surrogate; it is not another execution simulator or a guaranteed completion-time optimizer.

For a proposed group, expected seat-row service uses declared overhead pieces times the existing expected 15 seconds per bag, expected seating (4 seconds), current seated-blocker count times the known interference rule, and confirmed assistance requirements. Expected walking uses configured 1 second/row normally or 2 with assistance. These are expectations, never sampled per-passenger behavior or future service-end timestamps.

For each visible occupant on the proposed path, estimate remaining service from its currently observed row-arrival time and elapsed time, or its expected remaining walk/service if still walking. Compare that expected finish with the candidate's expected arrival at that row. The maximum resulting path delay allows concurrent service at different rows; the old proxy instead charged whole expected service for every relevant occupant. Current occupied cells remain facts, while their future clearing times are estimates only.

The general score has seconds-like weighted terms:

| Term | Default |
| --- | --- |
| Projected own completion delay | 0.15 times expected group completion, including walk, path delay, member headway and service |
| Induced blocking | Expected service times the fraction of remaining booked passengers at/beyond that row |
| Path congestion | Mean expected path delay from visible occupants |
| Known seat interference | Existing same-side seated blockers times 8 seconds |
| Seat access | Mean seat depth times 8 seconds times weight 2 |
| Baggage overlap | Credit of one expected baggage-work value to start longer work while it can overlap |
| Rear coverage | Credit of 0.2 times rearmost group row |
| Observed gate waiting | Credit 0.1 seconds per minute, capped at 5 seconds |
| Readiness uncertainty | Zero for confirmed present groups; conditional future plans are ranked by gate ETA plus a heuristic uncertainty margin |

Plans add a 30-second uncertainty proxy, observation-age contribution and overdue penalty; these are not calibrated confidence intervals. Missing/overdue screening and unobserved stops can still cause large gate-ETA errors. A planned gate ETA does not predict staff approval time; `predictedReadyAtSeconds` stays unknown for an unready group. A currently confirmed-ready group is never held speculatively for a more attractive forecast. Configuration is fixed across the entire reported suite; there is no fitting/search on the 33 outcomes.

Release recommendations are advisory. For general boarding, an occupied entrance causes a next-tick recheck. A protected-stage release can call a confirmed whole group to the gate queue while the entrance is occupied; it is not a promise of immediate aircraft entry. The interval's headway duration is a **minimum**, not a guaranteed upper bound. Hidden service times and queues can lengthen it. Every actual entry still requires the free cell, configured headway, actual arrival, observed clearance/location, confirmations and policy checks. An assisted group additionally needs its escort arrangement. No speculative interval overrides execution physics.

## Information boundary and safe behavior

The controller receives only:

- The existing allowlisted booking catalog: IDs, seats/class/zone, confirmed priority/assistance/party information, baggage allowance and known declarations.
- Check-in, security entrance/clearance, gate presence and checkpoint/ETA fields already observed at `asOfSeconds`.
- A policy snapshot containing only staff confirmations already observed.
- Current boarded/seated IDs, visible aisle cells, target rows and **past observed** seat-row arrival times.
- Known static simulation assumptions such as tick, headway and assistance/interference rules, plus configured expectations.

It never receives raw manifest passengers, future arrival/scan/clearance events, the staff tape, actual walking/stow samples, `serviceEndTick`, `nextMoveTick` or unobserved airport positions. Forecasts come from Stage 4's accessible synthetic graph, estimated processing, configurable walking and expected stops. The graph and ETA source are unchanged, and its distances are not official Pearson measurements.

The existing policy reviewer independently verifies each proposal. Unverified policy, conflicting groups/stages, stale/future/malformed evidence, unknown identities or missing staff/clearance/gate confirmation cause a hold. An unreliable ETA cannot authorize entry. A reliable observed-ready unit can proceed without consuming an ETA at all. Protected stages retain their required order; current general candidates are ranked without dropping a right. The existing policy-ready lottery fallback remains available in the engine for a proposal awaiting staff confirmation.

Counterfactual tests change future actual check-in/security/gate events, future staff outcomes and future sampled stow work while holding the observed prefix fixed. Both earlier recommendations and aircraft movement events remain identical. Throwing getters on hidden truth/demographic/diagnosis fields establish that positive decisions do not secretly read those properties. Scoring tests distinguish expected service from future scheduled end times. No medical/diagnosis inference or collection is introduced.

## Before snapshot, fairness and reproducibility

Before editing controller behavior, the workspace saved original source files with SHA-256 hashes under Git-ignored `results/stage6/before/source/`, all 33 frozen policy-enabled manifests, 33 full old-Adaptive results and 132 metrics runs for the existing four strategies. The seed-42 old normal result is 1788 seconds. The preserved before source is not overwritten.

`stage6 --before-dir results/stage6/before` loads those exact manifests, verifies a retained legacy replay, and checks that Random/Zone/Baggage-Aware metrics have not changed. All five strategies use the same frozen full input/hash per case. Profile, actual timeline/observation, policy/staff tape and simulator hashes are exported. Across cases for one seed, physical passenger profiles remain unchanged; across seeds composition and lottery both vary. Runtime source hashes identify the executed implementation. Output cannot enter/overwrite the before directory.

For a fresh checkout, omit `--before-dir`: the deterministic synthetic recipe generates the inputs and `legacy-v1` replays the original controller. `--adaptive-version legacy-v1` explicitly preserves historical policy-enabled Adaptive behavior. Inputs without an explicit policy retain their old legacy controller default; policy-enabled Adaptive defaults to v2. The original `compare`, `baselines`, three-baseline list and old Phase 2 selection remain intact. `compare-all` explicitly selects five strategies. No baseline ranking or aircraft movement/service rule is changed.

All 99 legacy-policy Stage 3 runs/hashes and all 12 saved Stage 4 ETA reports reproduce. Policy-enabled before/after experiments are separately labeled and must not be compared as if their inputs were the legacy-policy flights. Sample SD uses n-1; all per-seed results and every pairwise losing case are retained. Failures/timeouts stop the experiment rather than being filtered out. Complete actual numbers, loss cases and diagnostics are in [STAGE6_RESULTS.md](STAGE6_RESULTS.md).

## Files and usage

| File | Stage 6 change |
| --- | --- |
| `src/adaptive-v2.js` | Observation-only revised controller, expected-delay score, uncertainty, policy review, work-conserving releases and explanations. |
| `src/adaptive.js`, `src/phase2-config.js` | Required retained legacy replay/controller and its validated expectations; include these dependencies without the unrelated Phase 2 experiment suite. |
| `src/stage6-benchmark.js` | Fixed five-strategy suite, immutable before replay/baseline checks, fairness/source hashes, statistics, diagnostics and per-seed/paired exports. |
| `src/strategies.js` | Add independent WilMA and five-strategy list; retain all original baseline algorithms/lists. |
| `src/simulate.js` | Select legacy/v2, pass current observable progress and known assumptions, trigger staff/cabin reoptimization; preserve the one execution engine and guards. |
| `src/policy.js` | Report observed staff changes and optionally validate explicit confirmed animal-related operational arrangements. |
| `src/compare.js` | Explicit `compareAllStrategies` API with policy/readiness preconditions. |
| `src/cli.js` | `stage6`, `compare-all`, legacy replay and v2 configuration flags; preserve old commands. |
| `src/io.js` | Optional controller-version metadata for v2 comparison exports. |
| `config/stage6.example.json` | Fixed expectation/score/uncertainty example; no hidden-truth or physics overrides. |
| `test/stage6.test.js` | Focused WilMA, rights, confirmations, animal noninference, expected scores, observation triggers, leakage, fairness, losses, reproducibility and CLI tests. |
| `README.md` | Stage 6 runnable commands and version/benchmark distinction. |
| `docs/STAGE6_AUDIT.md`, `docs/STAGE6_RESULTS.md` | Audit, method, actual tests, fixed multi-seed results, losses and limitations. |

Run the README commands from `BoardingFlow`. The default suite uses only the required three arrival scenarios and eleven seeds; this is not Stage 7's separate expansion. Per-case directories retain a manifest, passenger CSV, all five timings/comparisons, v2 recommendations, readiness/ETA evaluation and the legacy replay. `--trace` optionally writes independently replayable aircraft events. No viewer/dashboard is built.

## Remaining limitations

The score is an uncalibrated one-step analytical heuristic, not a global optimizer, trained model or operational performance forecast. Service/queue estimates can be wrong, especially when already overdue; elapsed observation does not reveal a hidden true remaining duration. ETA intervals are confidence proxies, not calibrated coverage claims. Group constraints deliberately relax WilMA and can increase waiting. The policy collapses First/Business tiers and has no live staff/document/DCS authentication, revocation workflow, gate cutoff or no-show process. Pet/service-animal confirmation does not implement carrier-specific transport rules. The terminal graph is invented and remains a single-gate abstraction. Results from 33 synthetic scenarios do not establish that Adaptive or WilMA always wins.
