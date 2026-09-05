# Issue tracker: GitHub

Issues and specs for this repository live in GitHub Issues at
`quwisky/trinity-matrix-client`. Use the `gh` CLI for all operations.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`
- List: `gh issue list` with appropriate state and label filters
- Comment: `gh issue comment <number> --body-file <file>`
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

## Publication and verification

Carry accepted decisions and authorization from the conversation into the tracker operation.
Prepare a concrete breakdown before requesting approval when approval is still needed. Once
publication or a parent update is authorized, perform it without repeating that question.
Use body files for multiline text so Markdown and literal characters survive unchanged.

Search existing children before creating tickets. Reuse their issue identities when revising
an approved plan. Create new children in dependency order, then wire any remaining native
blocking edges using real issue numbers. A readable graph is an index of those relationships.
Read back edited titles/bodies, parent links, blocker sets and labels before reporting success.
Re-read a parent immediately before editing it and preserve concurrent changes.

## Work through an existing map

- Load the map body first. `Destination` and `Notes` state its goal and mode; older maps may
  use `Goal` and `Program rules`. Planning is the default. An explicitly approved implementation
  destination and child acceptance criteria can include execution; preserve that agreement and
  record it in Notes when updating the map. A `wayfinder:task` label alone is insufficient.
- Query all native child pages, including each child's state, assignees and blockers. The
  frontier is open, unassigned children whose blockers are all closed and external prerequisites
  are satisfied; follow native child order.
  A closed blocker remains a valid dependency and does not need its edge removed.
- For maps using frontier labels, apply `ready-for-agent` only to that executable frontier.
  Labels summarize live dependencies; they do not replace the dependency check.
- Recheck the selected ticket and its blockers before claiming it with the current GitHub
  user. Read the assignment back; if another owner has claimed it, choose another frontier
  ticket. GitHub assignment is not an atomic lock, so coordinate any detected overlap.
- Refer to tickets by linked title in narration. Load full child bodies and resolution
  comments only as needed. Use the skills named by the map and resolve one non-research ticket
  per session.
- Close a decision ticket only when its answer is established; close an execution ticket only
  when its acceptance and validation criteria are met. Record evidence and limitations in a
  resolution comment, then append a linked gist under the map's `Decisions so far`.
- Preserve open work and native edges when normalizing a legacy map. Keep detail in its owning
  ticket, query open children as the work index, and keep undecided scope under `Not yet specified`.
  A published plan alone does not complete an implementation ticket.
