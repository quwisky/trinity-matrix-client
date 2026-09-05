# Trinity skill overrides

Read this with planning, review, research, prototype, product-design and Nx skills. These repository rules
specialize the generic upstream workflows; maintain them here instead of editing installed
skills. User instructions and accepted authorization govern the task.

## Planning and tickets

- Reuse accepted decisions and confirmation from the conversation. Ask again only for an
  unresolved decision or material scope change; invoking another skill does not restart a quiz.
- Preserve parents by default. When the user authorizes a parent-map update, perform that
  update and verify its native graph and readable index together. Close a parent only when
  its destination is achieved and closure is authorized.
- For Wayfinder, read `docs/agents/issue-tracker.md`. Older maps may use `Goal` and
  `Program rules` for `Destination` and `Notes`. Preserve an explicitly approved execution
  destination and record the mode in Notes when authorized to update the map. A task label
  alone does not authorize implementation. Resolve one non-research ticket per session.
- Use native dependencies, preserve existing issue identities, and verify published bodies,
  labels and relationships by read-back. Use frontier labels when the agreed map requires them.

## Product design

- Use `redesign-existing-projects` for its audit and targeted-fix workflow. Preserve Trinity's
  existing tokens, typography, public components and platform interaction models. Generic
  prescriptions for font swaps, palette replacements, decorative textures or cinematic motion
  do not authorize replacing the product's design system.
- Use `design-systems`, `visual-hierarchy` and `interaction-design` as conceptual references.
  Implement through Trinity's Angular and Spartan boundaries; generic React or shadcn examples
  do not establish a new stack or component API.
- Use `imagegen-frontend-mobile` for mobile screen and flow mockups. For desktop product
  concepts, use the available general image-generation capability and existing Trinity references.
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
- Follow [Branches and publication](../docs/contributing/conventions.md#branches-and-publication)
  for the default base, temporary integration branches and authorization. A conflict-resolution
  skill does not authorize staging unrelated files or creating commits. Follow a request to stop
  or abort while preserving unrelated work.

## Nx and validation

- Use `pnpm exec nx` with options verified against the installed CLI. Discover generators and
  inspect their schema, implementation, file placement and side effects before writing files.
  Prefer a dry run; if unsupported, inspect the writes and stay within the authorized scope.
- Match the existing integrated workspace: Angular, standalone components, SCSS, Vitest,
  `@trinity/*` aliases and Nx boundary tags. Internal libraries are source-consumed unless the
  task needs a separate build. Generic workspace-package advice must not replace those aliases.
- Inspect resolved targets with `nx-workspace`, then follow
  [Choose validation by the change](../docs/contributing/testing.md#choose-validation-by-the-change).
  This policy governs test selection and exceptions to generic skills' blanket test requirements.

If a skill requests a dedicated Skill tool that is unavailable, read the named repository-local
`SKILL.md` and follow it with the available tools. Skill examples do not authorize extra commits,
pushes, PRs or external messages.
