# Backend JSON contract v1

[backend-contract.schema.json](backend-contract.schema.json) describes the canonical Stage 6 exports using JSON Schema Draft 2020-12. Its `$id` is `urn:boardingflow:backend-contract:1`; the root validates a `Manifest`. Select a fragment such as `#/$defs/TraceEnvelope` for another payload. No HTTP endpoint, new wire-version field or input migration is implied by this documentation.

| Consumer payload | Definition |
| --- | --- |
| Flight manifest / individual passenger | `Manifest`, `Passenger` (schema 2), `PassengerV1` (legacy schema 1) |
| Full configuration / partial overrides | `Configuration`, `ConfigurationOverrides`, `Phase2Settings`, `Phase2Overrides`, `AdaptiveSettings`, `AdaptiveOverrides`, `PolicyConfiguration` |
| Terminal / observation tape | `Terminal`, `Phase2`, `Observation` |
| Decision-time readiness | `ReadinessSnapshot`, `ReadyPassenger`, `ETAPrediction` |
| Observed staff/policy | `StaffEvent`, `Policy`, `PolicySnapshot`, `PolicyAdvisory` |
| Actual aircraft trace | `TraceEnvelope`, `TraceMetadata`, `TraceEvent`, `TraceValidation` |
| Adaptive advice | `RecommendationEnvelope`, `Recommendation` |
| Saved per-strategy result / individual timing | `Result`, `Timing`, `Metrics`, `Constraints`, `ResultValidation` |
| Per-flight comparison | `Comparison` |
| Stage 6 suite/statistics | `Benchmark`, `Statistics`, `SampleSummary`, `Diagnostics` |
| Gate ETA retrospective errors | `ETAEvaluation` |
| Small example inventory | `ExampleIndex` |

Required/optional fields, nullability and event-specific variants are explicit in the schema. `additionalProperties:false` rejects unversioned fields in canonical export objects; custom metadata that the runtime may tolerate is outside this canonical export contract. The schema cannot enforce all relationships (unique seats across records, event chronology, capacity, gate arrival, group integrity, forecast nonleakage or approval entitlement). Use `validateManifest`, `validateScenario`, `auditResult` and `validateSimulationTrace` for domain validation. Readiness timestamps, checks and route estimates must come from the observation adapter.

Saved `timings-*.json` files intentionally omit runtime `events`, `traceMetadata`, `traceValidation` and `recommendations`; those have their own export files. `simulate()` returns these additional fields in memory when enabled, while `Result` describes the saved timing export. `compareAllStrategies()` returns an in-memory comparison with raw results, not the per-flight `Comparison` export's `metricNotes` shape; call `writeArtifacts` to obtain the exported shape. Do not serialize a module return value and assume it matches a differently named file schema.

For all field units, the 19 event variants, recommendation branch differences and time conventions, see [TEAM_HANDOFF.md](../docs/TEAM_HANDOFF.md). For validation with the pinned optional Ajv tools outside this project, run its `validate-integration-schemas.js` command. All normal backend tests remain dependency-free. Consumers can equivalently load the schema into their own Draft 2020-12 validator and select the appropriate fragment; do not fetch the URN over the network.

Contract v1 documents manifest versions 1/2, terminal schema 1, trace schema 1, comparison schema 1 and current/legacy recommendation variants. It is not the npm package version. Breaking format changes should receive a new contract ID and explicit wire-version/migration plan. A controller algorithm version is not a trace schema version. Additional reason strings are textual explanations; renderer control flow should branch on the documented `action`, stage and field presence.
