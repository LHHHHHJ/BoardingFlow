# Stage 4 - Check-in, Security and Airport Map-Based Gate ETA

This stage audits and extends the existing local Phase 2 code. All passengers, events, processing times, terminal geometry and route lengths are SYNTHETIC. No Stage 5-9 behavior, dashboard or ML was implemented. This Stage 4 publication extracts only the readiness, synthetic journey and ETA dependencies. Existing adaptive/Stage 6 code and unrelated local Phase 2 changes remain uncommitted and unchanged.

## Six-item requirement audit

| Requirement | Before Stage 4 | Completion and evidence |
| --- | --- | --- |
| 1. Separate check-in, security entrance and clearance events | Complete event representation and observed statuses; ordering validation partial | Complete: `CHECK_IN_CLEARED`, `SECURITY_ENTERED` and `SECURITY_CLEARED` retain separate timestamps/checkpoints. Entry never clears security. Shared observation validation rejects duplicates, regressions and mismatched status/checkpoint types; exact-boundary and equal-time tests pass. |
| 2. Checkpoints, accessible routes, assigned gates and lengths | Graph/routing complete; exportable audit and verified map-reference boundary missing | Complete: original six nodes/seven edges unchanged. `terminal-audit` exports each accessible route to the assigned gate. Tests cover alternate gates, a lounge route, inaccessible shortcuts, malformed edges and disconnection. Official reference scope is documented below. |
| 3. Observed-checkpoint ETA with processing, distance, speed and stops | Complete estimator for ordinary observations; missing-scan support partial | Complete: existing estimator retained, configurable speeds/expected stops tested analytically. Missing entry/location scans use an earlier checkpoint until new evidence arrives. Overdue processing/location flags expose stale predictions. |
| 4. Prediction/truth separation and meaningful uncertainty/error reporting | Separate predictions and MAE/bias/RMSE complete; lost-clearance evaluation edge case partial | Complete: offline evaluation adds p90/max absolute errors, counts and observation age. Already observed gate arrivals are excluded even when readiness evidence is missing. Empty cohorts return null. No calibrated prediction interval is claimed. |
| 5. Missing scans, security delays, late passengers, strict decision-time restrictions | Partial: normal/delayed behavior and prefix isolation existed; validation required all primary scans and direct predictor lacked time guards | Complete: absent scans remain absent; no reconstruction from actual times. Missing mandatory evidence blocks boarding. The predictor rejects future observed timestamps. Prefix-perturbation and throwing-private-getter tests establish the information boundary. |
| 6. Normal/delayed tests and explicit synthetic-map claims | Partial: previous scenario tests existed; focused missing-scan/route/tail-error tests and official reference audit missing | Complete: 19 focused Stage 4 tests; full workspace 113/113 pass. Twelve 180-passenger ETA evaluations across seeds 7,42,123 include normal, delayed security, late arrivals and lost entry/junction observations. Distances are expressly nonofficial. |

## Event and information contract

The existing manifest stores eventual simulated check-in/security completion and actual gate arrival. These are execution/evaluation truth. The observation tape supplies separate status events. Missing tape events do not remove the corresponding private physical event, and physical completion alone cannot grant observed readiness.

| Event | Checkpoint | Observed effect |
| --- | --- | --- |
| `CHECK_IN_CLEARED` | `CHECK_IN` | Check-in cleared at its event time. |
| `SECURITY_ENTERED` | `SECURITY_ENTRY` | Screening begun; clearance remains unknown. |
| `SECURITY_CLEARED` | `SECURITY_EXIT` | Clearance explicitly observed, even if entry scan is missing. |
| `CHECKPOINT` | Post-security intermediate node, e.g. `JUNCTION` | Updates known location only; grants no clearance. |
| `GATE_ARRIVED` | Assigned gate | Confirms location; grants neither missing check-in nor missing security clearance. |

One journey advances through this event order. Available tape entries can be stored out of order; deterministic sorting resolves equal times by passenger ID and event type. Check-in and entrance can share a time; physical entrance must strictly precede physical clearance. Intermediate checkpoints can repeat; singleton status events cannot. A generic checkpoint cannot masquerade as a status checkpoint.

Offline `validateScenario` may inspect the full scenario, including actual times, to check imported truth/event consistency. At runtime, only the observation adapter holds the future tape. It consumes events with `timeSeconds <= now`; event-level progression checks run when events become observed. `estimateGateETA` receives an allowlisted static catalog plus observed state, route distances and configured assumptions. It imports no scenario generator or truth model. Actual passenger timestamps, actual walking speed, actual stop duration, future clearance outcomes and sampled aircraft service durations are excluded. Tests prove that even invalid future location payloads do not affect an earlier valid prediction, although offline validation will reject that complete scenario.

Static booking information includes seat, zone, class, priority, party, assistance and cabin-baggage declarations. Snapshot readiness requires observed check-in clearance, security clearance and gate presence. `readinessBlockers` explains absent evidence using current observations only. There is no missing-scan fallback that reads private truth. When a required confirmation never arrives, boarding stays blocked and the existing simulator fails explicitly at its timeout; manual reconciliation and additional operational workflows remain outside scope.

## Retained terminal graph and official reference boundary

The graph remains exactly the original invented bidirectional geometry:

| Edge | Model distance | Accessible in model |
| --- | ---: | --- |
| Check-in - security entrance | 120 m | Yes |
| Security entrance - exit | 0 m | Yes; processing time added separately |
| Security exit - junction | 180 m | Yes |
| Junction - gate B | 240 m | Yes |
| Junction - lounge | 100 m | Yes |
| Lounge - gate B | 220 m | Yes |
| Junction - gate B shortcut | 60 m | No; always excluded |

Shortest accessible distances to `GATE_B`: check-in 540 m, security entrance/exit 420 m, junction 240 m, lounge 220 m, gate 0 m. All passengers use accessible routes, with assisted walking speed modeled separately. The zero-distance edge is a process boundary, not an airport floor-plan assertion. A disconnected route returns no ETA; complete scenario validation rejects an inaccessible assigned gate. `GATE_B` is a fictional identifier, with no claimed correspondence to a Pearson gate.

Verified official sources (accessed 2026-11-07):

- [Toronto Pearson terminal maps](https://www.torontopearson.com/en/while-you-are-here/terminal-maps): official landing page links Terminal 1 Level 3 Check-in and Level 2 Departures maps.
- [Official Terminal 1 Level 3 Check-in PDF](https://cdn.torontopearson.com/-/media/project/pearson/content/travel/while-you-are-here/terminal-maps/new-pdfs/toronto-pearson-terminal-1-map-check-in-20190429.pdf): check-in level and a legend including security gates, elevators and lounges.
- [Official Terminal 1 Level 2 Departures PDF](https://cdn.torontopearson.com/-/media/project/pearson/content/travel/while-you-are-here/terminal-maps/new-pdfs/toronto-pearson-terminal-1-map-departures-20190429.pdf): departures layout, gate labels and security/elevator/lounge legend.

The linked PDFs have 2019-dated filenames and are used as optional qualitative context, not as a current operational routing database. Supported reference elements are the existence of check-in, security, departure gates, lounges and elevators. Collapsing these into six nodes, every connection, distance, accessibility flag, walking speed and delay distribution is a modeled assumption. No map scale, official walking distance, official processing time or certified accessible route was derived. No artwork, screenshot or PDF is copied into this project. This is not an implementation of Pearson's actual multi-level geometry or border-processing rules.

## ETA calculation and configuration

Forecast walking time is accessible checkpoint-to-gate distance divided by configured walking speed: 1.2 m/s normally, 0.8 m/s with assistance. Expected remaining stop delay is `stopProbability * (min + max) / 2`: defaults 25% and 30-180 seconds, yielding 26.25 seconds. Forecast stops use an expectation, not new random draws at each decision.

Before observed security entry, the model adds the configured 180 seconds of security processing. While observed screening continues, remaining processing is `max(30, 180 - elapsedSinceEntry)` and is anchored to the current decision time; elapsed time alone never clears security. After explicit clearance, no processing delay is added. Walking estimates anchor to the latest observed checkpoint time; overdue estimates roll forward by 15 seconds. Reported route distance is from that known checkpoint, not a tracked current position. `observationAgeSeconds`, `securityOverdue` and `overdue` flag stale evidence.

Actual journeys retain the original independent speed, processing and stop draws. Hidden security-delay and late-stop outcomes are intentionally not supplied to the estimator. The synthetic means can therefore be badly wrong under unannounced delays; measured errors, including poor cases, are retained in the results report. Truth is joined only in the offline evaluator. Error is predicted minus actual, with negative bias meaning an early prediction. P90 uses the nearest-rank percentile. Error cohorts exclude observed gate arrivals and report their size; shrinking cohorts are not a fixed-population improvement comparison.

The published `src/phase2-config.js` includes only the existing ETA and synthetic-scenario sections; the adaptive section and its validation remain local. ETA/scenario defaults and random draws are unchanged. Consequently published terminal manifests omit the local adaptive settings block, so whole-manifest hashes differ from full-workspace terminal manifests even though arrival truth, observations and ETA outputs match. New `config/stage4.example.json` demonstrates ETA speeds, security estimate/minimum, possible-stop probability/bounds, overdue review allowance and synthetic security-delay settings. Supply it with `generate --scenario ... --phase2-config config/stage4.example.json`. It changes no adaptive settings. If assumptions are supplied during generation, they also define the generated truth distributions; tests separately change forecast assumptions on a saved scenario and verify actual arrivals are unchanged. The existing schema and Stage 4 field names are retained; no optimizer configuration or adaptive execution path is published.

## Changed files and verification

| File | Stage 4 change |
| --- | --- |
| `src/observations.js` | Shared observation-only event types, sorting, checkpoint validation and monotonic single-journey progression. |
| `src/scenarios.js` | Reuse event contract; permit missing observations while checking every supplied status event against offline truth; retain generator/default draws. |
| `src/readiness.js` | Validate decision-time views, apply observed-event progression, expose readiness blockers/staleness, correct gate-observation evaluation exclusion and add tail-error metrics. |
| `src/terminal.js` | Export structured route audit; reject null/malformed edges; retain default graph and shortest-route algorithm. |
| `src/cli.js` | Add `terminal-audit` and `eta-evaluate`, JSON/CSV output and finite/distinct evaluation-time validation. |
| `config/stage4.example.json` | Optional settings example with no adaptive overrides. |
| `test/stage4.test.js` | 19 focused tests covering all six requirements, analytic metrics, missing scans, information isolation, alternate routes, CLI/config and repeatability. |
| `README.md` | Runnable Stage 4 verification commands and report links. |
| `src/phase2-config.js` | Publish only ETA/scenario configuration and validation; leave optimizer settings local. |
| `src/simulate.js` | Stage 4 observation-driven baseline readiness and admission guards only; no adaptive controller. |
| `src/io.js` | Name terminal-scenario arrival truth as actual in passenger exports; retain Phase 1 CSV compatibility. |
| `test/readiness.test.js` | Reuse nine existing Stage 4 observation, route and ETA tests. |
| `docs/STAGE4_AUDIT.md` | This before/after checklist, source boundary, method, configuration and limitations. |
| `docs/STAGE4_RESULTS.md` | Actual test/accuracy measurements and compatibility evidence. |

Run the commands in README to generate normal/delayed scenarios, inspect readiness, audit routes and export ETA errors. The isolated published tree passes 100/100 tests: the existing 72 plus nine reused readiness tests and 19 Stage 4 tests. The complete local workspace passes 113/113, including the separate adaptive integration work. Both runs have no failures/skips/cancellations. All 99 Stage 3 baseline runs, metrics and input fingerprints exactly match the existing verified Stage 3 report. Committed Stage 1-3 tests and baseline spatial/constraint audits pass. Full-workspace Phase 2 dataset regressions and adaptive no-future-truth tests also pass. The isolated tree reproduces all 12 saved Stage 4 evaluation reports (36 cohorts and per-passenger errors) exactly.

To inspect a reproducible missing-scan case without changing actual arrival truth:

```javascript
import { generateScenario, validateScenario } from './src/scenarios.js';
import { evaluateGateETA } from './src/readiness.js';
const manifest = generateScenario(42, 'normal');
manifest.phase2.observations = manifest.phase2.observations.filter(
  e => !['SECURITY_ENTERED', 'CHECKPOINT'].includes(e.type));
validateScenario(manifest);
console.log(evaluateGateETA(manifest).summaries);
```

Generated manifests, snapshots, route audits and evaluation JSON/CSV are under Git-ignored `results/stage4/`. Limitations include no observation latency/correction workflow, no automatic dropout sampler, no measured or calibrated airport geometry, no reliable security queue-tail forecast, no calibrated ETA intervals, no live data, and no security-denial/no-show/departure-cutoff process. Missing required evidence remains unresolved rather than silently authorizing boarding. Existing adaptive policy code is preserved; this stage does not extend it.

## Publication isolation

The combined `docs/PHASE2.md`, Phase 2 suite CLI, adaptive exports, controller, strategy selection and optimizer settings remain local. Stage 4 documentation is fully represented here and in `STAGE4_RESULTS.md` and README. No dashboard, ML or later-stage optimizer is included. The shared simulation engine gains only the observation-admission hooks already verified by Stage 4; aircraft movement/service logic and baseline ordering stay unchanged.
