# Issue tracker: GitHub

Issues and specs for this repository live in GitHub Issues at
`quwisky/trinity-matrix-client`. Use the `gh` CLI for all operations.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`
- List: `gh issue list` with appropriate state and label filters
- Comment: `gh issue comment <number> --body "..."`
- Label: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

Before creating an issue, search existing open issues and inspect plausible
matches. Update an existing report when new evidence belongs to it.

Infer the repository from `git remote -v`; `gh` does this automatically inside
the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and pull requests. Resolve an
ambiguous `#42` with `gh pr view 42`, then fall back to `gh issue view 42`.

## Skill operations

- “Publish to the issue tracker” means create a GitHub issue.
- “Fetch the relevant ticket” means run `gh issue view <number> --comments`.
- Preserve observed platform scope and distinguish confirmed platforms from
  platforms that still need verification.

## Wayfinding operations

A wayfinding map is one issue with linked child issues.

- Label the map `wayfinder:map`.
- Link child tickets using GitHub sub-issues where available.
- Label children `wayfinder:research`, `wayfinder:prototype`,
  `wayfinder:grilling`, or `wayfinder:task`.
- Represent blocking relationships with native GitHub issue dependencies.
- If native sub-issues or dependencies are unavailable, use task lists and
  explicit `Part of` or `Blocked by` lines.
- Claim work by assigning the issue to the current user.
- Resolve a ticket by recording the answer, closing it, and updating the map.
