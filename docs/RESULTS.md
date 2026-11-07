# Measured Phase 1 results

Run on November 7, 2026, using Node.js 24.19.0:

```powershell
node src/cli.js demo --seed 42 --output results --trace
```

Input fingerprint for all strategies:

```text
1970236f8c08e6aa1c59b5d03f67d3b7c6e9f69043f5539fb526c65fca425d5a
```

The single synthetic flight contains 180 passengers and unique seats, 48 multi-person parties and 57 solo passengers, 113 overhead pieces, and 18 arrivals after opening. There are 21 individual priority entitlements, five mandatory preboarding passengers, and three assistance requests. Party promotion produces 12 preboarding, 33 priority-stage and 135 general-stage admissions.

| Metric | Random | Zone | Baggage-aware |
| --- | ---: | ---: | ---: |
| Completion, seconds | 1624 | 1796 | 1426 |
| Completion, m:ss | 27:04 | 29:56 | 23:46 |
| Mean gate wait, seconds | 1233.066667 | 1275.316667 | 1223.055556 |
| Total gate wait, passenger-seconds | 221952 | 229557 | 220150 |
| Maximum gate wait, seconds | 2304 | 2552 | 2166 |
| Aisle blocking, passenger-seconds | 10784 | 15520 | 10348 |
| Mean aisle blocking, seconds | 59.911111 | 86.222222 | 57.488889 |
| Gate entrance blocked, elapsed seconds | 850 | 1103 | 726 |
| Row services, passenger-seconds | 3080 | 3080 | 2800 |
| Stowing, passenger-seconds | 1783 | 1783 | 1783 |
| Seat interference, passenger-seconds | 408 | 408 | 128 |
| Seat-blocker interactions | 51 | 51 | 16 |
| Maximum concurrent aisle occupants | 22 | 30 | 25 |
| Seated exactly once | 180 | 180 | 180 |

All runtime invariant audits passed. The identical stowing totals demonstrate shared baggage/service inputs; the strategies differ in overlap, queueing and seat interference. Seat-interference totals happen to match for random and zone in this scenario.

The heuristic finishes 198 seconds (12.2%) ahead of random, and 370 seconds (20.6%) ahead of zones. Its aisle blocking falls by 436 passenger-seconds (4.0%) against random. These are single-scenario measurements, not evidence that it always wins or that the parameters match real airport operations. Gate waiting includes pre-opening time, and passenger-time aggregates can exceed the flight's elapsed duration.

## Inspect the generated evidence

- `results/manifest.json`: complete synthetic inputs and configuration.
- `results/passengers.csv`: flat passenger records, with relative and UTC timestamps.
- `results/comparison.json` and `.csv`: all metrics and input fingerprints.
- `results/timings-<strategy>.json` and `.csv`: individual passenger outcomes and audits.
- `results/events-<strategy>.json`: input fingerprint and chronological movement/service events.
- `results/report.txt`: compact result table.
- `results/test-results.txt`: captured final test output, when generated during verification.

Run `node --test` to verify the implementation. Run `demo` again to reproduce the table. A separate CLI test regenerates all default artifacts twice and compares their bytes.
