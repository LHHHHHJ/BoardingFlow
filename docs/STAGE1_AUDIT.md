# Stage 1 audit — Passenger Dataset (180 passengers)

This work inspects and extends the existing Node.js project. It covers only the passenger dataset checklist. Existing core simulation functionality is retained and tested. Previously developed Phase 2 work remains outside this standalone Stage 1 commit; no new boarding/ETA optimization, dashboard or machine learning is part of this change.

## Requirement assessment

| Requirement | Before this audit | Gaps implemented | Current status |
| --- | --- | --- | --- |
| 1. 180 synthetic passengers, 30 × 6 seats, unique IDs/seats | Complete: generator fills A–F for rows 1–30; validator rejects wrong counts and duplicate/out-of-range seats/IDs | Retained; explicit full-grid test added | Complete for the default Stage 1 dataset |
| 2. Zone, priority, class, carry-on, party, assistance, arrival/status information | Partial: all listed information except travel class existed | Added separate `travelClass` label and CSV column | Complete in new schema 2 datasets |
| 3. Count, required-field, unique-seat and reproducible-seed validation | Partial relative to the full checklist: original fields and seeds covered, but no class field/validation | Added class/configuration validation, exhaustive requested-field deletion tests and configurable-mix reproducibility checks | Complete |
| 4. Audit allowance versus actual carry-on; separate class/zone/priority/assistance | Partial: strict allowance checks already existed, but no inspectable audit and class was absent | Added reusable baggage audit, per-passenger evidence and `audit-dataset` CLI; class remains independent | Complete |
| 5. Document synthetic assumptions; configurable mix, carry-on and group sizes | Partial: rates/assumptions documented, priority/assistance/baggage/party probabilities configurable, sizes hardcoded to 2–3 | Added class probabilities, requested party-size bounds, a configuration example and these assumptions | Complete |

No requirement remains missing for newly generated default schema 2 Stage 1 data. Legacy schema 1 files intentionally remain partial against the new class requirement: they are readable/run-compatible but their class is unknown. The audit reports that limitation and does not silently assign labels to old records.

## Field separation and synthetic assumptions

| Field | Meaning |
| --- | --- |
| `travelClass` | Synthetic fare/travel label: `ECONOMY`, `PREMIUM_ECONOMY`, `BUSINESS` |
| `boardingZone` | Seat-location zone: rear 1, middle 2, front 3 |
| `priorityEligible` | Independent priority entitlement |
| `assistance.type` / `companionId` | Assistance request and arranged companion, separate from fare/zone/priority |
| `mandatoryPreboarding` | Existing preboarding requirement, including assistance arrangements |
| `carryOnAllowance` | Allowed overhead/personal-item counts and overhead weight allowance |
| `actualBaggage` | Simulated carried counts and total overhead weight |
| `travelPartyId` | Shared travel-party ID; null for solo passengers |
| Check-in/security fields | Eventual clearance status and clearance timestamps; Phase 2 additionally retains its distinct security-entry scan timestamp |
| `gateArrivalSeconds` | Actual simulated arrival relative to boarding opening; existing Phase 2 predictions remain separate |

All passengers, labels, baggage and times are synthetic. The 30 × 6 aircraft retains uniform seat geometry; travel class is not a claim about a real business-class cabin layout. No class automatically grants priority, changes zone, implies assistance or adds a baggage allowance. The existing synthetic allowance is uniform: one overhead piece, up to the configured weight (default 10 kg), and one personal item. This is a toy policy, not a real airline fare rule.

Class labels use a separate seeded stream. Changing only their probabilities leaves seats, parties, boarding rights, baggage, status/timestamps and physical processing samples identical. Existing boarding algorithms do not infer priority from the new class field.

Default class probabilities are 85% Economy / 10% Premium Economy / 5% Business. Existing priority probability is 12%, assistance probability 2.5%, and extra preboarding probability 1% among passengers without assistance. Overhead/personal-item probabilities default to 65%/85%; actual overhead weight is sampled from 2–10 kg when a bag is present. These are probability draws, not exact quotas.

Party probability defaults to 55% at each grouping decision. Requested party size is sampled uniformly between `partySizeMin` and `partySizeMax`, inclusive. Bounds must be integers with `2 <= min <= max <= configured capacity`:

- Default bounds 2–3 preserve the existing row-side grouping/clipping and original seed behavior. A remaining single seat becomes solo.
- Custom bounds keep requested groups intact across row/aisle-side boundaries, rather than silently breaking an all-pairs configuration into pairs and solos.
- The final aircraft-capacity remainder can make the last party smaller than its requested minimum; a single remaining passenger is solo. The audit reports realized sizes.

Arrival/status generation and existing assistance companion rules are retained. This Stage 1 change does not add a new check-in/security process or ETA model.

## Configure and reproduce

From `BoardingFlow`:

```powershell
node src/cli.js generate --seed 42 --output data/stage1-passengers.json
node src/cli.js validate --input data/stage1-passengers.json
node src/cli.js audit-dataset --input data/stage1-passengers.json --output results/stage1/dataset-audit.json
node --test
```

Use the provided partial override example for a different mix:

```powershell
node src/cli.js generate --seed 42 --config config/stage1.example.json --output data/stage1-custom.json
node src/cli.js audit-dataset --input data/stage1-custom.json --output results/stage1/custom-audit.json
```

The example configures all three class probabilities (which must sum to one), priority/assistance probabilities, overhead/personal-item rates, party probability and 2–6 requested party sizes. Configuration is saved in the manifest; the same seed and settings reproduce the same bytes. Different seeds can change the realized mix.

`audit-dataset` returns an inspectable JSON report with realized class/zone/assistance counts, party-size histogram and every passenger's allowance/actual values and violation codes. It saves the report and exits 1 when baggage is noncompliant, class is unknown or geometry does not meet the Stage 1 target. Structural problems such as missing fields, duplicate seats or invalid counts are rejected. Normal `validate`, simulation and comparison still reject noncompliant baggage; the inspection option is not enabled in those paths.

The weight audit uses aggregate overhead weight against actual piece count × per-piece allowance, matching the existing data model. Default generation has at most one overhead piece, making this exact for its synthetic passengers. Imported multiple-piece data cannot reveal individual overweight bags from aggregate weight alone; dimensions and per-bag weights are not modeled. Tiny excesses still fail comparison even when the displayed kilogram excess rounds to six decimals.

## Version compatibility

New manifests use `schemaVersion: 2` and require `travelClass` plus the complete new configuration. Schema 1 remains accepted with its original complete configuration and no invented class. CSV projections show null class for legacy inputs; the dataset audit counts it as unknown. Validation never mutates saved manifests.

New metadata changes the SHA-256 of newly generated manifests. Standalone regression tests remove only additive class/configuration metadata and confirm the exact original Phase 1 payload fingerprint and 1624/1796/1426-second completion times. Custom four-person parties are tested through the existing Phase 1 pipeline. The full local workspace additionally verifies Phase 2 fingerprints, readiness, leakage protections and spatial traces; those unpublished integration files are excluded from this Stage 1 commit.

## Files changed in this Stage 1 work

- `src/config.js`, `src/generate.js`: class mix, party-size configuration and schema 2 generation.
- `src/model.js`: class validation, schema 1 compatibility, shared strict baggage audit.
- `src/baggage.js` (new), `src/dataset-audit.js` (new): allowance/actual checks and dataset report.
- `src/cli.js`: dataset-only audit command.
- `src/io.js`: expose class as a separate CSV field; no simulation algorithm changes. The separate Phase 2 public-catalog projection remains with unpublished Phase 2 work.
- `config/stage1.example.json` (new): configurable dataset example.
- `test/stage1.test.js` (new): self-contained Stage 1 coverage and original-payload regression compatibility. Phase 2 integration assertions remain outside this commit.
- `README.md`, `docs/MODEL.md`, this file: usage, assumptions and audit evidence.

Existing simulator and strategy source files are unchanged by this Stage 1 commit. Prior uncommitted Phase 2 work is preserved separately in the local workspace. Generated datasets, temporary verification files and test output logs are excluded from the commit.

## Actual default dataset evidence

The full local workspace suite passes **59/59 tests**, including previously developed Phase 2 integrations. This standalone Stage 1 snapshot passes **38/38 tests**: the 26 original core tests plus 12 self-contained Stage 1 tests. The integration-only portions are preserved locally and excluded from the commit. Test logs are generated evidence and are not committed.

Seed 42, default configuration:

| Check | Actual result |
| --- | ---: |
| Passengers / unique IDs / unique seats | 180 / 180 / 180 |
| Travel classes | 151 Economy / 22 Premium Economy / 7 Business |
| Zones | 60 rear / 60 middle / 60 front |
| Priority eligible | 21 |
| Assistance requests | 3 |
| Multi-passenger parties / solo passengers | 48 / 57 |
| Realized parties by size | 21 pairs / 27 triples |
| Overhead pieces, actual / permitted | 113 / 180 |
| Noncompliant baggage passengers | 0 |

Input fingerprint:

```text
eb9f89cd273967c5c31cf31b566818af49694bcd7449ac2a89cdc5f4c051973f
```

Generated evidence is in `data/stage1-passengers.json` and `results/stage1/dataset-audit.json`; the full test log is `results/stage1/test-results.txt`.
