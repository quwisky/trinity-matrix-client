# Maintaining Trinity

Use these procedures to diagnose automation, prepare a release, recover a partial packaging
run or update dependencies. They describe the workflows committed to this checkout; proposed
CI and mobile-distribution changes are identified separately in the release guide.

| Task                                       | Start here                                                                                                                  | Check before proceeding                                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Understand a missing or failed CI result   | [CI jobs and triggers](ci-and-releases.md#the-ci-jobs)                                                                      | Match the event, changed paths, job and candidate commit; a skipped job proves no validation.                                         |
| Diagnose noisy or incomplete validation    | [Validation warnings](validation-warnings.md)                                                                               | Keep exit status, cache provenance and expected output; distinguish a warning from a failed assertion.                                |
| Prepare a release candidate                | [Release procedure](ci-and-releases.md#releases)                                                                            | Coordinate versions and changelog, check the exact tag target and complete the required validation.                                   |
| Diagnose signing or partial release assets | [Release recovery](ci-and-releases.md#releases) and [desktop packaging](../platforms/desktop.md)                            | Verify prerequisites and artifact completeness; a draft or partial matrix is not a public release.                                    |
| Package another host                       | [Platforms](../platforms/index.md)                                                                                          | Native signing, device proof and publication have their own prerequisites; desktop release automation does not distribute every host. |
| Update a dependency                        | [Renovate](ci-and-releases.md#renovate-and-the-trigger-it-silently-depends-on) and [stack reference](../reference/stack.md) | Follow the configured patch/non-patch approval route, validate compatibility and inspect bot health.                                  |
| Reproduce a check locally                  | [Testing](../contributing/testing.md#choose-validation-by-the-change) and [commands](../contributing/commands.md)           | Choose the check that proves the claim and report unavailable host coverage.                                                          |

An ordinary documentation or implementation change does not authorize a release, a store
submission, credentials changes or infrastructure changes. Follow the existing
[branch and publication conventions](../contributing/conventions.md#branches-and-publication)
and the user's accepted scope. Release commands belong to an explicitly authorized release
operation; this documentation migration does not execute them.

For ordinary source changes, start with [Developing Trinity](../contributing/index.md).
Architecture and host guides remain the canonical owners of implementation and platform detail;
maintenance procedures link to them rather than restating their full instructions.

## Documentation migration coordination

The [documentation map](../documentation-map.md) records first-party topic ownership,
replacement destinations and retained history. When moving a guide, repair its readers' links
and any script that loads its path, then check both outgoing and incoming anchors. Keep
generated/vendor documentation under its existing tooling ownership.
