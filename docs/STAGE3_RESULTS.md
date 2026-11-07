# Stage 3 synthetic baseline comparison

Seeds: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 42. 33 identical-input comparisons; 99 simulation runs.

- Generate once per case/seed; freeze and reuse the same full manifest for all three strategies. No adaptive runs.
- Across cases for a given seed, passenger profiles stay fixed; only arrival/clearance timelines and their generation settings change.
- Across seeds, both passenger composition and the boarding lottery change. SD is sample SD across these synthetic flights, not an operational confidence interval.
- Gate wait includes time before opening. Aisle blocking is summed passenger-minutes; these are not additive elapsed-time components.
- Baggage-aware Phase 1 ranks sampled stow work as known synthetic input, an idealized information assumption.
- No failed runs are dropped. No airport distances, measured performance or optimality claims.

Times below are seconds; blocking is passenger-minutes. Entries show mean ± sample SD [min, max].

| Case | Strategy | Completion | Mean gate wait | Aisle blocking | Violations (sum) |
| --- | --- | --- | --- | --- | --- |
| normal | random | 1548.91 ± 119.63 [1400.00, 1796.00] | 1272.24 ± 109.47 [1129.31, 1533.41] | 149.47 ± 20.38 [102.82, 179.73] | 0 |
| normal | zone | 1780.55 ± 102.68 [1644.00, 1974.00] | 1339.97 ± 93.39 [1202.94, 1557.64] | 261.74 ± 27.22 [222.63, 309.83] | 0 |
| normal | baggage-aware | 1464.18 ± 120.42 [1320.00, 1761.00] | 1274.88 ± 114.06 [1130.08, 1551.07] | 147.05 ± 14.70 [127.42, 173.90] | 0 |
| all-at-gate | random | 1551.55 ± 116.96 [1403.00, 1796.00] | 906.57 ± 87.19 [799.66, 1126.38] | 149.64 ± 20.41 [102.82, 179.80] | 0 |
| all-at-gate | zone | 1782.64 ± 99.81 [1653.00, 1974.00] | 973.69 ± 72.54 [885.81, 1150.62] | 262.27 ± 27.36 [222.63, 309.83] | 0 |
| all-at-gate | baggage-aware | 1469.18 ± 115.07 [1335.00, 1761.00] | 910.91 ± 90.75 [806.47, 1144.05] | 147.84 ± 15.06 [127.42, 173.90] | 0 |
| late-arrivals | random | 1999.45 ± 209.09 [1435.00, 2240.00] | 1406.73 ± 158.74 [1098.97, 1605.69] | 141.17 ± 18.73 [101.45, 172.55] | 0 |
| late-arrivals | zone | 2241.36 ± 144.82 [1997.00, 2504.00] | 1477.94 ± 122.10 [1325.69, 1673.17] | 246.50 ± 28.53 [212.75, 302.13] | 0 |
| late-arrivals | baggage-aware | 1911.18 ± 178.28 [1451.00, 2076.00] | 1407.31 ± 154.19 [1112.50, 1623.36] | 138.65 ± 13.16 [114.37, 161.15] | 0 |

Paired completion comparisons against random (positive delta is slower):

| Case | Strategy | Wins/ties/losses | Mean delta (s) | Slower seeds (delta s) |
| --- | --- | --- | --- | --- |
| normal | zone | 0/0/11 | 231.64 | 0 (+286), 1 (+262), 2 (+181), 3 (+178), 4 (+263), 5 (+307), 6 (+264), 7 (+244), 8 (+133), 9 (+258), 42 (+172) |
| normal | baggage-aware | 9/0/2 | -84.73 | 1 (+40), 9 (+40) |
| all-at-gate | zone | 0/0/11 | 231.09 | 0 (+286), 1 (+262), 2 (+181), 3 (+178), 4 (+263), 5 (+280), 6 (+264), 7 (+265), 8 (+133), 9 (+258), 42 (+172) |
| all-at-gate | baggage-aware | 9/0/2 | -82.36 | 1 (+40), 9 (+40) |
| late-arrivals | zone | 0/0/11 | 241.91 | 0 (+209), 1 (+217), 2 (+177), 3 (+138), 4 (+186), 5 (+307), 6 (+264), 7 (+244), 8 (+146), 9 (+562), 42 (+211) |
| late-arrivals | baggage-aware | 9/0/2 | -88.27 | 1 (+24), 9 (+16) |

## Seed 42 measurements

| Case | Strategy | Completion (s) | Mean gate wait (s) | Blocking (person-min) | Violations |
| --- | --- | --- | --- | --- | --- |
| normal | random | 1624 | 1233.07 | 179.73 | 0 |
| normal | zone | 1796 | 1275.32 | 258.67 | 0 |
| normal | baggage-aware | 1426 | 1223.06 | 172.47 | 0 |
| all-at-gate | random | 1625 | 889.73 | 179.80 | 0 |
| all-at-gate | zone | 1797 | 931.98 | 258.73 | 0 |
| all-at-gate | baggage-aware | 1427 | 879.72 | 172.53 | 0 |
| late-arrivals | random | 2093 | 1403.16 | 168.02 | 0 |
| late-arrivals | zone | 2304 | 1467.61 | 264.03 | 0 |
| late-arrivals | baggage-aware | 1895 | 1392.46 | 161.15 | 0 |

## Interpretation and counterexamples

Baggage-aware finishes faster than random on average in each case, with 9 wins and 2 losses out of 11. It loses in seeds 1 and 9 in every case. In normal seed 1 it takes 1526 seconds versus random 1486; mean gate waiting is 1361.43 versus 1339.94 seconds, and aisle blocking is 127.42 versus 102.82 passenger-minutes. That run underperforms on all three measured costs.

Even across all normal seeds, baggage-aware mean gate waiting is 1274.88 seconds versus random 1272.24. Its lower mean completion time therefore does not establish a better experience for every passenger or superiority on every metric. Normal seed 0 also illustrates the tradeoff: baggage-aware completes in 1514 versus random 1607 seconds, but has more blocking (173.90 versus 156.45 passenger-minutes) and more mean gate waiting (1232.60 versus 1226.14 seconds).

Zone is slower than random in all 33 tested comparisons under this strict rear-first policy and common synthetic assumptions. This observation cannot be generalized to other policies, real airlines or terminal operating conditions.

All 99 runs seat exactly 180 passengers once, respect actual arrivals and protected arrangements, and have zero reported constraint violations. All paired results, including losses, are retained. Per-run manifest/profile/arrival/simulation hashes and unrounded metrics are in `results/stage3/benchmark.json` and `runs.csv`; `results/stage3/report.md` lists every run.

## Actual verification

- Environment: Node.js 24.19.0, Windows; no external packages.
- Isolated Stage 3 tree: `node --test test/stage3.test.js` passes 17/17; `node --test` passes 72/72 (55 existing plus 17 standalone baseline tests), with no failures or skipped tests.
- Complete local workspace: `node --test` passes 94/94, zero failed, skipped or cancelled. Its 22 additional Phase 2 tests/integration checks remain local and are excluded from this isolated commit.
- Default `baselines` command: 33 identical-input comparisons / 99 runs pass, zero violations.
- Existing Phase 1 seed-42 completion regressions remain 1624 / 1796 / 1426 seconds. Existing Phase 2 readiness, adaptive, scenario, no-future-truth and CLI tests all pass.

This is a synthetic Phase 1 baseline benchmark, not a new adaptive or security-model experiment. The full method, information-basis limitation, file changes and six-item completion checklist are in [STAGE3_AUDIT.md](STAGE3_AUDIT.md). To reproduce:

```powershell
node src/cli.js baselines --seeds 0,1,2,3,4,5,6,7,8,9,42 --output results/stage3
node --test
```
