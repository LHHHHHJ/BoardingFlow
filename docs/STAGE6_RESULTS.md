# Stage 6 verification and actual results

Measured on Node.js 24.19.0 on Windows. All manifests, staff confirmations, journey times and route lengths are **SYNTHETIC**. The selected policy is `BF-SWISS-INSPIRED-V1`, a simplified research policy rather than a complete implementation of SWISS operations. Method, policy/WilMA rules, six-item checklist, file changes and limitations are in [STAGE6_AUDIT.md](STAGE6_AUDIT.md).

Release isolation check: the full local workspace passes **170/170**, while the isolated release passes **157/157** (128 previously committed tests plus 29 new Stage 6 tests). The remaining 13 local Phase 2 tests are outside this release; no committed tests are removed. Necessary legacy-controller/configuration dependencies are included. The release retains the original `compare`/`baselines` defaults and exposes five strategies through `compare-all`/`stage6`. See the audit's release section for the preserved local-work boundary.

## Verification

| Check | Actual result |
| --- | --- |
| Complete workspace suite, `node --test` | **170/170 passed**, 0 failed, skipped, cancelled or todo; includes all 141 existing tests and 29 new Stage 6 tests |
| Fixed Stage 6 experiment | **165 runs**: 11 seeds x 3 scenarios x 5 independent strategies; all 180 passengers seated in every run |
| Constraint enforcement | **0 violations** across all 165 runs, independently counted from passenger timings; focused full trace tests cover all five strategies |
| Before snapshot replay | **33/33 complete legacy Adaptive payloads match** the preserved pre-change JSON; original Random/Zone/Baggage-Aware metrics also match in all 33 scenarios |
| Repeat run | All 165 strategy outcomes and summary statistics exactly match the first validated v2 run; no score tuning between runs |
| Stage 3 compatibility | All **99 historical baseline runs, metrics and fingerprints** reproduce the saved Stage 3 report |
| Stage 4 compatibility | All **12 ETA reports** reproduce the saved Stage 4 outputs |
| Information boundary | Hidden-truth throwing getters, future-event perturbations, staff confirmation changes, expected-versus-actual service and earlier movement/decision-prefix tests pass |
| Local-work preservation | SHA-256 comparison of 53 pre-existing source/config/test/document files finds no deletions and only the seven intended shared-file edits; original adaptive source, prior tests and unrelated documents remain unchanged |

The final suite was run with:

```powershell
node --test
node src/cli.js stage6 --before-dir results/stage6/before --adaptive-config config/stage6.example.json --output results/stage6/after
```

The before directory contains original source copies/hashes, 33 frozen manifests, 33 full legacy Adaptive results and 132 original four-strategy metrics runs. It is protected from output overwrite. The original `src/adaptive.js` SHA-256 is unchanged: `01876a557f2a73e5e386ab57aaaf6cfccff9f010a304e2ff218fed044f1685a0`. Generated artifacts remain Git-ignored. No commit or push was made.

To reproduce on a fresh checkout without this workspace's generated snapshot, omit `--before-dir`. The deterministic fixture recipe and retained `legacy-v1` controller regenerate the paired comparison. For one frozen input and optional replayable aircraft traces:

```powershell
node src/cli.js compare-all --input results/stage6/after/normal/seed-42/manifest.json --output results/stage6/single --trace
node src/cli.js simulate --input results/stage6/after/normal/seed-42/manifest.json --strategy adaptive --adaptive-version legacy-v1 --output results/stage6/legacy-replay
```

## Investigation of the old seed-42 normal result

The preserved original policy-enabled results are Random 1557 seconds, Zone 1715, Baggage-Aware 1389 and Adaptive 1788. These differ from legacy-policy Stage 3 flights and must remain separately labeled. Every strategy uses the same policy-enabled manifest, not a newly favorable arrival draw.

PREBOARD comprises 18 passengers: first entry 0, last entry 271, last seated 368 seconds. PRIORITY comprises 41: first entry 368, last entry 695, last seated 760. These protected timings are identical before/after and across the seed-42 normal strategies. GENERAL has 121 passengers and begins at 697 seconds.

| General boarding diagnostic | Random | Baggage-Aware | Original Adaptive | Revised Adaptive |
| --- | ---: | ---: | ---: | ---: |
| Last entry (seconds) | 1418 | 1313 | 1476 | 1221 |
| Last seated (seconds) | 1557 | 1389 | 1788 | 1306 |
| Aisle blocking (passenger-seconds) | 9940 | 7064 | 11200 | 5412 |
| Seat interference (passenger-seconds) | 312 | 144 | 144 | 144 |

The old score charged the full expected service of relevant visible occupants, without subtracting elapsed observed row service or allowing overlapping rows in its congestion proxy. It also produced a poor admission/tail order in this scenario. The revised analytical cost accounts for expected remaining service, path overlap, induced blocking, seat access and baggage work; it never reads actual scheduled service ends. These observations support the change but do not establish each score term's individual causal effect: no ablation/search experiment was performed.

The investigation covered waiting, release intervals, ETA, aisle/seat effects, policy and group barriers, and fallback:

- There were **no `BETTER_FIT_EXPECTED_SOON` anticipation waits** in the original normal seed-42 run. Delaying a ready group for a supposedly better ETA does not explain that loss.
- The old `ALL_STAGE_UNITS_CALLED` WAIT review spans sum to 305 seconds, but these represent **cabin drain after admission**, not an intentional gate hold. Last-entry-to-completion falls from 312 to 85 seconds after the change.
- Assistance-related WAIT review spans total 39 seconds in the old trace. Five old staff-confirmation-pending policy checks were safely handled. Revised protected timings remain identical; their barriers were not removed to obtain the improvement.
- The family/party and escort constraints are identical. Seat interference is also identical between old/new Adaptive and Baggage-Aware. The completion improvement therefore is not obtained by relaxing group rights or eliminating interference physics.
- The new general controller is work conserving among confirmed-ready feasible groups. An occupied entrance causes a next-tick review, and staff/observed cabin changes trigger reoptimization. It does not speculate on a future arrival to release a group.
- The old security-delay and late-arrival cases have 436 and 967 seconds of `NO_READY_ELIGIBLE_UNIT` review spans respectively. These are diagnostic spans, not exclusive time accounting. Required protected-stage/whole-group readiness legitimately holds the flight; the optimizer cannot waive those rights.

ETA error remains substantial, as shown by the unchanged Stage 4 forecast evaluator at decision time zero for seed 42. Already-observed gate passengers are excluded from this error cohort:

| Case | Predicted cohort | Observed at gate | Mean absolute error (s) | Mean signed error (s) | Maximum absolute error (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Normal | 55 | 125 | 41.841 | -16.677 | 267.750 |
| Security delays | 87 | 93 | 228.632 | -214.213 | 981.750 |
| Late arrivals | 84 | 96 | 442.949 | -427.693 | 1653.000 |

Signed error is prediction minus actual, so negative is optimistic. Missing knowledge of extra screening/stops is not repaired using future truth. The new 30-second base/age/overdue uncertainty margin is an uncalibrated planning proxy and does not claim coverage of these errors. Plans cannot authorize clearance, gate presence or staff approval.

## Seed-42 normal before/after and five-strategy metrics

| Strategy | Completion (s) | Mean gate wait (s) | Aisle blocking (person-min) | Seat interference (s / blocker events) | Violations |
| --- | ---: | ---: | ---: | ---: | ---: |
| Random | 1557 | 1024.40 | 196.33 | 328 / 41 | 0 |
| Traditional Zone | 1715 | 1087.69 | 276.75 | 328 / 41 | 0 |
| Baggage-Aware | 1389 | 995.02 | 148.40 | 160 / 20 | 0 |
| WilMA | 1487 | 997.76 | 170.10 | 160 / 20 | 0 |
| Original Adaptive (`legacy-v1`) | 1788 | 1023.84 | 217.33 | 160 / 20 | 0 |
| Revised Adaptive (`passenger-aware-v2`) | **1306** | **939.14** | **120.87** | 160 / 20 | 0 |

Revised Adaptive completes 482 seconds (26.96%) earlier than the preserved old controller in this one case. Its seed-42 security-delay result changes from 2168 to 1772 seconds and late-arrival result from 2610 to 2292. The multi-seed mean after-minus-before changes are -460.82, -357.91 and -343.91 seconds for normal, security-delay and late-arrival scenarios respectively. Full paired rows follow below.

`gateEntranceBlockedSeconds` is retained as a diagnostic, but it counts only periods with an already-called active unit waiting at the entrance. The new controller can hold a general group before calling it when the entrance is occupied. This changes that diagnostic's attribution, so its reduction is **not** evidence of an equivalent reduction in physical blocking. Completion, actual gate wait and person-minutes spent blocked in the aircraft remain directly comparable under the shared engine.

## Losses and limits

Adaptive beats Random, Zone and WilMA on completion in all 33 required synthetic cases. It beats Baggage-Aware in 30/33, losing these three:

| Case | Seed | Adaptive completion (s) | Baggage-Aware (s) | Completion delta (s) | Mean-wait delta (s) | Aisle-blocking delta (person-min) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Security delays | 7 | 1667 | 1655 | +12 | -18.91 | -9.60 |
| Late arrivals | 2 | 2343 | 2341 | +2 | -17.81 | -10.78 |
| Late arrivals | 7 | 2673 | 2670 | +3 | -22.87 | +3.08 |

Every delta is Adaptive minus Baggage-Aware; positive is worse. Better average waiting or blocking does not ensure earlier final seating. Seed-42 late arrivals are another tradeoff: Adaptive finishes 47 seconds earlier than Baggage-Aware but has 0.35 more person-minutes of blocking. Late-arrival mean interference is 185.45 seconds for Adaptive versus 184.00 for Baggage-Aware/WilMA. No objective is claimed to improve universally.

WilMA beats Random and Zone on completion in all 33 cases, but loses to Baggage-Aware and Adaptive in all 33. All individual loss seeds and completion deltas appear in the paired table below; none is hidden by aggregation. Required parties relax individual window/middle/aisle ordering, and independent WilMA deliberately lacks baggage/row optimization.

The heuristic is a one-step expected-delay surrogate, not a global optimum. Configuration was fixed before the multi-seed outcome review, without fitting to these seeds. The suite samples only 33 synthetic scenarios; SD across seeds mixes passenger composition and lottery variation. Release intervals are conditional minimum-headway plans, not guaranteed actual entry times. Policy and staff approvals are simulated, and the simplified map is not measured Toronto Pearson geometry. No claim of real-airport performance, universal superiority or calibrated ETA confidence follows from this experiment.

Next recommended step: review and freeze the Stage 6 implementation, policy assumptions and measured report before authorizing the separate Stage 7 experiment expansion. No later-stage work has been started.

## Complete measured comparison export

The following tables are copied from the final CLI-generated `results/stage6/after/report.md`. Unrounded metrics, individual blocker counts, diagnostics, hashes and raw timings remain in `comparison.json`, `runs.csv` and the 33 per-case directories. Aggregate SD is sample SD (n-1). The existing historical Stage 3 and Stage 4 reports are preserved separately.

# Stage 6 policy-enabled five-strategy results

Seeds: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 42. 33 frozen scenarios, 165 strategy runs and 33 paired legacy Adaptive replays.

- Same frozen passenger, actual journey, baggage, policy/staff tape and aircraft input across all five strategies per case/seed.
- Default synthetic fixtures explicitly confirm all requested assistance; First/elite/family arrangements are inherited from the Stage 5 example. These are invented confirmed facts, not demographic inferences.
- Paired deltas are subject minus reference; positive means worse. No failed or losing run is removed.
- Standard deviation is sample SD across 11 synthetic passenger scenarios/lotteries, not a calibrated operational confidence interval.
- Gate wait includes pre-opening wait; blocking is passenger-minutes. Seat interference is passenger-seconds.
- Expected-delay scores and ETA uncertainty are analytical heuristics. Hidden actual arrivals, service times and unobserved locations are excluded.
- Legacy-policy Stage 3 experiments and policy-enabled Stage 6 experiments have different inputs and must be reported separately.
- All recommendations and staff approvals are synthetic/advisory. Distances are invented, not Toronto Pearson measurements.

Mean ± sample SD [min, max]; completion/gate wait/interference in seconds, blocking in passenger-minutes.

| Scenario | Strategy | Completion | Mean gate wait | Blocking | Seat interference | Violations (sum) |
| --- | --- | --- | --- | --- | --- | --- |
| normal | random | 1649.09 ± 110.47 [1508.00, 1866.00] | 1064.03 ± 122.40 [904.39, 1310.37] | 162.13 ± 17.91 [133.78, 196.33] | 421.09 ± 87.73 [312.00, 560.00] | 0 |
| normal | zone | 1852.18 ± 127.41 [1715.00, 2158.00] | 1126.45 ± 109.01 [986.41, 1374.77] | 259.59 ± 21.20 [221.27, 289.67] | 421.09 ± 87.73 [312.00, 560.00] | 0 |
| normal | baggage-aware | 1427.73 ± 158.97 [1211.00, 1793.00] | 1037.97 ± 128.53 [865.01, 1315.06] | 124.01 ± 15.08 [108.23, 148.40] | 181.82 ± 47.21 [96.00, 240.00] | 0 |
| normal | wilma | 1552.00 ± 109.37 [1416.00, 1811.00] | 1057.09 ± 112.56 [922.43, 1290.24] | 150.13 ± 17.26 [114.47, 170.10] | 181.82 ± 47.21 [96.00, 240.00] | 0 |
| normal | adaptive | 1324.64 ± 144.52 [1095.00, 1594.00] | 993.68 ± 123.34 [820.24, 1235.99] | 99.39 ± 16.24 [70.08, 121.48] | 181.82 ± 47.21 [96.00, 240.00] | 0 |
| security-delays | random | 2281.00 ± 253.86 [1906.00, 2722.00] | 1324.88 ± 225.33 [1048.80, 1774.03] | 154.59 ± 22.04 [118.62, 193.28] | 422.55 ± 87.33 [312.00, 560.00] | 0 |
| security-delays | zone | 2462.45 ± 242.68 [2154.00, 2869.00] | 1373.75 ± 218.06 [1148.52, 1808.69] | 247.04 ± 26.03 [201.87, 285.37] | 422.55 ± 87.33 [312.00, 560.00] | 0 |
| security-delays | baggage-aware | 2052.73 ± 250.58 [1655.00, 2549.00] | 1295.47 ± 214.60 [1046.54, 1767.00] | 112.88 ± 18.46 [91.08, 144.33] | 183.27 ± 47.79 [96.00, 240.00] | 0 |
| security-delays | wilma | 2183.09 ± 252.50 [1809.00, 2588.00] | 1318.42 ± 218.81 [1070.70, 1763.23] | 139.44 ± 21.67 [105.03, 168.35] | 183.27 ± 47.79 [96.00, 240.00] | 0 |
| security-delays | adaptive | 1959.91 ± 255.25 [1618.00, 2516.00] | 1255.17 ± 222.77 [1027.64, 1748.45] | 89.61 ± 21.22 [54.43, 124.05] | 183.27 ± 47.79 [96.00, 240.00] | 0 |
| late-arrivals | random | 2589.09 ± 240.95 [2241.00, 2916.00] | 1620.33 ± 237.77 [1322.62, 1979.97] | 154.19 ± 21.40 [121.40, 192.20] | 421.82 ± 87.28 [312.00, 552.00] | 0 |
| late-arrivals | zone | 2763.09 ± 282.98 [2308.00, 3157.00] | 1666.49 ± 253.03 [1376.49, 2061.98] | 243.30 ± 29.71 [199.00, 289.33] | 420.36 ± 86.19 [312.00, 552.00] | 0 |
| late-arrivals | baggage-aware | 2367.18 ± 228.52 [2071.00, 2792.00] | 1593.54 ± 235.06 [1302.02, 1970.12] | 114.52 ± 15.02 [93.22, 142.52] | 184.00 ± 46.10 [96.00, 240.00] | 0 |
| late-arrivals | wilma | 2493.09 ± 245.65 [2129.00, 2824.00] | 1612.81 ± 236.59 [1320.42, 1998.01] | 141.11 ± 17.57 [112.90, 165.92] | 184.00 ± 46.10 [96.00, 240.00] | 0 |
| late-arrivals | adaptive | 2295.73 ± 223.36 [1972.00, 2673.00] | 1554.00 ± 234.04 [1242.12, 1947.26] | 98.60 ± 20.29 [65.30, 142.87] | 185.45 ± 43.50 [96.00, 240.00] | 0 |

Paired completion wins/ties/losses, with every losing seed:

| Scenario | Subject | Reference | W/T/L | Mean delta (s) | Losing seeds (delta s) |
| --- | --- | --- | --- | --- | --- |
| normal | adaptive | random | 11/0/0 | -324.45 | none |
| normal | adaptive | zone | 11/0/0 | -527.55 | none |
| normal | adaptive | baggage-aware | 11/0/0 | -103.09 | none |
| normal | adaptive | wilma | 11/0/0 | -227.36 | none |
| normal | wilma | random | 11/0/0 | -97.09 | none |
| normal | wilma | zone | 11/0/0 | -300.18 | none |
| normal | wilma | baggage-aware | 0/0/11 | 124.27 | 0 (+162), 1 (+56), 2 (+150), 3 (+18), 4 (+116), 5 (+67), 6 (+271), 7 (+154), 8 (+39), 9 (+236), 42 (+98) |
| normal | wilma | adaptive | 0/0/11 | 227.36 | 0 (+294), 1 (+207), 2 (+167), 3 (+217), 4 (+227), 5 (+216), 6 (+387), 7 (+231), 8 (+68), 9 (+306), 42 (+181) |
| security-delays | adaptive | random | 11/0/0 | -321.09 | none |
| security-delays | adaptive | zone | 11/0/0 | -502.55 | none |
| security-delays | adaptive | baggage-aware | 10/0/1 | -92.82 | 7 (+12) |
| security-delays | adaptive | wilma | 11/0/0 | -223.18 | none |
| security-delays | wilma | random | 11/0/0 | -97.91 | none |
| security-delays | wilma | zone | 11/0/0 | -279.36 | none |
| security-delays | wilma | baggage-aware | 0/0/11 | 130.36 | 0 (+151), 1 (+56), 2 (+147), 3 (+74), 4 (+146), 5 (+56), 6 (+267), 7 (+154), 8 (+39), 9 (+236), 42 (+108) |
| security-delays | wilma | adaptive | 0/0/11 | 223.18 | 0 (+300), 1 (+235), 2 (+180), 3 (+249), 4 (+255), 5 (+165), 6 (+351), 7 (+142), 8 (+72), 9 (+324), 42 (+182) |
| late-arrivals | adaptive | random | 11/0/0 | -293.36 | none |
| late-arrivals | adaptive | zone | 11/0/0 | -467.36 | none |
| late-arrivals | adaptive | baggage-aware | 9/0/2 | -71.45 | 2 (+2), 7 (+3) |
| late-arrivals | adaptive | wilma | 11/0/0 | -197.36 | none |
| late-arrivals | wilma | random | 11/0/0 | -96.00 | none |
| late-arrivals | wilma | zone | 11/0/0 | -270.00 | none |
| late-arrivals | wilma | baggage-aware | 0/0/11 | 125.91 | 0 (+134), 1 (+56), 2 (+147), 3 (+18), 4 (+159), 5 (+58), 6 (+271), 7 (+154), 8 (+46), 9 (+236), 42 (+106) |
| late-arrivals | wilma | adaptive | 0/0/11 | 197.36 | 0 (+252), 1 (+172), 2 (+145), 3 (+253), 4 (+237), 5 (+134), 6 (+283), 7 (+151), 8 (+114), 9 (+277), 42 (+153) |

Adaptive before/after on identical inputs:

| Scenario | Seed | Before (s) | After (s) | Delta (s) |
| --- | --- | --- | --- | --- |
| normal | 0 | 1760 | 1302 | -458 |
| normal | 1 | 1880 | 1379 | -501 |
| normal | 2 | 1765 | 1357 | -408 |
| normal | 3 | 2143 | 1594 | -549 |
| normal | 4 | 1741 | 1344 | -397 |
| normal | 5 | 1523 | 1203 | -320 |
| normal | 6 | 1736 | 1095 | -641 |
| normal | 7 | 1718 | 1185 | -533 |
| normal | 8 | 1819 | 1529 | -290 |
| normal | 9 | 1767 | 1277 | -490 |
| normal | 42 | 1788 | 1306 | -482 |
| security-delays | 0 | 2229 | 1947 | -282 |
| security-delays | 1 | 2003 | 1618 | -385 |
| security-delays | 2 | 2238 | 1913 | -325 |
| security-delays | 3 | 2347 | 1911 | -436 |
| security-delays | 4 | 2153 | 1894 | -259 |
| security-delays | 5 | 2469 | 2173 | -296 |
| security-delays | 6 | 2670 | 2183 | -487 |
| security-delays | 7 | 2044 | 1667 | -377 |
| security-delays | 8 | 2739 | 2516 | -223 |
| security-delays | 9 | 2436 | 1965 | -471 |
| security-delays | 42 | 2168 | 1772 | -396 |
| late-arrivals | 0 | 2224 | 1972 | -252 |
| late-arrivals | 1 | 2804 | 2319 | -485 |
| late-arrivals | 2 | 2662 | 2343 | -319 |
| late-arrivals | 3 | 2986 | 2557 | -429 |
| late-arrivals | 4 | 2763 | 2320 | -443 |
| late-arrivals | 5 | 2195 | 1995 | -200 |
| late-arrivals | 6 | 2813 | 2429 | -384 |
| late-arrivals | 7 | 2940 | 2673 | -267 |
| late-arrivals | 8 | 2307 | 2029 | -278 |
| late-arrivals | 9 | 2732 | 2324 | -408 |
| late-arrivals | 42 | 2610 | 2292 | -318 |

Every individual strategy result (unrounded JSON/CSV retained):

| Scenario | Seed | Strategy | Completion (s) | Mean wait (s) | Blocking (person-min) | Interference (s) | Violations |
| --- | --- | --- | --- | --- | --- | --- | --- |
| normal | 0 | random | 1648 | 1085.47 | 150.08 | 560 | 0 |
| normal | 0 | zone | 1876 | 1157.29 | 252.90 | 560 | 0 |
| normal | 0 | baggage-aware | 1434 | 1034.04 | 117.87 | 208 | 0 |
| normal | 0 | wilma | 1596 | 1091.43 | 138.22 | 208 | 0 |
| normal | 0 | adaptive | 1302 | 1009.06 | 86.78 | 208 | 0 |
| normal | 1 | random | 1744 | 1145.53 | 133.78 | 312 | 0 |
| normal | 1 | zone | 1922 | 1188.59 | 236.60 | 312 | 0 |
| normal | 1 | baggage-aware | 1530 | 1133.94 | 111.82 | 96 | 0 |
| normal | 1 | wilma | 1586 | 1132.84 | 114.47 | 96 | 0 |
| normal | 1 | adaptive | 1379 | 1072.01 | 95.27 | 96 | 0 |
| normal | 2 | random | 1632 | 1022.91 | 142.13 | 456 | 0 |
| normal | 2 | zone | 1771 | 1062.33 | 221.27 | 456 | 0 |
| normal | 2 | baggage-aware | 1374 | 1005.74 | 108.23 | 184 | 0 |
| normal | 2 | wilma | 1524 | 1021.04 | 140.83 | 184 | 0 |
| normal | 2 | adaptive | 1357 | 965.68 | 97.80 | 184 | 0 |
| normal | 3 | random | 1866 | 1310.37 | 153.48 | 392 | 0 |
| normal | 3 | zone | 2158 | 1374.77 | 259.10 | 392 | 0 |
| normal | 3 | baggage-aware | 1793 | 1315.06 | 134.35 | 192 | 0 |
| normal | 3 | wilma | 1811 | 1290.24 | 137.80 | 192 | 0 |
| normal | 3 | adaptive | 1594 | 1235.99 | 91.80 | 192 | 0 |
| normal | 4 | random | 1698 | 1129.87 | 183.77 | 504 | 0 |
| normal | 4 | zone | 1972 | 1199.48 | 276.08 | 504 | 0 |
| normal | 4 | baggage-aware | 1455 | 1099.77 | 140.32 | 224 | 0 |
| normal | 4 | wilma | 1571 | 1120.80 | 162.17 | 224 | 0 |
| normal | 4 | adaptive | 1344 | 1059.83 | 119.53 | 224 | 0 |
| normal | 5 | random | 1515 | 906.71 | 169.45 | 336 | 0 |
| normal | 5 | zone | 1776 | 1017.98 | 271.38 | 336 | 0 |
| normal | 5 | baggage-aware | 1352 | 921.39 | 124.80 | 96 | 0 |
| normal | 5 | wilma | 1419 | 925.09 | 153.00 | 96 | 0 |
| normal | 5 | adaptive | 1203 | 862.66 | 103.72 | 96 | 0 |
| normal | 6 | random | 1555 | 932.61 | 160.82 | 552 | 0 |
| normal | 6 | zone | 1821 | 1038.49 | 289.67 | 552 | 0 |
| normal | 6 | baggage-aware | 1211 | 865.01 | 111.13 | 240 | 0 |
| normal | 6 | wilma | 1482 | 929.89 | 164.85 | 240 | 0 |
| normal | 6 | adaptive | 1095 | 820.24 | 70.08 | 240 | 0 |
| normal | 7 | random | 1508 | 904.39 | 168.33 | 416 | 0 |
| normal | 7 | zone | 1734 | 986.41 | 275.87 | 416 | 0 |
| normal | 7 | baggage-aware | 1262 | 894.55 | 111.12 | 200 | 0 |
| normal | 7 | wilma | 1416 | 922.43 | 140.25 | 200 | 0 |
| normal | 7 | adaptive | 1185 | 860.02 | 99.57 | 200 | 0 |
| normal | 8 | random | 1731 | 1135.71 | 157.60 | 360 | 0 |
| normal | 8 | zone | 1818 | 1170.37 | 235.60 | 360 | 0 |
| normal | 8 | baggage-aware | 1558 | 1128.68 | 143.97 | 208 | 0 |
| normal | 8 | wilma | 1597 | 1124.91 | 161.43 | 208 | 0 |
| normal | 8 | adaptive | 1529 | 1111.13 | 121.48 | 208 | 0 |
| normal | 9 | random | 1686 | 1106.31 | 167.70 | 416 | 0 |
| normal | 9 | zone | 1811 | 1107.56 | 260.32 | 416 | 0 |
| normal | 9 | baggage-aware | 1347 | 1024.49 | 112.12 | 192 | 0 |
| normal | 9 | wilma | 1583 | 1071.53 | 168.35 | 192 | 0 |
| normal | 9 | adaptive | 1277 | 994.73 | 86.38 | 192 | 0 |
| normal | 42 | random | 1557 | 1024.40 | 196.33 | 328 | 0 |
| normal | 42 | zone | 1715 | 1087.69 | 276.75 | 328 | 0 |
| normal | 42 | baggage-aware | 1389 | 995.02 | 148.40 | 160 | 0 |
| normal | 42 | wilma | 1487 | 997.76 | 170.10 | 160 | 0 |
| normal | 42 | adaptive | 1306 | 939.14 | 120.87 | 160 | 0 |
| security-delays | 0 | random | 2298 | 1242.77 | 118.62 | 560 | 0 |
| security-delays | 0 | zone | 2494 | 1295.31 | 209.42 | 560 | 0 |
| security-delays | 0 | baggage-aware | 2096 | 1196.35 | 91.08 | 208 | 0 |
| security-delays | 0 | wilma | 2247 | 1249.44 | 105.03 | 208 | 0 |
| security-delays | 0 | adaptive | 1947 | 1153.09 | 54.43 | 208 | 0 |
| security-delays | 1 | random | 2013 | 1160.99 | 140.88 | 312 | 0 |
| security-delays | 1 | zone | 2208 | 1206.87 | 245.48 | 312 | 0 |
| security-delays | 1 | baggage-aware | 1797 | 1147.24 | 115.18 | 96 | 0 |
| security-delays | 1 | wilma | 1853 | 1146.14 | 118.65 | 96 | 0 |
| security-delays | 1 | adaptive | 1618 | 1071.41 | 84.53 | 96 | 0 |
| security-delays | 2 | random | 2202 | 1225.14 | 129.77 | 456 | 0 |
| security-delays | 2 | zone | 2323 | 1255.17 | 201.87 | 456 | 0 |
| security-delays | 2 | baggage-aware | 1946 | 1209.27 | 96.30 | 184 | 0 |
| security-delays | 2 | wilma | 2093 | 1222.77 | 128.13 | 184 | 0 |
| security-delays | 2 | adaptive | 1913 | 1164.83 | 95.07 | 184 | 0 |
| security-delays | 3 | random | 2184 | 1139.26 | 132.03 | 408 | 0 |
| security-delays | 3 | zone | 2479 | 1197.96 | 254.47 | 408 | 0 |
| security-delays | 3 | baggage-aware | 2086 | 1129.99 | 109.47 | 208 | 0 |
| security-delays | 3 | wilma | 2160 | 1136.57 | 118.32 | 208 | 0 |
| security-delays | 3 | adaptive | 1911 | 1078.63 | 65.93 | 208 | 0 |
| security-delays | 4 | random | 2277 | 1348.91 | 172.48 | 504 | 0 |
| security-delays | 4 | zone | 2434 | 1349.26 | 245.90 | 504 | 0 |
| security-delays | 4 | baggage-aware | 2003 | 1300.71 | 125.97 | 224 | 0 |
| security-delays | 4 | wilma | 2149 | 1338.79 | 145.20 | 224 | 0 |
| security-delays | 4 | adaptive | 1894 | 1256.05 | 100.13 | 224 | 0 |
| security-delays | 5 | random | 2469 | 1281.64 | 160.08 | 336 | 0 |
| security-delays | 5 | zone | 2636 | 1338.05 | 233.88 | 336 | 0 |
| security-delays | 5 | baggage-aware | 2282 | 1282.29 | 94.87 | 96 | 0 |
| security-delays | 5 | wilma | 2338 | 1281.96 | 127.57 | 96 | 0 |
| security-delays | 5 | adaptive | 2173 | 1238.51 | 78.50 | 96 | 0 |
| security-delays | 6 | random | 2607 | 1569.88 | 159.25 | 552 | 0 |
| security-delays | 6 | zone | 2869 | 1673.73 | 285.37 | 552 | 0 |
| security-delays | 6 | baggage-aware | 2267 | 1504.97 | 99.75 | 240 | 0 |
| security-delays | 6 | wilma | 2534 | 1567.12 | 162.72 | 240 | 0 |
| security-delays | 6 | adaptive | 2183 | 1473.54 | 73.42 | 240 | 0 |
| security-delays | 7 | random | 1906 | 1048.80 | 168.80 | 416 | 0 |
| security-delays | 7 | zone | 2154 | 1148.52 | 274.45 | 416 | 0 |
| security-delays | 7 | baggage-aware | 1655 | 1046.54 | 108.63 | 200 | 0 |
| security-delays | 7 | wilma | 1809 | 1070.70 | 137.42 | 200 | 0 |
| security-delays | 7 | adaptive | 1667 | 1027.64 | 99.03 | 200 | 0 |
| security-delays | 8 | random | 2722 | 1774.03 | 157.60 | 360 | 0 |
| security-delays | 8 | zone | 2809 | 1808.69 | 235.60 | 360 | 0 |
| security-delays | 8 | baggage-aware | 2549 | 1767.00 | 143.97 | 208 | 0 |
| security-delays | 8 | wilma | 2588 | 1763.23 | 161.43 | 208 | 0 |
| security-delays | 8 | adaptive | 2516 | 1748.45 | 119.18 | 208 | 0 |
| security-delays | 9 | random | 2392 | 1591.78 | 167.70 | 416 | 0 |
| security-delays | 9 | zone | 2517 | 1593.03 | 260.32 | 416 | 0 |
| security-delays | 9 | baggage-aware | 2053 | 1509.96 | 112.12 | 192 | 0 |
| security-delays | 9 | wilma | 2289 | 1557.01 | 168.35 | 192 | 0 |
| security-delays | 9 | adaptive | 1965 | 1479.21 | 91.42 | 192 | 0 |
| security-delays | 42 | random | 2021 | 1190.47 | 193.28 | 328 | 0 |
| security-delays | 42 | zone | 2164 | 1244.63 | 270.73 | 328 | 0 |
| security-delays | 42 | baggage-aware | 1846 | 1155.81 | 144.33 | 160 | 0 |
| security-delays | 42 | wilma | 1954 | 1168.85 | 160.98 | 160 | 0 |
| security-delays | 42 | adaptive | 1772 | 1115.56 | 124.05 | 160 | 0 |
| late-arrivals | 0 | random | 2261 | 1328.80 | 121.40 | 552 | 0 |
| late-arrivals | 0 | zone | 2455 | 1383.12 | 214.63 | 544 | 0 |
| late-arrivals | 0 | baggage-aware | 2090 | 1302.02 | 93.22 | 208 | 0 |
| late-arrivals | 0 | wilma | 2224 | 1341.59 | 112.90 | 208 | 0 |
| late-arrivals | 0 | adaptive | 1972 | 1242.12 | 65.30 | 208 | 0 |
| late-arrivals | 1 | random | 2649 | 1633.23 | 136.55 | 312 | 0 |
| late-arrivals | 1 | zone | 2841 | 1682.57 | 241.52 | 312 | 0 |
| late-arrivals | 1 | baggage-aware | 2435 | 1621.65 | 114.28 | 96 | 0 |
| late-arrivals | 1 | wilma | 2491 | 1620.54 | 116.93 | 96 | 0 |
| late-arrivals | 1 | adaptive | 2319 | 1563.04 | 105.20 | 96 | 0 |
| late-arrivals | 2 | random | 2583 | 1492.69 | 129.95 | 472 | 0 |
| late-arrivals | 2 | zone | 2720 | 1533.04 | 209.68 | 472 | 0 |
| late-arrivals | 2 | baggage-aware | 2341 | 1486.08 | 103.37 | 200 | 0 |
| late-arrivals | 2 | wilma | 2488 | 1499.58 | 135.33 | 200 | 0 |
| late-arrivals | 2 | adaptive | 2343 | 1468.27 | 92.58 | 200 | 0 |
| late-arrivals | 3 | random | 2865 | 1963.27 | 153.48 | 392 | 0 |
| late-arrivals | 3 | zone | 3157 | 2027.67 | 259.10 | 392 | 0 |
| late-arrivals | 3 | baggage-aware | 2792 | 1967.96 | 134.35 | 192 | 0 |
| late-arrivals | 3 | wilma | 2810 | 1943.14 | 137.80 | 192 | 0 |
| late-arrivals | 3 | adaptive | 2557 | 1886.29 | 88.32 | 192 | 0 |
| late-arrivals | 4 | random | 2685 | 1587.87 | 157.57 | 504 | 0 |
| late-arrivals | 4 | zone | 2834 | 1583.56 | 229.03 | 504 | 0 |
| late-arrivals | 4 | baggage-aware | 2398 | 1533.65 | 104.65 | 224 | 0 |
| late-arrivals | 4 | wilma | 2557 | 1577.76 | 130.48 | 224 | 0 |
| late-arrivals | 4 | adaptive | 2320 | 1504.60 | 83.93 | 224 | 0 |
| late-arrivals | 5 | random | 2241 | 1322.62 | 180.75 | 336 | 0 |
| late-arrivals | 5 | zone | 2458 | 1396.64 | 263.03 | 336 | 0 |
| late-arrivals | 5 | baggage-aware | 2071 | 1326.58 | 125.98 | 104 | 0 |
| late-arrivals | 5 | wilma | 2129 | 1320.42 | 150.80 | 104 | 0 |
| late-arrivals | 5 | adaptive | 1995 | 1275.52 | 110.37 | 120 | 0 |
| late-arrivals | 6 | random | 2785 | 1860.89 | 160.48 | 552 | 0 |
| late-arrivals | 6 | zone | 3051 | 1966.78 | 289.33 | 552 | 0 |
| late-arrivals | 6 | baggage-aware | 2441 | 1793.29 | 110.80 | 240 | 0 |
| late-arrivals | 6 | wilma | 2712 | 1858.18 | 164.52 | 240 | 0 |
| late-arrivals | 6 | adaptive | 2429 | 1772.42 | 100.00 | 240 | 0 |
| late-arrivals | 7 | random | 2916 | 1979.97 | 168.33 | 416 | 0 |
| late-arrivals | 7 | zone | 3142 | 2061.98 | 275.87 | 416 | 0 |
| late-arrivals | 7 | baggage-aware | 2670 | 1970.12 | 111.12 | 200 | 0 |
| late-arrivals | 7 | wilma | 2824 | 1998.01 | 140.25 | 200 | 0 |
| late-arrivals | 7 | adaptive | 2673 | 1947.26 | 114.20 | 200 | 0 |
| late-arrivals | 8 | random | 2275 | 1361.09 | 140.00 | 360 | 0 |
| late-arrivals | 8 | zone | 2308 | 1376.49 | 199.00 | 360 | 0 |
| late-arrivals | 8 | baggage-aware | 2097 | 1352.01 | 119.78 | 208 | 0 |
| late-arrivals | 8 | wilma | 2143 | 1351.22 | 139.17 | 208 | 0 |
| late-arrivals | 8 | adaptive | 2029 | 1329.78 | 99.47 | 208 | 0 |
| late-arrivals | 9 | random | 2705 | 1666.55 | 155.37 | 416 | 0 |
| late-arrivals | 9 | zone | 2770 | 1638.19 | 226.97 | 408 | 0 |
| late-arrivals | 9 | baggage-aware | 2365 | 1583.38 | 99.68 | 192 | 0 |
| late-arrivals | 9 | wilma | 2601 | 1630.42 | 158.08 | 192 | 0 |
| late-arrivals | 9 | adaptive | 2324 | 1555.07 | 82.33 | 192 | 0 |
| late-arrivals | 42 | random | 2515 | 1626.64 | 192.20 | 328 | 0 |
| late-arrivals | 42 | zone | 2658 | 1681.30 | 268.15 | 328 | 0 |
| late-arrivals | 42 | baggage-aware | 2339 | 1592.25 | 142.52 | 160 | 0 |
| late-arrivals | 42 | wilma | 2445 | 1600.01 | 165.92 | 160 | 0 |
| late-arrivals | 42 | adaptive | 2292 | 1549.62 | 142.87 | 160 | 0 |
