# BoardingFlow — Phase 1

An independent command-line prototype for a synthetic 180-passenger flight: 30 rows, A–F, one front entrance and one aisle. It generates passengers, runs three boarding strategies against identical inputs, checks invariants, and exports inspectable results. Node.js 22 or later is required; the implementation was tested with Node.js 24.19.0 on Windows. There are no external dependencies or installation steps.

The official challenge repository was inspected read-only. This project contains original simulation code and **entirely synthetic passengers**. It does not import official passenger records or alter the official repository. See [the source mapping](docs/OFFICIAL_REFERENCE.md).

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
    strategies.js            Shared party/stage rules and strategy ordering
    simulate.js              Spatial simulation and result invariant audit
    compare.js               Immutable shared-input comparison
    io.js                    JSON/CSV exports and CLI result formatting
    cli.js                   generate, validate, simulate, compare, demo
  config/example.json        Partial configuration override example
  test/                      Data, physical-model, policy and CLI tests
  docs/
    OFFICIAL_REFERENCE.md    Official schema inspection and synthetic extensions
    MODEL.md                 Assumptions, algorithm and metric definitions
    RESULTS.md               Measured default seed-42 results
  data/                      Created by the generate command
  results/                   Created by demo/compare; generated files are gitignored
```

## Simulation and strategies

The aircraft has an entrance cell and one aisle cell per row. Each cell holds at most one passenger. Passengers cannot pass; they wait when the next cell is occupied. At their row, assistance, luggage stowing, seat interference and seating keep that cell occupied. Other unblocked rows continue processing at the same time. This is a spatial, discrete-time simulation, rather than a sum of individual processing times.

All strategies use the same preboarding and priority lottery. Differences apply to general boarding:

| Strategy | General boarding order |
| --- | --- |
| `random` | Seeded shuffle of travel parties and solo passengers |
| `zone` | Rear, middle, front; seeded shuffle within each zone |
| `baggage-aware` | Window-oriented parties first, then more expected baggage work; row parity and rear-first order break ties |

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
