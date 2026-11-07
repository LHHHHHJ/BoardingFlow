# Stage 3 - Existing Boarding Strategies / Baselines

All inputs are independently generated SYNTHETIC passengers. This audit extends the existing Node.js project. It changes neither the three baseline ranking rules nor aircraft physics. The earlier uncommitted Phase 2 implementation remains local and is excluded from this commit. No Stage 6 optimization, dashboard or ML was added.

## Requirement audit

| Requirement | Before this audit | Verified Stage 3 result and evidence |
| --- | --- | --- |
| 1. Random eligible boarding with protected stages | Complete implementation; focused lottery coverage partial | Complete: deterministic unit shuffle, different orders for different lottery seeds on identical passenger records, shared protected-stage prefix, unavailable-unit and protected-barrier tests in `test/stage3.test.js`. |
| 2. Simplified traditional zones | Complete implementation and basic documentation | Complete: exact 30-row mapping and within-zone lottery tested; strict late-zone barrier and cross-zone party promotion tested. Zone order is 1 rear, 2 middle, 3 front. |
| 3. Initial baggage-aware seat/luggage heuristic | Complete implementation; score/tie verification partial | Complete: tested window/middle/aisle depth, descending stow work, party means, bag/no-bag, row parity and rear tie-breaks. Its limits and idealized information basis are explicit below. |
| 4. First comparison/test report | Partial: original seed-42 report only | Complete: `docs/STAGE3_RESULTS.md` records measured aggregates, paired losses, seed-42 results and full-suite counts. Generated report/JSON/CSV contain all 99 runs. |
| 5. Fair inputs and multiple reproducible seeds | Partial: immutable shared input supported, multi-seed runner/report missing | Complete: seeds 0-9 and 42, three arrival cases, 33 manifest comparisons. Input, actual-arrival, passenger-profile and simulation-assumption fingerprints plus full-flight timing tests establish consistency. |
| 6. Transition to final Stage 6 adaptive strategy | Missing: no checklist-specific baseline retention/transition contract | Complete audit/documentation only: retain named baggage baseline and existing adaptive implementation; distinguish their information assumptions and compare on identical saved scenarios. No new Stage 6 features. |

## Exact baseline policies

All strategies operate on travel parties or solo boarding units. Each party receives the strongest member entitlement and earliest member zone. Within a party, window-to-aisle then ID order is shared by all strategies. All members must be physically present before its first admission; admissions stay consecutive. Assisted units enter an empty aisle and retain the escort reservation until seated. All preboarding passengers must be seated before priority admission; all priority units must enter before general admission. Late protected passengers are waited for.

The seeded Fisher-Yates unit shuffle is common to all strategies. Random uses its rank within the current protected/general stage. This randomizes eligible units; it cannot produce every individual passenger permutation because party and rights constraints are retained. Ready units may pass unavailable units within a stage. Ranking does not score future actual arrivals; those timestamps determine physical presence during execution.

Traditional zone uses the same lottery within general zones 1, 2, 3. For 30 rows these are rows 21-30, 11-20, 1-10. The next zone cannot open until all units in the previous zone have entered, including its late passengers. Priority takes precedence over zone. These are simplified synthetic policies, not a representation of a particular airline.

Baggage-aware uses the same protected-stage lottery. General units sort lexicographically by:

1. Mean seat depth: A/F=0, B/E=1, C/D=2, ascending.
2. Mean overhead-piece count times stow seconds, descending (longer work first).
3. Even row before odd row, then rear before front, then lottery rank. A party's row is its rearmost member row.

Row/parity order is only a tie-breaker. Continuous sampled stow times make exact ties uncommon; this is not a guarantee of staggered or alternating actual boarding. Mixed-seat parties constrain depth ordering. Personal items are handled by the shared seating time; they do not consume overhead stow time. Prioritizing long work can expose concurrency, but can also block the aisle: it is an initial heuristic, not an optimum.

## Fair experiment contract

`runBaselineBenchmark` generates exactly one manifest per seed/case, freezes it, then passes that same object to all three strategies through `compareBaselines`. Simulator walking, stowing, seating, assistance, headway, tick size, geometry and policies are identical; interference and blocking are outcomes and may differ. No strategy resamples behavior or arrivals. Every result must pass the existing seating/arrival/constraint audit; any failure or timeout stops the benchmark rather than dropping a losing run.

The fixed seed set is 0,1,2,3,4,5,6,7,8,9,42. Cases are generator arrival overrides, with all other passenger characteristics unchanged for a given seed:

| Case | Arrival settings |
| --- | --- |
| `normal` | Existing defaults: party-level 8% late at +30 to +480 seconds; otherwise -900 to -60. |
| `all-at-gate` | All parties at -60 seconds. |
| `late-arrivals` | 25% late at +120 to +1200 seconds; normal early-arrival bounds. |

Preboarding retains the existing before-opening cap. Clearance timestamps move with arrivals; these cases do not simulate a new security process. They are separate from the existing Phase 2 terminal/security scenarios with similarly named labels. Case arrival overrides take precedence over custom arrival-generation config. Full resolved per-case configuration is exported in `benchmark.json` and each manifest.

Whole-manifest hashes must match across strategies. Arrival hashes include actual gate arrival, check-in/security status and completion times. Profile hashes exclude only those three timeline fields and retain seats, entitlements, baggage, parties, class and sampled physical behavior; profiles must match across cases for each seed. Aircraft/simulator assumption hashes must match across all cases and seeds. Across seeds both composition and lottery change; sample SD describes these synthetic flights, not isolated ordering noise or an operational confidence interval. Singleton SD is `null`/n/a.

## Stage 6 handoff audit (documentation only)

Keep `random`, `zone`, and `baggage-aware` as distinct retained baseline identifiers. `compareBaselines` explicitly selects them. This isolated Stage 3 commit preserves the committed random/zone/baggage-aware `compareStrategies` default. The separate local Phase 2 workspace retains its existing random/zone/adaptive default and baseline API integration test; that implementation is not included in this commit. No existing baseline is renamed to imply adaptive behavior.

Phase 1 baggage scores use the sampled realized stow duration as an idealized known attribute. This is useful for checking the initial rule but is not a deployable prediction. The separately held local Phase 2 baggage scoring uses its configured expected stow seconds per bag instead. A later adaptive evaluation must label this distinction and compare all strategies on the same saved terminal observations, actual execution scenario and aircraft assumptions. Phase 1 versus Phase 2 totals are not a paired experiment.

When Stage 6 is explicitly in scope, its policy should consume only observations available at its decision timestamp and forecasts derived from those observations. Security entry must remain distinct from clearance. Future actual gate arrivals, processing times and stop outcomes belong only to execution/evaluation. Existing local observation/adaptive tests, including future-truth perturbation tests, remain part of the full suite. This stage adds no release logic, readiness estimator or optimizer behavior.

## Changed files and verification

| File | Stage 3 change |
| --- | --- |
| `src/compare.js` | Extract common comparison runner; add explicit baseline API; preserve existing automatic strategy selection. |
| `src/baseline-benchmark.js` | Fixed seed/case selection, immutable comparisons, cross-case fingerprints, sample summaries, paired win/tie/loss counts and deterministic report/artifact export. |
| `src/cli.js` | Add `baselines` command/help; leave existing commands intact. |
| `test/stage3.test.js` | 17 standalone baseline tests covering ordering, rights, baggage scoring, arrival nonleakage, fair physical inputs, repeatability, statistics, failed runs and CLI exports. |
| `README.md` | Add Stage 3 run/verification instructions and report links. |
| `docs/MODEL.md` | Clarify unit randomization, row tie-break limits, baggage information assumptions and comparison APIs. |
| `docs/STAGE3_AUDIT.md` | This requirement audit, experiment contract and Stage 6 handoff. |
| `docs/STAGE3_RESULTS.md` | Measured report snapshot and actual test results. |

The isolated committed tree passes 72/72 tests (55 existing plus 17 standalone Stage 3 tests). The complete local workspace passes 94/94, including 22 local Phase 2 tests/integration checks held outside this commit. Both trees pass all 99 benchmark runs with identical benchmark metrics.

Run from `BoardingFlow`:

```powershell
node --test test/stage3.test.js
node src/cli.js baselines --seeds 0,1,2,3,4,5,6,7,8,9,42 --output results/stage3
node --test
```

Each case/seed directory contains its single manifest, passenger CSV, comparison and three passenger timing files. Summary JSON/CSV/Markdown are at the output root. Outputs are Git-ignored; no generated passenger dataset is added to source control. The CLI test checks byte-for-byte repeatability and the full-flight test independently replays traces for all three baselines on seed 42.

Limits retained from Stage 2 include one cell per row, no passing or bin-capacity/search model, no no-shows/departure cutoff, and simplified escort/seat-interference timing. Eleven uncalibrated synthetic seeds establish reproducibility and expose counterexamples; they do not establish airline performance or an optimal boarding method. Completion, gate waiting and passenger-time blocking have different objectives and must be reported separately.
