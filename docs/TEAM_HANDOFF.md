# BoardingFlow backend team handoff

Backend reference: **Stage 6 commit `7e081741979b193ddfc6bbd8ce4dd17948b91381`**, `main`, <https://github.com/LHHHHHJ/BoardingFlow>. This handoff adds documentation, formal export schemas, a reproducible integration fixture and contract tests. It changes no simulator, optimizer, policy, physics, existing configuration defaults or CLI selection. It does not implement Stage 7 experiments, a Stage 8 frontend or an HTTP service. Existing unrelated local Phase 2 changes are preserved.

## Setup and project ownership

```powershell
git clone https://github.com/LHHHHHJ/BoardingFlow.git
cd BoardingFlow
node --version
npm.cmd install --ignore-scripts --package-lock=false --no-audit --no-fund
node --test
node src/cli.js --help
```

Use Node.js **22 or later**; verification used 24.19.0. The backend has **no external runtime or test dependencies**. Installation is an optional no-op sanity check. There is no committed lockfile, so `npm ci` is not the setup command. On Windows, `npm.cmd` avoids PowerShell's `npm.ps1` execution-policy issue; on macOS/Linux use `npm`. Direct `node` commands work everywhere. Run commands from the repository root. Quote paths containing spaces.

The committed package version is `0.1.0`; the backend's trace/manifest/controller versions below are authoritative. A local `0.2.0` package and `npm run phase2` belong to an uncommitted Phase 2 variant. Teammates should use the committed commands and handoff files in this repository; the unrelated local Phase 2 variant is not required.

| Location | Responsibility |
| --- | --- |
| `src/generate.js`, `config.js`, `model.js` | Synthetic passenger generation, configuration, validation, canonical input SHA-256 |
| `src/simulate.js`, `trace.js`, `constraints.js` | One shared aircraft engine, replay validation and independent constraint counts |
| `src/strategies.js` | Required groups/protected stages and distinct random, zone, baggage-aware and WilMA ordering |
| `src/adaptive.js`, `adaptive-v2.js` | Preserved legacy controller and current observation-only Adaptive controller |
| `src/scenarios.js`, `observations.js`, `readiness.js`, `terminal.js` | Arrival truth, observed event tape, decision-time readiness/ETA and invented accessible walking graph |
| `src/policy.js`, `policy-scenario.js` | Static rights, observed staff confirmation and offline synthetic fixture preparation |
| `src/compare.js`, `stage6-benchmark.js`, `baseline-benchmark.js` | Immutable comparisons, existing fixed Stage 6 suite and historical Stage 3 suite |
| `src/cli.js`, `io.js` | Commands, validation and JSON/CSV exports |
| `config/` | Generation, Stage 4 ETA, Stage 5 policy and Stage 6 expectation examples |
| `schemas/backend-contract.schema.json` | Exact canonical JSON shapes with required/optional fields and tagged trace-event variants |
| `examples/integration/`, `scripts/` | Small real outputs, reproducible generation and optional schema verification |
| `test/`, `docs/STAGE*_AUDIT.md`, `docs/STAGE*_RESULTS.md` | Verification, assumptions and historical measured reports |

The backend owner owns physics, algorithms and policy enforcement. The Stage 7 teammate can consume/export existing statistics and later design separate experiments. The Stage 8 teammate can consume the frozen output bundle immediately and later connect a transport adapter. Neither teammate needs to reimplement boarding physics or alter the optimizer to draw results.

## Generate the 180-passenger flight and run all five strategies

```powershell
node src/cli.js generate --seed 42 --scenario normal --output data/team-flight.json
node src/cli.js validate --input data/team-flight.json
node src/cli.js apply-policy --input data/team-flight.json --policy-config config/stage5.example.json --output data/team-policy.json
node src/cli.js compare-all --input data/team-policy.json --output results/team/normal-42 --trace
node src/cli.js validate-trace --input data/team-policy.json --trace-file results/team/normal-42/events-adaptive.json
node src/cli.js readiness --input data/team-policy.json --at 0 --output results/team/readiness-0.json
```

Defaults fill 30 rows x `ABCDEF` = 180 unique seats. `--config config/stage1.example.json` changes passenger mix, parties and carry-on assumptions. The complete merged configuration is saved in the manifest; simulation reads that saved configuration. `generate` without `--scenario` creates Phase 1 data suitable for the original three baselines, but not the observation-dependent current Adaptive controller.

The Stage 5 policy example's explicit IDs/assistance confirmations are **seed-42-specific**. Do not apply it blindly to arbitrary seeds or smaller aircraft. The default `stage6` fixture below explicitly confirms each generated seed's assistance, or a caller can supply a complete validated `--policy-config`. All staff confirmations are synthetic fixture assumptions, not real gate approvals.

For a single strategy, use `simulate --input data/team-policy.json --strategy wilma --output results/team/wilma --trace`. Accepted strategy keys are exactly **`random`, `zone`, `baggage-aware`, `wilma`, `adaptive`**. `--adaptive-version legacy-v1` explicitly replays the previous controller. Policy-enabled Adaptive defaults to `passenger-aware-v2`; inputs without a policy retain legacy Adaptive behavior. `compare-all` requires both terminal observations and the explicit policy.

## Available scenarios and statistics for Stage 7

```powershell
node src/cli.js stage6 --seeds 42 --cases normal,security-delays,late-arrivals --output results/team/scenario-smoke --trace
```

This is the existing three-scenario interface: 15 strategy runs plus three legacy replays. It prepares one policy-enabled manifest per seed/case and freezes it across all five strategies. Scenario names are exactly `normal`, `security-delays`, `late-arrivals`.

To reproduce the already defined Stage 6 suite and obtain existing multi-seed statistics:

```powershell
node src/cli.js stage6 --seeds 0,1,2,3,4,5,6,7,8,9,42 --adaptive-config config/stage6.example.json --output results/team/stage6-reproduction
```

This is reproduction of the completed Stage 6 suite, not a new Stage 7 experiment design. `comparison.json` at the suite root contains `experiments[]` with every result and `summaries[]` with means, **sample SD (n-1)**, minimum/maximum, paired deltas, wins/ties/losses and before/after Adaptive results. `runs.csv` contains individual metrics; `report.md` contains readable tables. For one seed, `sampleSD` is **null**, not zero. Positive paired subject-minus-reference deltas are worse. Preserve losing cases and failed runs; a timeout exits with an error rather than silently dropping a sample.

Use `inputHash` to join results, `passengerProfileHash` for cross-scenario profile consistency, `actualScenarioHash` for actual journeys, `policyHash` for policy/staff tape and `simulatorHash` for aircraft/physics configuration. Record `adaptiveVersion`, settings and source hashes with experiments. Source hashes are raw file-byte hashes and may differ across CRLF/LF checkouts even when inputs and simulation outcomes reproduce. Never compare unmatched hashes as a paired same-input run. Independent output directories avoid concurrent runs overwriting one another.

`preservedBeforeSnapshotVerified=false` is normal on a fresh checkout without this owner's Git-ignored before directory. The retained legacy controller still runs the paired replay; the flag only says no separate preserved snapshot was supplied. It is not a constraint failure. The small checked-in example JSON uses scoped LF attributes so its file checksum inventory survives Windows checkout conversion.

The historical `baselines` command runs three strategies and uses **different Phase 1 stress cases**: `normal`, `all-at-gate`, `late-arrivals`. It is not the Stage 6 security/terminal suite. Historical Stage 3 results and policy-enabled Stage 6 results must retain their labels. The backend does not guarantee that Adaptive or WilMA wins.

Configuration layers are separate:

| Option / persisted field | Meaning |
| --- | --- |
| `--config`, `manifest.config` | Passenger/aircraft generation and shared simulator physics; partial override becomes complete saved config |
| `generate --phase2-config config/stage4.example.json`, `manifest.phase2.settings` | Terminal speed (meters/second), expected screening/stops, actual security/late scenario parameters and retained legacy-controller settings |
| `--policy-config` | Rights/families/confirmed assistance and offline synthetic staff confirmations; saved policy has explicit `staffEvents`, not the fixture helper option |
| `--adaptive-config config/stage6.example.json` | V2 expectations/score weights; does not change actual service samples or physics |

`stage6` does not accept `--phase2-config`; for custom ETA/security settings, use `generate --scenario ... --phase2-config ...`, apply an appropriate policy, then `compare-all`. There is no arbitrary terminal-map CLI override; custom supported manifests can be constructed/validated through the Node modules. The terminal is an invented single-gate graph, with **no official Toronto Pearson distances or map artwork**.

The v2 example's exact settings and units are:

| Fields | Default | Unit |
| --- | --- | --- |
| `expectedSeatSeconds` | 4 | Expected seconds |
| `expectedWalkSecondsPerRow`, `expectedAssistedWalkSecondsPerRow` | 1, 2 | Expected seconds/aircraft row |
| `completionWeight`, `inducedBlockingWeight`, `pathDelayWeight`, `seatAccessWeight`, `baggageOverlapWeight` | 0.15, 1, 1, 2, 1 | Dimensionless multipliers of expected-delay terms |
| `rowWeight` | 0.2 | Heuristic credit per rear row |
| `waitingSecondsPerMinute`, `waitingCreditCapSeconds` | 0.1, 5 | Seconds-like heuristic credit per minute waited; maximum credit |
| `staleObservationSeconds`, `uncertaintyBaseSeconds`, `overdueUncertaintySeconds` | 120, 30, 60 | Seconds |
| `uncertaintyAgeWeight` | 0.25 | Seconds of margin per second of observation age |

The separate `phase2.settings.adaptive` legacy settings are `reviewIntervalSeconds=5`, `lookaheadSeconds=20`, `maxAnticipationWaitSeconds=8` (seconds), `expectedStowSecondsPerBag=15` (expected seconds/bag), `waitCostPerSecond=1` (score/second), `minimumScoreImprovement=5` (score), `seatDepthWeight=12` (score/depth), `rowWeight=0.4` (score/row), `zoneWeight=1.5` (score/zone), `congestionWeight=0.4` (multiplier) and `interferenceWeight=8` (score/blocker). V2 still reads the shared review interval and expected stow value from that block, while its general score uses the v2 configuration. Expectations do not replace actual sampled execution durations.

## File contracts and versioning

The machine-readable contract is [backend-contract.schema.json](../schemas/backend-contract.schema.json), JSON Schema Draft 2020-12, ID `urn:boardingflow:backend-contract:1`. Its root validates a manifest. Select `#/$defs/<Name>` for another artifact. [The schema guide](../schemas/README.md) explains validator use and semantic checks. The schemas document canonical generated fields; domain validators additionally enforce capacity, seat uniqueness, chronology, parties and policy. They do not migrate or mutate saved inputs.

| Artifact / definition | Actual top-level fields and version |
| --- | --- |
| `manifest.json` / `Manifest` | `schemaVersion` (new=2, legacy=1), `dataKind`, `provenance`, `seed`, `flight`, `config`, `passengers`; optional `phase2`, `boardingPolicy` |
| Passenger / `Passenger`, `PassengerV1` | `id`, `flightId`, `seatNumber`, `boardingZone`, `travelClass` (optional in legacy 1), `priorityEligible`, `mandatoryPreboarding`, `carryOnAllowance`, `actualBaggage`, `checkInStatus`, `securityStatus`, `travelPartyId`, `assistance`, `behavior`, `gateArrivalSeconds`, `securityClearedAtSeconds`, `checkInAtSeconds`; terminal scenarios additionally require `securityScanAtSeconds` |
| `phase2` / `Phase2` | `schemaVersion=1`, `scenarioName`, `assignedGateId`, `terminal`, complete `settings`, `observations[]`, hidden `truth[]` |
| Observed event / `Observation` | `passengerId`, `type`, `timeSeconds`, `checkpointId`; types `CHECK_IN_CLEARED`, `SECURITY_ENTERED`, `SECURITY_CLEARED`, `CHECKPOINT`, `GATE_ARRIVED` |
| Staff event / `StaffEvent` | `passengerId`, `kind` (`STAFF_APPROVAL` or `GATE_VERIFICATION`), `timeSeconds`, `confirmed`; separate from passenger observations |
| Readiness / `ReadinessSnapshot` | `dataKind`, `asOfSeconds`, nullable `latestObservedAtSeconds`, `assignedGateId`, `passengers[]`; **no wire schemaVersion field** |
| Readiness passenger / `ReadyPassenger` | Allowlisted booking fields plus `checkIn`, `security`, nullable `lastCheckpoint`, nullable `gateObservedAtSeconds`, `readyAtGate`, `prediction`, `readinessBlockers[]`, nullable `likelyReadyWithinSeconds`; no actual arrival, behavior or future tape |
| `events-<strategy>.json` / `TraceEnvelope` | `traceSchemaVersion=1`, `dataKind`, `strategy`, `inputHash`, `metadata`, `metrics`, `validation`, `events[]`; metadata also has `schemaVersion=1` |
| `recommendations-adaptive.json` / `RecommendationEnvelope` | `dataKind`, `strategy=adaptive`, `inputHash`, `recommendations[]`; **no envelope schemaVersion field** |
| `timings-<strategy>.json` / `Result` | `strategy`, `dataKind`, `seed`, `inputHash`, `metrics`, `passengerTimings`, `constraintViolations`, `validation`; optional `adaptiveVersion`, `policyProfileId`, `policyAdvisories`; **no schemaVersion field** |
| Per-flight `comparison.json` / `Comparison` | `schemaVersion=1`, `dataKind`, `seed`, `flightId`, `inputHash`, `metricNotes`, `results[]`; optional scenario/policy/controller metadata |
| Suite `comparison.json` / `Benchmark` | `schemaVersion=1`, `comparisonType=STAGE6_POLICY_ENABLED`, seeds/cases/strategies, settings/source hashes, `experiments[]`, `summaries[]`, legacy replay metadata |
| `policy-preview.json` / `PolicyAdvisory` | `timeSeconds`, advisory/approval flags, `action`, `unitId`, `memberIds`, `simulationAdmissionAllowed`, `reason`; successful suggestions include `profileId`. No run/input identifier in this existing preview contract. |

Do not confuse the two different `comparison.json` shapes: a suite root is `Benchmark`, each case/seed subdirectory is `Comparison`. Package version, manifest schema, terminal schema, trace schema and controller version are different concepts. `adaptiveVersion` in results is `passenger-aware-v2`; recommendation records use `algorithmVersion`. The current legacy result does not add an `adaptiveVersion=legacy-v1` field. Enforce the external contract version when loading; a future API should add an explicit versioned run wrapper. No such API is implemented here.

### Passenger fields, units and readiness

`seatNumber` is `1A` through `30F` by default (example uses rows 1-3). A/F are window seats, B/E middle and C/D aisle; the two sides are ABC and DEF. `boardingZone` is numeric 1/2/3 (rear/middle/front), distinct from policy `stage`. `travelClass` is `ECONOMY`, `PREMIUM_ECONOMY` or `BUSINESS`; there is no `FIRST` enum. Confirmed First entitlement is a separate policy ID list. `assistance` is `{ type: NONE|MOBILITY|EXTRA_TIME, companionId: string|null }`; it describes only operational arrangements, never diagnoses. Required groups can merge original parties and confirmed families. Treat every `unitId` as an **opaque string**, not a passenger ID or parseable CSV list.

`carryOnAllowance` contains `overheadPieces`, `personalItems`, `maxOverheadWeightKg`; `actualBaggage` contains `overheadPieces`, `personalItems`, `overheadWeightKg`. The observation catalog's `declaredCabinBaggage` is a known synthetic declaration copied from that profile. It is not a future stowing-duration sample. `behavior` contains hidden sampled `walkSecondsPerRow`, `stowSecondsPerBag`, `seatSeconds` for execution/replay only.

The origin is `flight.boardingOpenTime` / trace `metadata.timeOrigin`, an ISO 8601 UTC instant. All relative timestamp fields (`*AtSeconds`, `timeSeconds`, `asOfSeconds`, gate arrival/ETA) are **seconds from that origin**, not Unix seconds or milliseconds. Negative check-in/security/gate observations are valid before boarding opens; aircraft events start at zero. Duration fields are elapsed seconds. Terminal distances are meters; terminal speeds are meters/second; aircraft walking is seconds/row. For display only: `new Date(Date.parse(origin) + relativeSeconds * 1000)`. Never substitute the computer's current time.

Manifest `checkInStatus` and `securityStatus` are eventually `CLEARED` even when inspecting an earlier decision time. Do not display them as current readiness. In snapshots, `checkIn.status` is `NOT_OBSERVED|CLEARED`; `security.status` is `NOT_OBSERVED|SCREENING|CLEARED`. An entrance scan produces `SCREENING`; only its separate clearance event grants `CLEARED`. A clearance can legitimately have `scanAtSeconds=null` if the entrance scan is missing. Missing evidence is not false evidence and must not be inferred from hidden truth.

`prediction` has four shapes: `NO_OBSERVATION` (ETA/reachability null), `NO_ACCESSIBLE_ROUTE` (ETA null, reachable false), `OBSERVED_AT_GATE` (observed ETA, zero remaining route/security/stops), or a route-based forecast. The latter includes `remainingDistanceMeters`, `route[]`, `securityRemainingSeconds`, `expectedStopDelaySeconds`, `observationAgeSeconds`, `overdue`, `securityOverdue`, and basis `SECURITY_ENTRY_WITHOUT_CLEARANCE|LAST_OBSERVED_CHECKPOINT`. Optional fields must not be assumed present on every basis. A zero `likelyReadyWithinSeconds` is not staff approval or proof of presence.

All observed events use their synthetic occurrence time as observation time; there is no separate ingestion/receipt timestamp or live out-of-order stream. `createReadinessObserver().snapshot(t)` advances monotonically. For backward seeking, recreate an observer or replay the saved tape to the target time. Never send the full future tape or `phase2.truth` into the controller.

### Trace event contract and replay

Every event has `timeSeconds`, `type`, `sequence` and `eventIndex`. The following fields are additional and required for that tagged event:

| Type | Additional fields |
| --- | --- |
| `stage_opened` | `stage` |
| `unit_called` | `unitId`, `stage`, `assisted`, `memberIds` |
| `boarded` | `passengerId`, `cell`, `seatNumber`, `stage`, `unitId` |
| `moved` | `passengerId`, `fromCell`, `cell` |
| `row_service_started` | `passengerId`, `cell`, `blockingSeats`, `assistanceSeconds`, `stowSeconds`, `seatInterferenceSeconds`, `seatingSeconds`, `serviceEndSeconds` |
| `assistance_started` | `passengerId`, `durationSeconds` |
| `assistance_completed` | `passengerId` |
| `stow_started` | `passengerId`, `pieces` |
| `stow_completed` | `passengerId` |
| `seat_interference_started` | `passengerId`, `blockingSeats` |
| `seat_interference_completed` | `passengerId` |
| `seating_started` | `passengerId` |
| `seated` | `passengerId`, `cell` |
| `aisle_block_started` | `passengerId`, `cell`, `blockedCell`, `blockedByPassengerId` |
| `aisle_block_ended` | `passengerId`, `cell`, `durationSeconds` |
| `gate_entry_block_started` | `passengerId`, `blockedByPassengerId` |
| `gate_entry_block_ended` | `passengerId`, `durationSeconds` |
| `escort_released` | `unitId` |
| `boarding_completed` | `passengerCount` |

Replay **by `eventIndex`** (the export array is already sorted), not `sequence`. Service-phase completion events are emitted ahead of time internally, so emission sequence is not chronological. At identical times preserve `eventIndex` order; occupancy uses half-open intervals. The aisle has entrance cell 0 and row cells 1..N, capacity one per cell. On `boarded`, place at 0; on `moved`, move from `fromCell` to `cell`; on `seated`, clear the aisle cell and occupy the assigned seat. Row occupants remain in the aisle during service. Lookup row/seat/unit/stage from `metadata.passengers` or the manifest. Zero-duration phases need not emit start/end events; never invent a missing service phase. `blockedByPassengerId` identifies the blocker at interval start, not necessarily every later tick's front occupant.

These are **offline actual simulation traces**. `row_service_started.serviceEndSeconds` and its phase durations disclose sampled future execution truth. They may drive retrospective animation, but must never be reused as controller observations or labeled a prediction. Filter events to the playback clock for rendering; a live/advisory adapter would additionally need to redact future-truth fields, not merely filter event timestamps. Actual gate-arrival observation events are in the terminal tape, not in aircraft `events[]`.

### Adaptive recommendation contract

Core fields are `timeSeconds`, `informationTimeSeconds`, nullable `latestObservedAtSeconds`, `stage` when available, `action=WAIT|RELEASE`, nullable `unitId`, ordered `memberIds`, nullable `plannedUnitId`, `predictedReadyAtSeconds`, `releaseAtSeconds`, `nextReviewSeconds`, `readyUnitCount` when available and `reason`. Safety-error records can omit stage/latest-observation/count. Optional legacy lookahead fields are `currentReadyScore`, `anticipatedScore`, `remainingAnticipationBudgetSeconds`.

V2 adds `algorithmVersion`, `reasonText`, advisory/approval flags, optional `score`, `scoreComponents`, `projectedCompletionDelaySeconds`, `plannedGateETASeconds`, `readinessUncertaintySeconds`, `staleETA`, `policyReason` and `releaseInterval`. The shared engine adds `trigger` and `executionAuthorization=NONE_ADVISORY_ONLY`. Trigger values are `PASSENGER_OBSERVATION`, `STAFF_OBSERVATION`, `CABIN_PROGRESS`, `STAGE_OR_REVIEW_TIMER`.

`releaseInterval` is null/absent on a hold; a release has `notBeforeSeconds`, `minimumDurationSeconds`, `forecastOnly=true` and sometimes `actualEntryRequiresFreeAisleCell=true`. It is a group-call proposal/minimum headway interval, not guaranteed aircraft entry or a guaranteed upper bound. Protected groups may be called while the entrance is occupied. Actual entry still requires actual presence, observed clearance, staff/gate confirmation, policy, escort and a free aisle cell.

`scoreComponents` is not uniform even within v2: protected stages reuse legacy components (`seatDepth`, `knownSeatInterference`, `baggage`, `row`, `zone`, `congestion`, `waiting`); general v2 components are `expectedCompletion`, `inducedBlocking`, `pathCongestion`, `knownSeatInterference`, `seatAccess`, `baggageOverlap`, `rearCoverage`, `waiting`, `readinessUncertainty`. Render available component keys and label them as weighted heuristic costs, not measured seconds. Missing/null ETA and approval predictions are intentional. For unready v2 groups `predictedReadyAtSeconds` is null because gate ETA does not predict staff approval. Protected v2 records can retain the legacy observed ETA, including a negative timestamp. The uncertainty margin is uncalibrated, not a statistical confidence interval.

All recommendations are advisory under `BF-SWISS-INSPIRED-V1`. PREBOARD precedes combined First/Business/eligible elite PRIORITY, then GENERAL. Required families/parties remain intact; mixed WilMA parties use mean seat depth rather than splitting. Readiness alone excludes staff approval; consult policy advisories/confirmations as well. `policy-preview` assumes no earlier admissions and cannot act as an ongoing flight-state endpoint. Senior or pet labels confer no automatic priority/time penalty; there are no diagnosis fields. See [Stage 5](STAGE5_AUDIT.md) and [Stage 6](STAGE6_AUDIT.md) for the simplified research policy and its limitations.

### Result metrics and passenger timings

| Exact metric | Unit / definition |
| --- | --- |
| `passengerCount` | Passenger count |
| `totalBoardingSeconds` | Seconds from opening (t=0) to final seating, including idle time |
| `activeBoardingSeconds` | Seconds from first actual entry to final seating, including subsequent idle time |
| `totalGateWaitSeconds` | Sum of actual entry minus actual gate arrival; passenger-seconds |
| `meanGateWaitSeconds` | Mean of those durations, seconds/passenger |
| `maxGateWaitSeconds` | Largest actual gate wait, seconds |
| `aisleBlockingPersonSeconds` | Sum of ready-to-walk time blocked by the next cell; excludes own row service |
| `aisleBlockingPersonMinutes` | Same passenger-time aggregate / 60 |
| `meanAisleBlockingSeconds` | Mean blocked duration per passenger, seconds |
| `gateEntranceBlockedSeconds` | Elapsed seconds an already-called active unit waits for entrance cell 0; not total gate queue waiting |
| `rowServicePersonSeconds` | Sum of row assistance + stowing + interference + seating, passenger-seconds |
| `stowPersonSeconds` | Sum of actual row luggage service, passenger-seconds |
| `seatInterferencePersonSeconds` | Sum of interference service, passenger-seconds |
| `seatInterferenceCount` | Count of already seated blocking-seat encounters; not count of affected passengers |
| `maxConcurrentInAisle` | Maximum occupants including row-service passengers and entrance, bounded by rows+1 |
| `constraintViolationCount` | Independent violation count; detailed categories in `constraintViolations.counts` |

`passengerTimings[]` joins by `passengerId` (manifest uses `id`) and includes `seatNumber`, opaque `unitId`, `stage`, actual `gateArrivalSeconds`, `boardedAtSeconds`, `rowArrivalSeconds`, `seatedAtSeconds`, `gateWaitSeconds`, `freeWalkingSeconds`, `aisleBlockingSeconds`, `assistanceSeconds`, `stowSeconds`, `seatInterferenceSeconds`, `seatInterferenceCount`, `seatingSeconds`, `rowServiceSeconds`, `inAisleSeconds`. Start/finish values are relative clock instants; the other time fields are durations. Timings are admission-ordered, not passenger-ID ordered. JSON numerics can be fractional; engine metrics are rounded to six decimals, ETA/scores commonly to three.

Gate wait includes pre-opening time, so mean wait or passenger-minutes can exceed total boarding duration. `gateEntranceBlockedSeconds` is not directly comparable as total congestion across controllers: v2 can hold a group before calling it. Use actual completion, gate wait and aircraft blocking for the main comparison. In CSV, `actualGateArrivalSeconds` is an alias of manifest `gateArrivalSeconds`; Phase 1's legacy `estimatedGateArrivalUTC` is also derived from actual arrival and is **not an ETA forecast**. The readable CLI prints minutes or m:ss; JSON/CSV retain the explicit units above.

## Small, real integration outputs

Start with [examples/integration/README.md](../examples/integration/README.md) and [output/index.json](../examples/integration/output/index.json). The checked fixture is seed 42, normal arrivals, **3 rows/18 passengers**, not the 180-passenger benchmark. Its 19 JSON files total 367735 bytes, including full validated traces and timing results for all five strategies, readiness at -700 and 0 seconds, policy advice, v2 recommendations, ETA errors and a one-case statistics export. All 19 trace event types occur. No trace event was invented or truncated.

```powershell
node scripts/generate-integration-examples.js --output results/team/example-regenerated
node scripts/generate-integration-examples.js --scenario security-delays --output results/team/example-security
node --test test/handoff.test.js
```

The generator is an offline fixture tool invoking actual CLI commands. It compacts JSON whitespace only, validates every trace and stores file SHA-256 values. It never deletes unrelated output files. Use an empty/dedicated output directory. For a browser prototype, serve the existing fixture as static files through the teammate's chosen development server and use `index.json` as the file inventory. File URLs can be blocked by browser fetch rules; opening raw HTML from disk is not a backend API.

Optional independent JSON Schema validation uses **Ajv 8.17.1 + ajv-formats 3.0.1** installed outside this dependency-free project. Draft 2020-12 needs the [Ajv 2020 validator class](https://ajv.js.org/json-schema.html#draft-2020-12). These are verification tools, not backend runtime dependencies:

```powershell
$schemaTools = Join-Path ([System.IO.Path]::GetTempPath()) 'boardingflow-schema-tools'
npm.cmd install --prefix "$schemaTools" --no-save --package-lock=false --ignore-scripts --no-audit --no-fund ajv@8.17.1 ajv-formats@3.0.1
node scripts/validate-integration-schemas.js --validator-dir "$schemaTools"
```

This compiles all 59 definitions, validates 19 outputs plus two configuration inputs, and rejects five malformed/version/future-field examples. `node --test` needs no Ajv installation. The contract tests additionally verify file fingerprints, all event field sets, independent replay, timestamp joins and regeneration of all three existing small scenarios.

## Stage 8: available interfaces and missing transport

The backend supports scenario selection and comparison **through the CLI and Node ESM APIs**, so offline replay integration can begin now. It does **not** expose HTTP endpoints or browser-executable simulation modules.

| Need | Available now | Missing for a plain browser UI |
| --- | --- | --- |
| Select a scenario/seed/config | `stage6 --cases ... --seeds ...`; `generateScenario(seed, name, generation, settings)` | Request validation and scenario/config catalog endpoint |
| Build a policy-enabled flight | `stage6Scenario(seed, name, generation, policyConfig)`; async; default synthetic fixture confirms requested assistance | Staff/config selection UI and versioned request contract |
| Compare all five | `compareAllStrategies(manifest, {trace:true, adaptiveSettings})` returns frozen-input comparison | Run/job endpoint and per-run output identity |
| Run one strategy | `simulate(manifest, strategy, {trace:true, adaptiveVersion, adaptiveSettings})` | Transport, error mapping and worker/process lifecycle |
| Draw aircraft/replay | `events-*.json`, manifest geometry, per-passenger timing and metrics | Teammate's renderer, playback controls and file loader |
| Display readiness/ETA | `createReadinessObserver(manifest).snapshot(t)` | Observation-only transport; recreate observer for backward seek |
| Update advice | Current batch simulator records dynamic `recommendations[]` | Live stepping/subscription, streaming progress, cancellation and stateful staff-action endpoints |

These Node modules use `node:crypto`, filesystem exports and synchronous simulation work; do not bundle them directly into a browser or run long jobs on a future server's request event loop. A later adapter can use a child process/worker and unique output directory, validate requests with existing domain validators, return a versioned run envelope and serve completed artifacts. That adapter is intentionally **not built** in this handoff. There is no authentication/CORS/progress/error JSON API, live DCS connection, deployment setup, live gate verification or map integration.

For offline Stage 8 replay: verify bundle/input/strategy versions, load metadata and all referenced passenger IDs, process all events up to the playback clock, render cabin occupancy/seats, and display metrics without recalculating physics. For readiness, filter the terminal observation tape or load saved observation-only snapshots. For recommendations, show reasons/holds as advisory; do not create a real boarding authorization button from `RELEASE` or `simulationAdmissionAllowed`.

## Audit findings and integration risks

| Finding | Integration rule / disposition |
| --- | --- |
| Local `compare` selects random/zone/adaptive; committed `compare` selects the three baselines. Local `scenarios`, `demo --scenario`, `npm run phase2`, extra Phase 2 docs/config are not committed. | Use `compare-all` or the documented `stage6` command. No unrelated local behavior was published or changed. |
| Some exports have no wire schemaVersion; filenames `comparison.json` have two shapes. | Use the formal definition and external bundle version; detect suite `comparisonType`. A future API needs a versioned wrapper. |
| Manifest statuses, raw trace service-end times and future observation tapes contain hidden truth. | Offline replay data are not an observation-only decision API. Keep readiness/approval and actual evaluation feeds separate. |
| Passenger IDs, unit IDs, zone, class, policy stage and score shapes differ by purpose. | Join `id` to `passengerId`; treat units as opaque; never infer stage from zone/class alone or assume uniform score component keys. |
| Legacy CSV uses a misleading estimated-arrival alias; CLI formats durations differently from JSON. | Prefer explicit JSON fields and the metric/unit tables; no field was renamed to break compatibility. |
| Policy confirmation IDs can be fixture-specific; assisted/required families may wait or relax strict WilMA order. | Validate the exact manifest/policy together. Keep rights above optimizer preferences; do not copy seed-42 IDs across arbitrary flights. |
| Forecasts can be optimistic and uncertainty is uncalibrated; `sampleSD=null` for n=1. | Render unknowns, distinguish forecast from observed fact, and do not manufacture a confidence interval. |
| Reusing output folders overwrites known generated files; there is no concurrent job API or atomic bundle publication. | Allocate a separate directory per run and publish/load only completed bundles. |
| Older Stage 4 saved terminal manifests can lack the now-required complete adaptive settings block. | Regenerate with the committed CLI; there is no automatic input migration. Historical ETA report reproduction is separate from loading an old manifest verbatim. |

No engine/optimizer bug requiring a behavior change was found. The immediate blocker for interactive browser-triggered runs is the absent transport/job adapter. It does not block static replay, contract integration or use of existing statistics. Review these contracts with both teammates before adding an API or a new experiment suite.

## Actual verification

| Check | Actual result |
| --- | --- |
| Fresh clone from GitHub | Exact Stage 6 commit `7e081741979b193ddfc6bbd8ce4dd17948b91381`; clean tracked tree before the handoff files were copied |
| Fresh optional dependency installation | `npm.cmd install --ignore-scripts --package-lock=false --no-audit --no-fund` succeeds; no project dependencies or lockfile required |
| Fresh committed Stage 6 test suite | **157/157 passed**, zero failures/skips/cancellations |
| Fresh Stage 6 plus only these handoff additions | **162/162 passed**; all five new handoff tests included, without unrelated local Phase 2 files |
| Complete original workspace plus handoff | **175/175 passed**; 13 additional uncommitted Phase 2 tests remain local |
| Real fresh full-flight CLI workflow | Generate/validate/apply-policy/compare-all/readiness succeed for **180 passengers**; all five independent traces validate; zero violations |
| Fresh 180-passenger normal seed-42 completion | Random **1557 s**, Zone **1715 s**, Baggage-Aware **1389 s**, WilMA **1487 s**, Adaptive **1306 s**, matching Stage 6 |
| Small integration fixture | **18 passengers**, five actual traces, all **19 event types**, zero violations; file fingerprints and per-passenger metrics reconcile |
| Existing scenario selection smoke checks | Normal/security-delay/late miniature cases each run all five strategies plus the retained legacy replay; deterministic normal fixture regeneration agrees |
| Independent JSON Schema checks | All **59 definitions** compile in strict Ajv 2020 mode; **63 positive JSON validations** (21 per scenario) pass and **15 negative validations** reject malformed/version/future-field examples (5 per scenario) |
| Windows checkout conversion | Git's actual checkout filter with `core.autocrlf=true` preserves fixture JSON bytes through the scoped LF attributes |
| Preservation | All **59 pre-existing workspace files** retain their original SHA-256 values; no existing runtime source is edited, nothing staged, HEAD unchanged |

The new deliverables are 29 files: this handoff, schema/guide, two helper scripts, five focused tests in one file, and the integration fixture directory (inputs, guide, scoped attributes and 19 actual JSON outputs). Test/verification scratch files, optional schema-validator packages and full-flight exports live in an OS temporary directory outside the repository.

The initial handoff verification did not commit or push; publication is handled separately after release checks. Generated full-flight verification outputs and logs are outside the project. Only the intentional small `examples/integration/output` bundle is provided as shareable sample data.
