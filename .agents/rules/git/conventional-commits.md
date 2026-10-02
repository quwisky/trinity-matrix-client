---
id: conventional-commits
name: Conventional Commits
description: All commits must follow the Conventional Commits specification
category: git
recommended: true
---

# Conventional Commits

Use `type(scope): subject` and follow the canonical
[commit policy](../../../apps/docs-developers/src/content/docs/contributing/branches-and-commits.md#commit-change) for types, subjects
and breaking-change notation. Commit types now drive versions: release-please turns `feat`,
`fix`, `perf`, `revert` and breaking changes into the next release PR.
For release work, follow the [private release guide](../../../docs-internal/maintenance/ci-and-releases.md).
