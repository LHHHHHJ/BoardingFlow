# Stage 5 - Passenger Rights and Boarding Constraints

This stage extends the existing Node.js simulation. It does not add an optimizer, dashboard, ML or a later-stage feature. Earlier local Phase 2/adaptive work remains in place. This publication isolates Stage 5; the adaptive controller, its settings/strategy changes and unrelated local Phase 2 work remain uncommitted.

## Seven-item audit and completion checklist

| Requirement | Before Stage 5 | Completion and evidence |
| --- | --- | --- |
| 1. Explicit simplified airline-policy reference | Protected stages and three zones implemented; airline reference and versioned policy missing | Complete: verified SWISS reference below; `BF-SWISS-INSPIRED-V1` specifies preboarding, one collapsed priority stage and general zones. Historical research behavior is separately identified. |
| 2. Preserve First/Business and eligible elite priority | Partial: `priorityEligible` worked; class labels were deliberately independent and there was no confirmed elite/First entitlement record | Complete in the explicit profile: booked Business, confirmed First entitlement/upgrade, confirmed elite eligibility and explicit priority flags enter the protected stage. All strategies use the same derived rights. Tests reject demotion, false stage metadata, hidden protected groups and lower-stage proposals. |
| 3. Confirmed assistance/accessibility without diagnosis | Partial: mobility/extra-time service, escorts and companions existed; requested arrangements lacked a confirmation boundary | Complete: every requested arrangement must appear in the confirmed assistance list. Unknown/unconfirmed arrangements require staff review. Companions may share an original party or a confirmed required family; empty-aisle escort reservation and existing service times remain enforced. No diagnosis field is collected. |
| 4. Required parties/families and young-child privilege | Partial: original parties stayed intact; explicit families across reservations and child privileges were missing | Complete: required families merge transitively with original parties, keeping all members together. Confirmed under-five children and their guardians receive whole-group preboarding. Older-family arrangements remain intact without automatic privilege. Missing guardians and partial proposals fail. |
| 5. No automatic senior/pet speed or priority assumptions | Complete existing absence of those rules; focused negative tests missing | Complete: labels are ignored for rights, ordering and service. Tests verify unchanged behavior/timings and prevent age, pet and diagnosis getters from being accessed by advisory checks. Explicit priority/assistance arrangements remain available regardless of those labels. |
| 6. Advisory recommendations, staff/gate verification and safe fallback | Partial: observed readiness and protected stages existed; staff approval, advisory labeling and independent policy review were missing | Complete: policy review checks complete groups, stage/zone, assistance, observed clearance/presence and timestamped staff/gate confirmations. Policy confirmation defaults to UNVERIFIED. Unsafe/unreliable input holds for review. The fallback uses only ready, confirmed units in the current protected stage; it consumes no ETA. Simulation admission repeats presence/confirmation guards. |
| 7. Automated enforcement tests | Partial: prior stage/party/arrival tests existed | Complete: 28 Stage 5 tests; 128/128 isolated-tree tests and 141/141 full-workspace tests; unchanged 99-run Stage 3 benchmark and 12 Stage 4 ETA reports. The published baselines have nine policy-enabled full-flight runs with zero violations, while the full local workspace also retains its adaptive integration checks. Details and actual results below. |

## Reference and deliberate simplifications

Verified on 2026-11-07: [SWISS official boarding-by-groups policy](https://www.swiss.com/ca/en/fly/airport/boarding). The published sequence places preboarding before priority groups and then other groups. It identifies under-five families and restricted-mobility passengers for preboarding, First/HON Circle in its first priority tier, and Business/Senator/Star Alliance Gold in its second. It also describes passengers checking in together boarding together.

BoardingFlow uses that structure as a reference, not a reproduction of SWISS operations or a legal entitlement determination. Its modeled rules are:

| Model stage | Explicit conditions |
| --- | --- |
| PREBOARD (0) | Existing mandatory preboarding arrangements; confirmed requested mobility/extra-time assistance; confirmed under-five family child and the full required group. All must be seated before priority begins. |
| PRIORITY (1) | Existing explicit `priorityEligible`; `travelClass=BUSINESS`; IDs with a confirmed First booking/upgrade entitlement; IDs with staff-confirmed eligible elite priority. The whole required group receives its earliest member entitlement. All priority units enter before general admission. |
| GENERAL (2) | Other passengers. Zone strategy calls model zones 1 rear, 2 middle, 3 front; random/baggage may reorder general units within their existing strategy rules. The separate local adaptive implementation is subject to the same rights checks. |

The two airline priority tiers are intentionally collapsed; the model does not guarantee First-before-Business within its single priority stage. General zone numbers/row partitions are this project's assumptions, not the airline's group assignments. Premium Economy alone grants no additional entitlement in this simplified profile. Staff-confirmed First entitlements can record an upgrade separately from the original synthetic fare label; the Stage 1 class generator is unchanged. Elite eligibility is a verified boarding entitlement, not an inferred status from a passenger's claimed tier.

The model additionally keeps staff-confirmed required cross-booking families and their original parties together. It does not implement airline-specific companion limits, unaccompanied-child custody procedures, gate deadlines, rights waivers or interline exceptions. There is no promise of compliance with every airline's complete operating policy.

## Versioning and compatibility

`manifest.boardingPolicy` explicitly activates the new profile. `apply-policy` clones its input; it never mutates passenger seats, baggage, sampled behavior, actual arrivals, terminal observations or truth. Profile configuration adds policy facts and staff-event tape only. Required-family grouping and promoted entitlements intentionally change boarding order and may change completion/waiting/blocking metrics.

Manifests with no profile retain the pre-existing **legacy synthetic research policy**. Their fare labels remain independent of priority, exactly as Stage 1 documented. They must not be presented as enforcing the new airline-inspired class rights. An explicitly null, malformed or unknown profile fails validation; it does not silently fall back to legacy. The optional profile makes historical experiments replayable while allowing a clearly identified rights-aware simulation. Compare only runs with the same profile and full input hash.

The complete saved Stage 3 benchmark (seeds 0-9 and 42, three arrival cases, 99 runs) reproduces exactly, including manifests' hashes, metrics, summaries and losing cases. All 12 saved Stage 4 ETA reports also reproduce exactly. Existing Phase 1/2 dataset fingerprints, spatial trace, protected-arrangement and adaptive future-information tests pass. `individualStage` retains compatibility with existing unary calls and `Array.map(individualStage)`.

## Configuration and confirmed arrangements

`config/stage5.example.json` is a synthetic fixture for default seed 42, valid for its normal, delayed-security and late-arrival journeys. Other seeds or changed passenger mixes require updated confirmed ID lists; invalid IDs fail rather than being guessed.

| Field | Meaning |
| --- | --- |
| `profileId` | Exactly `BF-SWISS-INSPIRED-V1`. |
| `status` | Explicit `CONFIRMED` or `UNVERIFIED`; omission in fixture preparation defaults to UNVERIFIED. |
| `confirmedFirstClassPassengerIds` | Confirmed First boarding entitlements/upgrades, independent of a stale synthetic fare label. |
| `elitePriorityPassengerIds` | Staff-confirmed eligible elite entitlements. No automatic inference from a tier string. |
| `confirmedAssistancePassengerIds` | Must match passengers with an explicit non-NONE arrangement; confirmation does not invent a requested service. |
| `families` | Unique family ID, complete `memberIds`, confirmed `youngChildUnderFivePassengerIds`, and distinct `guardianPassengerIds`. Child privileges need at least one guardian in the required group. Exact ages are not required. Empty child lists preserve family grouping without a child privilege. |
| `staffEvents` | Separate per-passenger `STAFF_APPROVAL` and `GATE_VERIFICATION` observations, each with finite `timeSeconds` and boolean `confirmed`. At most one per kind/passenger in this prototype. Missing/false events never grant permission. |
| `syntheticStaffConfirmation` | Explicit offline-only fixture option with nonnegative approval/gate-verification delays after actual simulated arrival. It creates synthetic staff events; cannot be combined with a supplied staff tape. It is removed from the stored policy and is never called during advisory decisions. |

The example confirms assistance for SYN-P028, SYN-P077 and SYN-P155. Its required family connects SYN-P001/P002 and SYN-P175/P176, merging any original parties; SYN-P001 has the confirmed child privilege and SYN-P002 is its guardian. It declares a First entitlement for SYN-P010 and elite entitlement for SYN-P040. These are invented test arrangements, not personal or official passenger data. Simulated staff approval occurs at actual gate arrival and gate verification five seconds later. No real staff approval is asserted.

Only the listed policy/family/staff-event fields are accepted. Diagnosis and medical-condition fields are rejected in policy input. No senior or pet label is requested by the new schema. Existing assistance types describe operational requirements; their existing service durations are retained. Requested assistance without confirmation stops for review instead of being discarded or treated as a slower demographic group.

## Advisory and execution boundary

`createPolicyObserver` owns the synthetic future staff tape, advancing monotonically. Its snapshot includes only confirmations whose timestamps are at or before the decision time; future events and actual journey outcomes are excluded. Rules/booking rights are static known facts. The readiness observer continues to distinguish check-in, security entry, security clearance and observed gate arrival.

`reviewBoardingRecommendation` receives observed readiness, public booking information, current boarded/seated IDs, pending required units and the observed policy snapshot. It validates identities, full membership, derived stages/zones, preboarding completion, assistance reservation and evidence timestamps. `readyAtGate=true` alone is insufficient. Approval and gate verification must both be confirmed and observed; gate verification cannot precede the observed gate arrival. It never reads an ETA, future actual arrival, sampled aircraft service duration or hidden security outcome.

Every decision is advisory and simulation-only, with `requiresStaffApproval` and `requiresGateVerification`. `simulationAdmissionAllowed` describes this synthetic execution gate; it is not airline authorization. The separately held local adaptive recommendation records are tagged advisory and `executionAuthorization=NONE_ADVISORY_ONLY` when this profile is active. The optimizer's score, search and anticipation implementation is unchanged.

Unknown/unverified policy and inconsistent identity, stage or party information produce HOLD/staff-review outcomes. Missing observation/confirmation produces HOLD; it cannot be replaced by a predicted arrival. With reliable policy and observed evidence, the fallback selects the first ready, staff-confirmed whole unit in the pending lottery/order, within the current stage and the zone barrier where applicable. If the local adaptive proposal is waiting for staff confirmation, this fallback may admit another confirmed unit in the same protected stage. It does not compute a new optimization score. Assistance still requires an empty aisle. Rights are never dropped to improve elapsed time.

The shared engine validates the manifest/profile, advances both observation adapters, reviews candidate units and checks actual simulated presence, observed clearance/location and confirmations again at entry. Missing required confirmations can cause the existing explicit timeout. The post-run evaluator independently counts observed-readiness, staff-approval, gate-verification and family-separation violations in addition to the previous rights/assistance checks. Corrupted-result tests demonstrate nonzero violations. Legacy result schemas/metrics are unchanged when no profile is attached.

## Changed files

| File | Stage 5 change |
| --- | --- |
| `src/policy.js` | Versioned simplified rights, strict policy schema, required-family/party union, observed staff confirmations, advisory review and safe fallback. |
| `src/policy-scenario.js` | Clone-and-apply profile and explicitly requested offline synthetic staff-event generation. |
| `src/model.js` | Policy validation/stage derivation, original map-callback compatibility, confirmed cross-family companion validation. |
| `src/strategies.js` | Reuse required policy groups and derived stages across all existing strategies; ordering algorithms unchanged. |
| `src/simulate.js` | Shared policy/admission checks and advisory metadata around the existing strategy selection; preserve actual-presence guards. |
| `src/constraints.js` | Independent policy-enabled evidence/family violation counts; legacy report unchanged. |
| `src/io.js` | Explicit profile/approval notice in policy-enabled comparison exports. |
| `src/cli.js` | `apply-policy` and `policy-preview`, using existing scenario/simulator commands. |
| `config/stage5.example.json` | Seed-42 synthetic confirmed rights, family and explicit simulated staff confirmations. |
| `test/stage5.test.js` | 28 focused tests including class/elite conflicts, families, guardians, late/missing evidence, assistance, demographic noninference, staff gates, fallback, future isolation, corrupted audits, all-strategy traces and CLI exports. |
| `README.md` | Profile activation and verification commands. |
| `docs/STAGE5_AUDIT.md` | This seven-item audit, reference, data/approval contract, actual results and limitations. |

No adaptive scoring-source, ETA-source, generator or default configuration change is required. Unrelated local modifications/untracked files remain intact. Generated Stage 5 manifests/timings are under Git-ignored `results/stage5/`.

## Actual test and scenario results

- `node --test test/stage5.test.js`: 28/28 pass.
- Isolated published tree: `node --test` passes 128/128 (100 existing plus 28 Stage 5). Full local workspace: 141/141 (113 existing plus 28 Stage 5). Neither run has failures, skips or cancellations.
- All 99 legacy Stage 3 benchmark runs and all 12 Stage 4 ETA reports match their saved references exactly.
- Nine published baseline/profile runs and twelve full-workspace/profile runs: all seat 180 passengers exactly once with zero constraint violations.
- Full-profile traced runs repeat for every available strategy: three baselines in the isolated tree; those baselines plus the existing local adaptive strategy in the full workspace. The tests do not require or enable adaptive support in the published tree.

Measured results below are from the isolated published Stage 5 tree. All strategies within a scenario share one profile, actual journey and simulation assumptions. These are rights/constraint checks, not an optimizer benchmark.

| Scenario | Strategy | Completion (s) | Mean gate wait (s) | Aisle blocking (person-min) | Violations |
| --- | --- | --- | --- | --- | --- |
| normal | random | 1557 | 1024.40 | 196.33 | 0 |
| normal | zone | 1715 | 1087.69 | 276.75 | 0 |
| normal | baggage-aware | 1435 | 989.56 | 173.40 | 0 |
| security-delays | random | 2021 | 1190.47 | 193.28 | 0 |
| security-delays | zone | 2164 | 1244.63 | 270.73 | 0 |
| security-delays | baggage-aware | 1917 | 1166.59 | 165.58 | 0 |
| late-arrivals | random | 2515 | 1626.64 | 192.20 | 0 |
| late-arrivals | zone | 2658 | 1681.30 | 268.15 | 0 |
| late-arrivals | baggage-aware | 2401 | 1597.37 | 166.87 | 0 |

The uncommitted workspace uses an expected-stow baggage score and includes adaptive support. The published baseline retains its previously committed sampled-stow score, so its baggage-aware profile results can differ. No baseline scoring change is included in Stage 5. Published terminal manifests omit the local adaptive configuration block inherited from the earlier isolation; passenger/journey truth and ETA reports match. These input/score distinctions must be retained in comparisons.

Raw metrics, profile/hash, constraint categories and advisory records are in `results/stage5/verification.json` and each scenario's saved manifest/timings. No failed or losing run was removed.

## Reproduce and remaining limitations

Run the README Stage 5 sequence from the `BoardingFlow` directory. Repeat generation with `--scenario security-delays` or `--scenario late-arrivals` to inspect the other measured cases, reusing the seed-42 policy fixture. `simulate` accepts the three committed baselines; the separate local workspace also supports adaptive. `policy-preview` assumes no previous aircraft admission; replayed/live advice would need actual current boarded/seated state. Preview never mutates or approves a real operation.

The model is an uncalibrated synthetic teaching policy, not a full airline/legal/accessibility compliance system. Confirmation facts are supplied assumptions; no live staff identity, document/DCS integration, revocation/correction workflow or departure cutoff is modeled. First/Business tiers are collapsed and companion limits are not modeled. Seating arrangements and child/guardian eligibility must already be staff-confirmed; the system does not infer ages or reassign seats. Conservative party promotion, late protected arrivals and withheld approvals can increase waiting or prevent completion. Explicit confirmations do not diagnose passengers. All future optimizer/dashboard/ML work remains outside this stage.

## Publication isolation

Only Stage 5 implementation, tests, config and documentation are published. Shared-file patches are applied to the Stage 4 committed versions, preserving all other local hunks. `src/adaptive.js`, adaptive strategy registration/scoring, Phase 2 suite CLI, recommendation exports, optimizer settings and combined Phase 2 documents remain local. Adaptive-specific advisory integration hooks in the shared simulator remain alongside that local implementation. Stage 5 tests select the committed baselines or optional local adaptive support without skipping core rights scenarios.
