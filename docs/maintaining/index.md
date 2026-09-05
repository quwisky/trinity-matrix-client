# Maintaining Trinity

This guide is for the work that keeps Trinity buildable, releasable and diagnosable across its
web, desktop and mobile hosts. Start with the operation you need to perform; the linked pages
remain the source of the detailed commands and policy.

| Task                                         | Read                                                                                                                                        | Why it matters                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Understand a pull-request or scheduled check | [CI and releases](../contributing/ci-and-releases.md#the-ci-jobs)                                                                           | Explains each CI job, what it runs and the contract it protects.              |
| Diagnose a known warning                     | [Validation warning ledger](../contributing/validation-warnings.md)                                                                         | Separates classified upstream output from repository regressions.             |
| Prepare or publish a release                 | [Releases](../contributing/ci-and-releases.md#releases) and [changelog and releases](../contributing/conventions.md#changelog-and-releases) | Covers the release workflow, versioning and the authorization boundary.       |
| Package or verify a host                     | [Platforms](../platforms/index.md)                                                                                                          | Routes to the web, desktop and mobile host guides.                            |
| Update a dependency or check compatibility   | [Stack reference](../reference/stack.md) and [Renovate](../contributing/ci-and-releases.md#renovate-and-the-trigger-it-silently-depends-on) | Records pinned versions, integration constraints and dependency automation.   |
| Choose or reproduce local validation         | [Testing](../contributing/testing.md#choose-validation-by-the-change) and [commands](../contributing/commands.md)                           | Selects the check that proves the changed behavior and its host requirements. |

For ordinary source changes, begin with [Developing Trinity](../contributing/index.md);
maintenance work still follows its branch, publication and validation conventions.

## Documentation migration coordination

The [documentation map](../documentation-map.md) records migration ownership and status. It is
an administrative inventory for maintainers, not the route to use when looking for product,
development or agent guidance.
