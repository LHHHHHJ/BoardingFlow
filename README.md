# BoardingFlow — Phase 1

An independent command-line prototype for a synthetic 180-passenger flight: 30 rows, A–F, one front entrance and one aisle. It generates passengers, runs three boarding strategies against identical inputs, checks invariants, and exports inspectable results. Node.js 22 or later is required; the implementation was tested with Node.js 24.19.0 on Windows. There are no external dependencies or installation steps.

The official challenge repository was inspected read-only. This project contains original simulation code and **entirely synthetic passengers**. It does not import official passenger records or alter the official repository. See [the source mapping](docs/OFFICIAL_REFERENCE.md).

## Stage 1 passenger dataset checklist

The Stage 1 audit adds an independent `travelClass` field, configurable passenger-class mix and party-size bounds, and a per-passenger allowance-versus-actual baggage report. It reuses the existing generator and validation. See [the requirement audit, assumptions and file changes](docs/STAGE1_AUDIT.md).

```powershell
cd .\BoardingFlow
node src/cli.js generate --seed 42 --output data/stage1-passengers.json
node src/cli.js validate --input data/stage1-passengers.json
node src/cli.js audit-dataset --input data/stage1-passengers.json --output results/stage1/dataset-audit.json
node --test
```

Use `--config config/stage1.example.json` with `generate` to change class/priority/assistance mix, carry-on rates and party-size bounds. New datasets use schema 2. Saved schema 1 inputs still work; their missing class labels are reported as unknown by the new audit. New metadata changes generated input fingerprints while default physical passenger draws and simulation completion times remain unchanged.

## Stage 2 core simulator verification

The existing shared aircraft engine now exports a versioned trace with geometry, service phases and blocking intervals. Independent replay checks movement speed, collisions, unexplained aisle queues, timing and metrics. Passenger-minutes are explicit in JSON/CSV as `aisleBlockingPersonMinutes`.

```powershell
node src/cli.js demo --seed 42 --output results/stage2 --trace
node src/cli.js validate-trace --input results/stage2/manifest.json --trace-file results/stage2/events-random.json --output results/stage2/validation-random.json
node --test
```

See [the five-item Stage 2 audit and trace contract](docs/STAGE2_AUDIT.md). This checklist stage adds no dashboard or new boarding strategy; the earlier local Phase 2 passenger-awareness implementation is preserved outside this commit.

## Stage 3 baseline strategy verification

The existing random, zone and initial baggage-aware strategies now have focused ordering/constraint tests and a reproducible multi-seed comparison. Their ordering rules and the shared simulator are unchanged. The baseline remains available alongside the earlier local Phase 2 implementation.

```powershell
node --test test/stage3.test.js
node src/cli.js baselines --seeds 0,1,2,3,4,5,6,7,8,9,42 --output results/stage3
node --test
```

This runs 99 simulations: 11 seeds, three synthetic arrival cases, three baselines. `results/stage3/report.md` includes every run, sample variability and paired losses; JSON/CSV and each case's manifest/passenger timings permit inspection. Optional `--cases normal,all-at-gate,late-arrivals` and `--config config/example.json` select cases and assumptions; the case's arrival settings take precedence over custom arrival settings. Output datasets remain Git-ignored.

Baggage-aware wins completion against random in 9 of 11 seeds per case, but loses in seeds 1 and 9 and slightly increases average gate waiting. See [the six-item Stage 3 audit](docs/STAGE3_AUDIT.md) and [measured comparison/test results](docs/STAGE3_RESULTS.md). This stage adds no adaptive features, dashboard or ML.

## Stage 4 check-in, security and gate ETA verification

Stage 4 reuses the local Phase 2 journey/observation implementation. It adds missing-scan handling, explicit event-order and decision-time checks, an accessible-route audit, and richer post-run ETA error reporting. The synthetic terminal geometry, default generation draws and adaptive strategy remain unchanged.

```powershell
node src/cli.js generate --scenario normal --seed 42 --output data/stage4-normal.json
node src/cli.js readiness --input data/stage4-normal.json --at 0 --output results/stage4/readiness-0.json
node src/cli.js terminal-audit --input data/stage4-normal.json --output results/stage4/terminal-audit.json
node src/cli.js eta-evaluate --input data/stage4-normal.json --times 0,300,600 --output results/stage4/normal
node src/cli.js generate --scenario security-delays --seed 42 --output data/stage4-security.json
node src/cli.js eta-evaluate --input data/stage4-security.json --times 0,300,600 --output results/stage4/security-delays
node --test test/stage4.test.js
node --test
```

Use `--phase2-config config/stage4.example.json` with `generate --scenario ...` to change walking speed, estimated screening duration and possible stops without configuring adaptive optimization. Security entrance remains `SCREENING` until a separate clearance observation. Missing required clearance/check-in/gate evidence blocks boarding; it is never reconstructed from hidden actual times. ETA error output is evaluation data and does not feed decisions.

See [the six-item Stage 4 audit and official-map reference boundary](docs/STAGE4_AUDIT.md) and [actual accuracy/test results](docs/STAGE4_RESULTS.md). The retained route lengths and accessibility flags are invented model assumptions, **not official Toronto Pearson measurements**. No map artwork is included.

## Stage 5 passenger rights and constraints

Use the explicit `BF-SWISS-INSPIRED-V1` teaching-policy profile to protect confirmed First/Business/elite entitlements, assistance, required families and under-five family preboarding. It collapses the reference airline's priority tiers into one protected stage and retains this model's general zones. Historical manifests without a profile retain the legacy research rules so existing benchmarks remain reproducible.

```powershell
node src/cli.js generate --scenario normal --seed 42 --output data/stage5-normal.json
node src/cli.js apply-policy --input data/stage5-normal.json --policy-config config/stage5.example.json --output data/stage5-policy.json
node src/cli.js policy-preview --input data/stage5-policy.json --at 0 --strategy zone --output results/stage5/advisory.json
node src/cli.js simulate --input data/stage5-policy.json --strategy random --output results/stage5/random --trace
node --test test/stage5.test.js
node --test
```

The example is specific to the default seed-42 passenger IDs. Its staff confirmations are explicitly simulated at gate arrival and five seconds afterward; they are not real staff approvals. Omit synthetic confirmations to test pending manual approval, or supply explicit timestamped `staffEvents`. Unverified policy, missing clearance/arrival evidence, or missing approval never permits simulated boarding. `policy-preview` assumes no earlier aircraft admissions and remains advisory.

No age, senior or pet label grants rights or changes walking speed. Family eligibility and assistance use explicit confirmed arrangements; no diagnosis data is requested. See [the seven-item Stage 5 audit, configuration contract and actual results](docs/STAGE5_AUDIT.md). The adaptive scoring module is unchanged; this stage adds shared rights checks and safety gates only.

## Stage 6 Passenger-Aware Adaptive BoardingFlow and independent WilMA

`compare-all` compares **random, zone, baggage-aware, wilma and adaptive** on one frozen policy-enabled manifest. WilMA sorts general required groups by mean seat depth (window 0, middle 1, aisle 2), then the shared seeded lottery; protected stages and intact families/parties take precedence. The new Adaptive version uses observed readiness/staff confirmations, expected service work and visible aisle progress. The original controller remains available as `legacy-v1`.

```powershell
node src/cli.js stage6 --seeds 0,1,2,3,4,5,6,7,8,9,42 --adaptive-config config/stage6.example.json --output results/stage6/after
node src/cli.js compare-all --input results/stage6/after/normal/seed-42/manifest.json --output results/stage6/single --trace
node src/cli.js simulate --input results/stage6/after/normal/seed-42/manifest.json --strategy adaptive --adaptive-version legacy-v1 --output results/stage6/legacy-replay
node --test test/stage6.test.js
node --test
```

The fixed Stage 6 suite covers 33 scenarios/165 strategy runs and 33 paired legacy-Adaptive replays. It explicitly uses synthetic confirmed First/elite/family arrangements from the Stage 5 example and confirms the requested assistance per seed; no rights are inferred from age or pets. It produces per-seed CSV/JSON, mean/sample SD, paired losses and before/after diagnostics. Use `--before-dir results/stage6/before` to verify/reuse this workspace's preserved immutable pre-change snapshots; omit it to regenerate and replay the retained legacy version on a fresh checkout. The before directory is protected against output overwrite.

Adaptive defaults to `passenger-aware-v2` on explicit policy inputs; earlier Phase 2 inputs without a policy keep legacy behavior. Existing `compare` and `baselines` strategy selections are preserved. Historical Stage 3/4 reports stay separate from these new policy-enabled experiments. Confirmed pet/service-animal records require explicit operational arrangements and grant no automatic priority or speed penalty.

See [the six-item Stage 6 audit and information boundary](docs/STAGE6_AUDIT.md) and [actual multi-seed results, before/after investigation and losses](docs/STAGE6_RESULTS.md). No dashboard, ML, Stage 7 expansion or submission work is included.

## Run everything

From the parent workspace in PowerShell:

```powershell
cd .\BoardingFlow
node --test
node src/cli.js demo --seed 42 --output results --trace
```

`demo` generates one manifest, freezes it, and compares all three strategies. Every result includes a SHA-256 input fingerprint and an invariant audit. Failures produce a nonzero exit code. Direct `node` commands also avoid Windows PowerShell's restriction on the installed `npm.ps1` wrapper. `npm.cmd test` and `npm.cmd run demo` are equivalent optional shortcuts.

## Run and verify incrementally

1. Generate the synthetic flight and validate its records:

   ```powershell
   node src/cli.js generate --seed 42 --output data/synthetic-flight.json
   node src/cli.js validate --input data/synthetic-flight.json
   node --test test/data.test.js
   ```

   The default must report 180 passengers and 180 unique seats. Inspect `data/synthetic-flight.json` for IDs, seats, boarding rights, allowed/actual cabin baggage, clearance statuses and timestamps, gate arrivals, parties, assistance, and sampled movement/service times. Seconds are relative to boarding opening; negative values mean before opening.

2. Run one strategy with a movement trace:

   ```powershell
   node src/cli.js simulate --input data/synthetic-flight.json --strategy random --output results/random --trace
   node --test test/simulation.test.js
   ```

   Open `results/random/timings-random.csv` to inspect each passenger's entry, row arrival, seating, gate wait and aisle blocking. `events-random.json` records admissions, one-cell moves, stowing, seat interference, assistance, seating and completion. The trace envelope identifies its strategy and input fingerprint.

3. Compare strategies using that same saved flight:

   ```powershell
   node src/cli.js compare --input data/synthetic-flight.json --output results --trace
   node --test
   ```

   Check that every `inputHash` in `results/comparison.json` matches. Each result's `validation` must pass with 180 passengers seated exactly once. The tests also replay traces to check aisle occupancy and rerun the CLI to verify byte-for-byte reproducibility.

4. Change assumptions in a new experiment:

   ```powershell
   node src/cli.js demo --seed 42 --config config/example.json --output results/experiment --trace
   ```

   The example changes baggage and late-arrival probabilities and uses half-second ticks. Overrides merge into [the defaults](src/config.js); unknown keys and invalid values fail explicitly. Store experiments in separate output folders. Reusing a folder overwrites its generated outputs and removes stale generated strategy files/traces, preserving unrelated files. `compare` and `simulate` always use the complete configuration saved in their input manifest.

## Project structure

```text
BoardingFlow/
  package.json               Dependency-free ES modules and optional npm scripts
  src/
    config.js                Validated, configurable assumptions
    random.js                Deterministic random streams and shuffling
    generate.js              Synthetic flight and passenger generation
    model.js                 Seat geometry, input validation, canonical fingerprint
    baggage.js               Allowance-versus-actual carry-on audit
    dataset-audit.js         Stage 1 dataset summary and baggage evidence
    strategies.js            Shared party/stage rules and strategy ordering
    simulate.js              Spatial simulation and result invariant audit
    trace.js                 Versioned trace contract and independent replay validator
    adaptive.js              Preserved legacy Adaptive controller and replay
    adaptive-v2.js           Policy-enabled observation-only expected-delay controller
    stage6-benchmark.js      Fixed five-strategy suite and paired legacy replay
    constraints.js           Shared post-run core boarding constraint checks
    compare.js               Immutable shared-input comparison
    io.js                    JSON/CSV exports and CLI result formatting
    cli.js                   generate, validate, simulate, compare, demo
  config/example.json        Partial configuration override example
  config/stage1.example.json Passenger class/mix, carry-on and group-size overrides
  test/                      Data, physical-model, policy and CLI tests
  docs/
    OFFICIAL_REFERENCE.md    Official schema inspection and synthetic extensions
    MODEL.md                 Assumptions, algorithm and metric definitions
    RESULTS.md               Measured default seed-42 results
    STAGE1_AUDIT.md           Passenger dataset requirement audit and verification
    STAGE2_AUDIT.md           Core simulator checklist, trace schema and verification
  data/                      Created by the generate command
  results/                   Created by demo/compare; generated files are gitignored
```

## Simulation and strategies

The aircraft has an entrance cell and one aisle cell per row. Each cell holds at most one passenger. Passengers cannot pass; they wait when the next cell is occupied. At their row, assistance, luggage stowing, seat interference and seating keep that cell occupied. Other unblocked rows continue processing at the same time. This is a spatial, discrete-time simulation, rather than a sum of individual processing times.

All strategies use the same preboarding and priority lottery. Differences apply to general boarding. The existing compare and baselines commands retain their three-strategy selection; Stage 6 uses compare-all for all five:

| Strategy | General boarding order |
| --- | --- |
| `random` | Seeded shuffle of travel parties and solo passengers |
| `zone` | Rear, middle, front; seeded shuffle within each zone |
| `baggage-aware` | Window-oriented parties first, then more expected baggage work; row parity and rear-first order break ties |
| `wilma` | Window, middle, aisle; mean seat depth for intact mixed parties and the shared seeded lottery for ties |
| `adaptive` | Policy-enabled v2 scores expected delay from confirmed readiness and visible cabin progress; no speculative wait over a feasible ready group. Retained `legacy-v1` uses the original bounded ETA lookahead. |

All parties board consecutively and wait until every member has reached the gate. A party uses its earliest member entitlement, keeping companions together. All preboarding passengers must be seated before priority boarding; all priority passengers must enter before general boarding. Assisted parties reserve an empty aisle and escort until the entire party is seated. Late protected passengers hold their stage. Zone calls also wait for the previous zone's admissions to finish. These conservative, synthetic policies are common across the comparison; details and limitations are in [MODEL.md](docs/MODEL.md).

## Actual default results

Measured with `demo --seed 42`, default configuration, and one shared 180-passenger manifest:

| Strategy | Boarding completion | Mean gate wait | Aisle blocking, passenger-minutes |
| --- | ---: | ---: | ---: |
| Random | 27:04 | 20.55 min | 179.73 |
| Zone | 29:56 | 21.26 min | 258.67 |
| Baggage-aware | 23:46 | 20.38 min | 172.47 |

Gate wait includes time before boarding opens. Aisle blocking is summed across passengers, so it can exceed elapsed boarding time. The heuristic improves completion by 198 seconds (12.2%) over random for this single uncalibrated synthetic case. It is not a demonstrated optimum or an operational forecast. Full metrics are in [RESULTS.md](docs/RESULTS.md) and generated `results/comparison.json`.

The scope is the Phase 1 CLI simulation. A dashboard, machine learning, airport maps, live DCS integration and calibrated operational predictions are future work.
