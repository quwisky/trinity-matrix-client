# Architecture migration baselines

The completed architecture program preserves observable behavior through a generated structural contract and retained measurement contracts. New migrations must instrument a path before replacing it and must finish by returning every temporary ledger to zero.

## Structural snapshot

The committed [generated dependency map](generated/dependency-map.md) is built from the live Nx graph and records project classifications, dependency counts, role/capability direction, entrypoints, cycles, and the final contraction state. The architecture check fails if:

- a shipped project lacks known `role:*` and `capability:*` metadata;
- a prohibited role or cross-capability dependency appears;
- any classification, secondary-entrypoint, multi-capability, dependency-exception, or source-baseline ledger becomes non-empty;
- a public entrypoint becomes implicit or wildcarded;
- the committed generated map differs from the live graph; or
- an Nx project cycle appears.

The machine-readable contracts live in `architecture/contract.json` and `architecture/quality-baselines.json`. `scripts/final-boundaries.spec.mjs` hard-fails package-level SDK, Router, native-platform, and retired-compatibility escapes that the project graph alone cannot express.

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

Each owning ticket records the current-path distribution and an approved regression budget before switching production callers. Machine-specific timings are evidence, not universal constants; deterministic counts and leak checks are hard assertions.

## Security invariants

- Normalize untrusted Matrix events before capability or presentation code consumes them.
- Keep credentials, secret material, message bodies, and precise location out of diagnostics.
- Confine Matrix SDK imports to Matrix adapters and the approved pure Matrix modeling boundary.
- Version Electron IPC, validate senders, and expose only negotiated host capabilities.
- Declare storage and export restrictions for every sensitive preference.

The quality-baseline registry names the owning implementation issues and required enforcement seam for each invariant.
