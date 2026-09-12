# Trinity skill overrides

Read this with Superpowers, planning, review, research, prototype, product-design and Nx skills. These repository rules
specialize the generic upstream workflows; maintain them here instead of editing installed
skills. User instructions and accepted authorization govern the task.

## Superpowers integration

Superpowers supplies the process skills from the active client's installed plugin.
Trinity supplies domain skills and repository policy. Keep the plugin
under its installer ownership; do not copy it into `.agents/skills` or `skills-lock.json`.
Resolve skills from the active catalog, without hardcoding a plugin cache version.
If a required skill is unavailable, report the missing capability; do not claim it ran.

| Task state                                        | Process skill                                                                    |
|---------------------------------------------------|----------------------------------------------------------------------------------|
| New feature or unresolved behavior/design         | `superpowers:brainstorming`                                                      |
| Accepted requirements need a multi-step plan      | `superpowers:writing-plans`                                                      |
| Accepted plan, independent slices in this session | `superpowers:subagent-driven-development`                                        |
| Existing plan executed in a separate session      | `superpowers:executing-plans`                                                    |
| Bug, failed test or unexpected behavior           | `superpowers:systematic-debugging`                                               |
| Feature or bug implementation                     | `superpowers:test-driven-development`, using Trinity's validation policy         |
| Ready for independent review                      | `superpowers:requesting-code-review`                                             |
| Review findings received                          | `superpowers:receiving-code-review`                                              |
| Completion claim or authorized publication        | `superpowers:verification-before-completion`; finishing workflow when applicable |

Enter at the current task state. Reuse an accepted design, plan and authorization;
loading a process skill does not reopen completed stages. Handle a small, unambiguous
configuration or documentation edit directly. Ask only for unresolved decisions or
material scope changes, and continue independent authorized work meanwhile.

The coordinator owns any authorized dispatch and review; bounded children complete
their assignment without restarting orchestration. Use the active tool schema for
parameters and lifecycle operations when upstream examples differ from available tools.

Superpowers examples that commit each task, compare only commits, merge branches or
delete a workspace remain subject to Trinity's publication and evidence rules.
Review the complete working-tree artifact when work is uncommitted. Preserve plans,
reports and review evidence until the handoff is complete; cleanup must not remove
uncommitted work. Keep temporary execution artifacts under ignored `dist/`.
Durable documentation belongs in the repository's existing domain layout.

## Investigation and output

- Search for relevant symbols and paths before reading files. Expand to callers, dependencies
  and source references when needed to establish behavior; a summary is not proof of correctness.
- Return targeted excerpts and actionable results. Keep verbose logs in ignored output or
  tool artifacts, with locations available for inspection; preserve failures and exit status.

## Planning and tickets

- Reuse accepted decisions and confirmation from the conversation. Ask again only for an
  unresolved decision or material scope change; invoking another skill does not restart a quiz.
- Reuse verified investigation when work changes hands, refreshing evidence when an
  affected input changes or an unresolved question needs further investigation.
- Preserve parents by default. When the user authorizes a parent-map update, perform that
  update and verify its native graph and readable index together. Close a parent only when
  its destination is achieved and closure is authorized.
- Use native dependencies, preserve existing issue identities, and verify published bodies,
  labels and relationships by read-back. Use frontier labels when the agreed map requires them.

## Product design

- Preserve Trinity's existing tokens, typography, public components and platform interaction
  models during design audits and targeted fixes. Generic
  prescriptions for font swaps, palette replacements, decorative textures or cinematic motion
  do not authorize replacing the product's design system.
- Implement product design through Trinity's Angular and Spartan boundaries; generic React or
  shadcn examples do not establish a new stack or component API. Use an available image-generation
  capability for screen and flow mockups when it materially helps.
  Preserve agreed behavior, cross-screen consistency and accessibility in every mockup.

## Prototypes and research

- Store standalone prototypes and proof in ignored output. Use an isolated worktree for
  temporary app routes, leaving their prototype changes uncommitted. Record the production
  context in the artifact and preserve evidence as local files or authorized issue/PR attachments.
- Keep prototypes, screenshots, GIFs and pixel baselines out of all commits, including
  throwaway branches. Implement and test the validated design only when implementation is in scope.
- Delegate independent research when a background agent can help alongside useful local work.
  An already assigned research agent performs the research directly; do not recursively
  delegate the same assignment. Use available local tools when delegation is unavailable.

## Review and conflict resolution

- Include staged, unstaged and relevant untracked changes when reviewing work in progress.
  A comparison ending at `HEAD` alone omits those changes. Give each reviewer the same complete
  artifact and record its comparison base and scope.
- Complete the first independent review against that stable artifact. Follow-up review covers
  material changes and their affected behavior; retain the complete evidence while reporting
  compact summaries.
- Follow [Branches and publication](../apps/docs-developers/src/content/docs/contributing/branches-and-commits.md)
  for the default base, temporary integration branches and authorization. A conflict-resolution
  skill does not authorize staging unrelated files or creating commits. Follow a request to stop
  or abort while preserving unrelated work.

## Nx and validation

- Use `pnpm nx`, the repository wrapper, with options verified against the installed CLI.
  See the [canonical commands](../apps/docs-developers/src/content/docs/reference/commands.md) and
  [validation warnings](../docs-internal/maintenance/validation-warnings.md). Discover generators and
  inspect their schema, implementation, file placement and side effects before writing files.
  Prefer a dry run; if unsupported, inspect the writes and stay within the authorized scope.
- Match the existing integrated workspace: Angular, standalone components, SCSS, Vitest,
  `@trinity/*` aliases and Nx boundary tags. Internal libraries are source-consumed unless the
  task needs a separate build. Generic workspace-package advice must not replace those aliases.
- Inspect resolved targets with `nx-workspace`, then follow
  [Choose validation by the change](../apps/docs-developers/src/content/docs/contributing/validate-a-change.md).
  This policy governs test selection and exceptions to generic skills' blanket test requirements.
- Record required checks with their command/target, checked revision or working-tree state,
  relevant environment, exit status and log/artifact location. Reuse a pass only for unchanged
  relevant inputs; repeat when changed code, dependencies, configuration, environment, failures
  or unresolved concerns invalidate it. Required CI gates still run under their own policy.

If a skill requests a dedicated Skill tool that is unavailable, read the named repository-local
`SKILL.md` and follow it with the available tools. Skill examples do not authorize extra commits,
pushes, PRs or external messages.
