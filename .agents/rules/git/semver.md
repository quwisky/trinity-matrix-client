---
id: semver
name: Semantic Versioning
description: release-please picks versions from Conventional Commits — never bump versions by hand
category: git
recommended: true
---

# Semantic Versioning

Keep versions unchanged in ordinary work. release-please bumps `package.json`,
`electron/package.json` and its manifests in a release PR: `X.Y.Z-next.N` prereleases
on `develop`, stable versions on `main`. Do not add `Release-As` footers: both lines
read them and would cut the same version twice. Follow the
[private release guide](../../../docs-internal/maintenance/ci-and-releases.md) for
promotion and publishing.
