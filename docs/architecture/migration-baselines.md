# Architecture measurement and security contracts

Use this guide when changing a lifecycle, projection, dependency or security boundary. These are living measurement and security contracts, despite the retained migration-era filename. The [architecture contract](target-architecture.md) requires empty exception ledgers; the [historical validation record](final-validation.md) records earlier deliveries.

Instrument the existing path before replacing it, preserve its observable behavior and compare the new path against the recorded budget. Registry membership alone is not a measurement or a passing performance check.

## Structural snapshot

The committed [generated dependency map](generated/dependency-map.md) is built from the live Nx graph and records project classifications, dependency counts, role/capability direction, entrypoints, cycles, and the final contraction state. The architecture check fails if:

- a shipped project lacks known `role:*` and `capability:*` metadata;
- a prohibited role or cross-capability dependency appears;
- any classification, secondary-entrypoint, multi-capability, dependency-exception, or source-baseline ledger becomes non-empty;
- a public entrypoint becomes implicit or wildcarded;
- the committed generated map differs from the live graph; or
- an Nx project cycle appears.

The machine-readable contracts live in [architecture/contract.json](../../architecture/contract.json) and [architecture/quality-baselines.json](../../architecture/quality-baselines.json). `scripts/final-boundaries.spec.mjs` hard-fails package-level SDK, Router, native-platform, and retired-compatibility escapes that the project graph alone cannot express.

## Performance contracts

| Metric                 | Measurement                                                                                                           | Instrumentation owner |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Account restore        | Time and terminal Account count until all saved Accounts reach a bounded outcome, with the Active Account prioritised | #299                  |
| Active Account switch  | Time until Account state, visible projections, and repaired Workspace destination pass one readiness barrier          | #301, #302            |
| Conversation attach    | Time from focus to the first presentable keyed snapshot                                                               | #304                  |
| Message projection     | Time per normalized event and representative batch                                                                    | #305                  |
| Workspace transition   | Time until the semantic view and canonical URL are committed                                                          | #310, #311            |
| Retained resources     | Handles, listeners, and retained bytes per Account after blur, retain, and eviction                                   | #301, #304            |
| Background Account CPU | CPU time per minute per connected inactive Account                                                                    | #299, #301            |

The issue references identify the original instrumentation owners. The current owner and exact
values live in [quality-baselines.json](../../architecture/quality-baselines.json), alongside a
scope and description of what is instrumented. Retain a current-path distribution and agreed
regression budget before switching production callers. Machine-specific timings are evidence,
not universal constants; deterministic counts and leak checks belong in assertions.

For example, the registry describes a two-handle blurred Conversation allowance per Account,
11 browser listeners per retained child and 11,200 deterministic modeled bytes per child.
Those bytes describe a bounded retained payload model, not a heap measurement. Its background
Account CPU entry currently records reconciliation count and wall time; those measurements do
not establish whole-process CPU usage. Inspect the owning instrumentation before choosing a
benchmark or interpreting a result.

The architecture validator checks required registry entries and fields. It does not execute
these measurements or enforce every numeric budget. Pair it with the owning runtime and
structural suites, and select host/browser checks using the
[validation policy](../contributing/testing.md). Record the revision, environment, invocation,
observed distribution/counts and unavailable coverage with each result.

## Security invariants

- Normalize untrusted Matrix events before capability or presentation code consumes them.
- Keep credentials, secret material, message bodies, and precise location out of diagnostics.
- Confine Matrix SDK imports to Matrix adapters and the approved pure Matrix modeling boundary.
- Version Electron IPC, validate senders, and expose only negotiated host capabilities.
- Declare storage and export restrictions for every sensitive preference.

The quality-baseline registry names the owning implementation issues and required enforcement seam for each invariant.
