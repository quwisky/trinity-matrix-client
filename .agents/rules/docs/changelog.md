---
id: changelog
name: Changelog Maintenance
description: release-please writes CHANGELOG.md from Conventional Commit subjects; never edit it by hand
category: docs
recommended: true
---

# Changelog Maintenance

release-please writes `CHANGELOG.md` when a stable release PR merges on a [`release/X.Y` branch](../../../docs-internal/maintenance/ci-and-releases.md#releases); do
not edit it by hand. `feat`, `fix`, `perf` and `revert` subjects and `BREAKING CHANGE:`
footers become the release notes, so write them for users. Follow the
[private release guide](../../../docs-internal/maintenance/ci-and-releases.md) for
releases.
