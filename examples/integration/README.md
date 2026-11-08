# Actual simulator integration fixture

This is **synthetic seed 42, normal arrivals, 3 rows x 6 seats = 18 passengers**. It is intentionally small for file loading/replay, not the Stage 1 180-passenger target or a Stage 7 performance study. The full backend still defaults to 180 passengers. Read geometry from the manifest/trace metadata rather than hardcoding 30 rows in a renderer.

The output files were emitted through the **clean committed Stage 6 CLI**, reference `7e081741979b193ddfc6bbd8ce4dd17948b91381`. The generator compacts JSON whitespace but never invents, samples away or rewrites events. Independent replay validates all five complete traces. The normal fixture exercises all 19 aircraft event types, confirmed assistance/escort, an under-five family and First/elite protected entitlements.

`generation.json` is a partial generation override. `policy.json` is an explicit **seed-42/18-passenger-only** synthetic fixture: confirmed First ID `SYN-P004`, elite `SYN-P013`, confirmed requested assistance `SYN-P017`, and family `SYN-P001`/`SYN-P002`. Existing party links may merge additional members under the unchanged policy. Staff approval is simulated at actual arrival and gate verification five seconds later, prepared offline and hidden from decisions until observed. These are not real airline permissions. First entitlement is a policy list, not a `FIRST` travelClass value. Age/pet labels confer no inferred rights or time penalty.

| File in `output/` | Use |
| --- | --- |
| `index.json` | Bundle version, scenario, seed, one input hash, ordered strategy keys and SHA-256 for every payload |
| `manifest.json` | Geometry, passengers, saved configuration, policy, terminal observations and hidden execution truth |
| `comparison.json` | All five metrics/constraint summaries on the same input |
| `events-{random,zone,baggage-aware,wilma,adaptive}.json` | Complete actual replay traces with metadata and independent validation |
| `timings-{random,zone,baggage-aware,wilma,adaptive}.json` | Per-passenger actual timing, metrics and policy advisories |
| `recommendations-adaptive.json` | Observation-only advisory decisions with reasons, scores, triggers and release intervals |
| `readiness-early.json`, `readiness-0.json` | Observation-only status/ETA at t=-700 and t=0 seconds |
| `policy-preview.json` | Separate advisory readiness/approval review at t=0, assuming no previous admissions |
| `eta-evaluation.json` | Retrospective prediction errors; never a controller input |
| `benchmark.json` | Actual one-case Stage 6 report, five results plus legacy replay, statistics with n=1 and null sample SD |

All JSON time values use seconds relative to `manifest.flight.boardingOpenTime`, except duration fields which are elapsed seconds and explicit speeds/distances. The trace's `eventIndex` is playback order; `sequence` is emission identity. Terminal distances are invented and are **not Toronto Pearson measurements**. Raw manifest/status/trace truth is for offline replay; use readiness snapshots for decision-time facts. Staff approval remains separate from `readyAtGate`.

Regenerate without installing dependencies:

```powershell
node scripts/generate-integration-examples.js --output results/team/example-normal
node scripts/generate-integration-examples.js --scenario security-delays --output results/team/example-security
node scripts/generate-integration-examples.js --scenario late-arrivals --output results/team/example-late
node --test test/handoff.test.js
```

Omit `--output` to refresh this intentional example folder. Use a dedicated directory: generation replaces its known payload filenames, preserves unrelated files and cleans only its own guarded OS temporary directory. The optional `--backend directory` verifies exports from another clean checkout. The script uses the generation/policy fixtures beside this README and invokes that checkout's real CLI. It always uses seed 42; the policy IDs are not a generic policy for other seeds.

Identical inputs and source produce identical simulator outcomes. Source byte hashes inside `benchmark.json`, and hence that file's/bundle's hashes, can differ across LF/CRLF checkouts while manifest hashes, events and metrics remain identical. `baselineReferenceCommit` identifies the compatibility reference, not an automatically detected current commit. Preserve the report's runtime source hashes when comparing provenance.

The scoped `.gitattributes` keeps `output/*.json` at LF on checkout so the stored file fingerprints remain valid even when Windows Git uses automatic CRLF conversion. It does not change line-ending rules for existing backend or teammate files.

Measured normal miniature results (all zero violations):

| Strategy | Completion (s) | Mean gate wait (s) | Blocking (person-min) |
| --- | ---: | ---: | ---: |
| Random | 320 | 477.777778 | 6.400000 |
| Zone | 299 | 471.833333 | 5.766667 |
| Baggage-Aware | 265 | 471.222222 | 4.766667 |
| WilMA | 285 | 474.722222 | 5.450000 |
| Adaptive | 253 | 468.500000 | 4.450000 |

These numbers demonstrate loading/replay, not general strategy superiority. Waiting includes time before opening, so it can exceed boarding completion time. See the [team handoff](../../docs/TEAM_HANDOFF.md) for complete schemas, real 180-passenger commands, statistics, future-information boundaries and the missing browser transport interface.
