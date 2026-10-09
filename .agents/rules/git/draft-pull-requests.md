# Draft Pull Requests

Open every pull request as a draft (`gh pr create --draft`). Mark it ready
(`gh pr ready <number>`) only when it can be merged as it stands: every check is
green, its review is finished, and no fix, question or merge from `main` is
pending. When new work lands on a ready pull request, return it to draft
(`gh pr ready <number> --undo`) until it is green and reviewed again.

`scripts/agent-guard.mjs` blocks `gh pr create` without `--draft` and blocks
`gh pr ready` while `gh pr checks` does not pass. Follow
[Prepare a pull request](../../../apps/docs-developers/src/content/docs/contributing/prepare-a-pull-request.md#review-handoff)
for the rest of the handoff.
