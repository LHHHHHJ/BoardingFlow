# Stage 4 measured verification and gate ETA results

All data, walking distances and timing distributions are SYNTHETIC. These are post-run forecast errors, not calibrated confidence intervals or operational airport forecasts.

- `node --test test/stage4.test.js`: 19/19 pass.
- Isolated published tree: `node --test` passes 100/100 (72 existing, nine reused readiness tests, 19 Stage 4); full local workspace: 113/113. No failures, skips or cancellations.
- Twelve 180-passenger ETA evaluations (reproduced exactly in the isolated published tree): seeds 7, 42, 123; normal, delayed-security, late-arrival and missing-entry/junction cases; t=0,300,600 gives 36 cohorts.
- All 99 Stage 3 benchmark runs exactly reproduce the saved pre-Stage-4 report, including input fingerprints, metrics, summaries and losses.
- Committed Stage 1-3 regression tests and spatial/constraint checks pass. The full workspace also passes its Phase 2 generation-hash and adaptive future-truth tests. Adaptive implementation/settings remain local; removing that settings block from published terminal manifests changes only their configuration metadata, not arrival truth or ETA results.

## Opening-time results across all seeds

Errors are seconds. Bias is prediction minus actual; negative predicts too early. Observed gate arrivals are excluded.

| Seed | Case | Forecasts / 180 | Already at gate | Unavailable | MAE | Bias | RMSE | P90 absolute | Maximum absolute |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 7 | normal | 65 | 115 | 0 | 57.758 | -14.850 | 71.529 | 107.750 | 216.750 |
| 7 | security-delays | 95 | 85 | 0 | 186.711 | -159.474 | 281.717 | 495.750 | 1003.750 |
| 7 | late-arrivals | 89 | 91 | 0 | 560.048 | -537.205 | 821.253 | 1502.750 | 1819.000 |
| 7 | missing-entry-and-junction | 65 | 115 | 0 | 65.819 | -15.073 | 79.037 | 117.750 | 216.750 |
| 42 | normal | 55 | 125 | 0 | 41.841 | -16.677 | 63.612 | 90.000 | 267.750 |
| 42 | security-delays | 87 | 93 | 0 | 228.632 | -214.213 | 333.718 | 613.750 | 981.750 |
| 42 | late-arrivals | 84 | 96 | 0 | 442.949 | -427.693 | 697.986 | 1281.000 | 1653.000 |
| 42 | missing-entry-and-junction | 55 | 125 | 0 | 49.591 | -17.818 | 68.502 | 90.750 | 267.750 |
| 123 | normal | 70 | 110 | 0 | 43.679 | -18.729 | 59.701 | 94.250 | 228.750 |
| 123 | security-delays | 98 | 82 | 0 | 221.816 | -203.087 | 353.221 | 641.750 | 1214.750 |
| 123 | late-arrivals | 90 | 90 | 0 | 445.978 | -427.011 | 724.482 | 1327.000 | 1884.750 |
| 123 | missing-entry-and-junction | 70 | 110 | 0 | 52.046 | -24.218 | 66.447 | 96.000 | 228.750 |

## Seed 42 as observations arrive

| Case | Decision time (s) | Forecasts | Already at gate | MAE | Bias | RMSE | P90 absolute |
| --- | --- | --- | --- | --- | --- | --- | --- |
| normal | 0 | 55 | 125 | 41.841 | -16.677 | 63.612 | 90.000 |
| normal | 300 | 4 | 176 | 87.188 | -87.187 | 107.057 | 178.000 |
| normal | 600 | 0 | 180 | n/a | n/a | n/a | n/a |
| security-delays | 0 | 87 | 93 | 228.632 | -214.213 | 333.718 | 613.750 |
| security-delays | 300 | 51 | 129 | 163.662 | -138.377 | 221.856 | 352.750 |
| security-delays | 600 | 34 | 146 | 63.632 | -38.559 | 91.046 | 112.750 |
| late-arrivals | 0 | 84 | 96 | 442.949 | -427.693 | 697.986 | 1281.000 |
| late-arrivals | 300 | 37 | 143 | 695.426 | -695.426 | 794.605 | 1311.000 |
| late-arrivals | 600 | 32 | 148 | 484.906 | -484.656 | 587.791 | 1011.000 |
| missing-entry-and-junction | 0 | 55 | 125 | 49.591 | -17.818 | 68.502 | 90.750 |
| missing-entry-and-junction | 300 | 4 | 176 | 99.688 | -99.687 | 114.477 | 178.000 |
| missing-entry-and-junction | 600 | 0 | 180 | n/a | n/a | n/a | n/a |

The missing-entry-and-junction case removes every `SECURITY_ENTERED` and intermediate `CHECKPOINT` observation from the normal scenario while keeping all actual timestamps and truth fixed. It is an evaluation variant, not a new named generator scenario. Explicit check-in, security clearance and gate observations remain.

Normal seed 42 opening-time MAE is 41.841 seconds. Hidden security delays increase it to 228.632 seconds, with an early bias of -214.213 seconds. Hidden late stops produce MAE 442.949 seconds and RMSE 697.986 seconds. These are material prediction failures retained in the report. The estimator never receives those future delays; this stage does not tune an optimizer or claim that rolling an overdue ETA makes it accurate.

At t=300 in the late-arrival case, MAE is worse (695.426 seconds) because a different, smaller cohort of mostly delayed passengers remains. These snapshots are not a longitudinal score on a fixed cohort. At t=600 in normal and missing-scan seed 42, everyone is observed at the gate; errors are n/a (JSON null), not zero.

The deterministic six-passenger analytical fixture has forecast 496.25 seconds versus actual 500 seconds at t=0, so MAE/RMSE/p90/max are 3.75 seconds and bias is -3.75. Missing required check-in/security-clearance/gate observations leave readiness false even after actual arrival and produce an explicit timeout in simulation tests. This prevents both premature boarding and fabricated perfect forecasts.

The terminal audit retains six checkpoints, seven edges (six accessible, one excluded shortcut), assigned `GATE_B`, and accessible checkpoint-to-gate distances 540/420/420/240/220/0 metres. Every distance and accessibility label is a model assumption. Official Pearson sources support only qualitative layout context; see [the source boundary and six-item audit](STAGE4_AUDIT.md). No map artwork is copied.

## Reproduction and artifacts

Use the README Stage 4 commands for normal/security-delay saved scenarios, readiness, terminal routes and CLI evaluation. For the remaining generator case use `--scenario late-arrivals`; for seeds 7 and 123 change `--seed`. The audit includes the observation-filter recipe used for the missing-scan case.

`results/stage4/eta-suite.json` and `eta-summary.csv` contain all 36 cohort summaries. Each `results/stage4/<case>/seed-<seed>/` contains its one manifest, readiness-at-zero snapshot and per-passenger evaluation JSON/CSV; the route audit is `results/stage4/terminal-audit.json`. These generated files are Git-ignored.
