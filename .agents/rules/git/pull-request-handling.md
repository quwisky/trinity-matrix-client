# Pull Request Handling

The maintainer merges. Take a pull request to ready and hand it over. Unless the maintainer
asks for that specific action, do not merge one (`gh pr merge`, with or without `--admin`),
approve one (`gh pr review --approve`), tick a Dependency Dashboard approval, or bypass or
change a ruleset. `main` requires an approval and a code owner's review, and a bypass skips
both. Never check out or run a fork's code.

Follow
[Prepare a pull request](../../../apps/docs-developers/src/content/docs/contributing/prepare-a-pull-request.md#review-handoff)
for the review before ready, stacked pull requests, changing someone else's pull request and
what to do after a merge. Follow the
[Renovate runbook](../../../docs-internal/maintenance/ci-and-releases.md#renovate-and-the-trigger-it-silently-depends-on)
for dependency updates.
