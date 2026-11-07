# Official reference inspection

Inspected on November 7, 2026, from the public `main` branch of the [official challenge repository](https://github.com/IdeasClinicUWaterloo/F26-Airport-Innovation-Challenge). Inspection was read-only; no official code, data, branch or repository was modified.

The [Group Check-in README](https://github.com/IdeasClinicUWaterloo/F26-Airport-Innovation-Challenge/blob/main/group-check-in-subproblem/README.md) links to the Unified Identity Gateway. The [gateway README](https://github.com/IdeasClinicUWaterloo/F26-Airport-Innovation-Challenge/blob/main/group-check-in-subproblem/unified-identity-gateway/README.md) describes clearance derived from documents, seats, bags and boarding passes.

The [Prisma schema](https://github.com/IdeasClinicUWaterloo/F26-Airport-Innovation-Challenge/blob/main/group-check-in-subproblem/unified-identity-gateway/apps/api/prisma/schema.prisma) provides these relevant structures:

| Official structure | Relevant fields or constraint | BoardingFlow relationship |
| --- | --- | --- |
| Passenger | `id`, `flightId`, `groupId`, `checkInStatus`, `declaredBagCount` | Synthetic ID, flight, travel party and clearance status |
| Seat | `seatNumber`, `cabinZone`, passenger association; seat unique per flight | Full A–F synthetic seat assignment with duplicate rejection |
| Bag | Passenger/flight association, tag, weight, overweight flag | Separate synthetic cabin-baggage allowance and actual load |
| BoardingPass | Passenger, flight, seat, issuance time | No boarding pass or QR implementation in Phase 1 |
| CheckInStatus | `NOT_STARTED`, `IN_PROGRESS`, `CLEARED`, `BLOCKED`, `NEEDS_REVIEW` | Boarding accepts only `CLEARED` |

`cabinZone` describes front/middle/rear location; it is not a boarding entitlement. Boarding zones, priority rights, security clearance and timestamps, estimated gate arrival, assistance, cabin-baggage allowances and processing durations are **BoardingFlow assumptions**, not attributes supplied by that schema. The official bag record does not establish a carry-on allowance.

The [official seed file](https://github.com/IdeasClinicUWaterloo/F26-Airport-Innovation-Challenge/blob/main/group-check-in-subproblem/unified-identity-gateway/apps/api/prisma/seed.ts) demonstrates shared `groupId` values and a sparse seat example. It does not supply a full 180-passenger boarding scenario. BoardingFlow therefore generates its entire manifest independently and uses no seeded passenger identities.

Each manifest carries `dataKind: "SYNTHETIC"`, a provenance statement, seed and complete assumptions. IDs use `SYN-` prefixes. Passport information, names and other identity documents are unnecessary for this simulation and are omitted.
