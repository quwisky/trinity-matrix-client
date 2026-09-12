# Agent catalog and maintenance

Start with [AGENTS.md](../AGENTS.md), then use this catalog to select a skill or
maintain its installation. Load the selected
`SKILL.md` and only the supporting references its task requires; if the client has
no skill invocation tool, read the file with the tools it exposes.

## Ownership and discovery

[AGENTS.md](../AGENTS.md) provides shared instructions and conditional references.
[skill overrides](skill-overrides.md) adapt upstream workflows to Trinity.
Roles select work responsibilities and model defaults; skills supply task guidance.

The checkout contains **19 CLI-managed skill imports and four local skill entrypoints**.
The [lockfile](../skills-lock.json) records managed sources, source paths, and content
hashes; it does not record immutable commit references. Keep managed files under CLI
ownership and put Trinity-specific behavior in the overrides. The four local
references below are maintained directly in this repository.

`.claude/skills` and `.claude/rules` are directory symlinks to the canonical `.agents/`
folders. Discovery and automatic loading depend on the client. Use the explicit
paths below for the three nested UX entrypoints; CLI listing alone does not prove
that an agent loaded a skill.

## Superpowers process skills

Use the active client's installed `superpowers:*` skills for planning, debugging,
execution and review. They are separate from the repository-managed imports below.
[Trinity overrides](skill-overrides.md#superpowers-integration) map task states to
process skills; Load the process skill for the current stage plus
only the domain skills needed by the task.

## Select a managed skill

| Skill                                                                    | Task                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| [research](skills/research/SKILL.md)                                     | Investigate a question using primary sources.                     |
| [nx-workspace](skills/nx-workspace/SKILL.md)                             | Find projects, resolved targets, and dependencies.                |
| [nx-generate](skills/nx-generate/SKILL.md)                               | Inspect generators before scaffolding.                            |
| [nx-run-tasks](skills/nx-run-tasks/SKILL.md)                             | Run the resolved Nx targets needed by the change.                 |
| [angular-developer](skills/angular-developer/SKILL.md)                   | Implement Angular behavior within Trinity ownership.              |
| [spartan](skills/spartan/SKILL.md)                                       | Work with the generated vendor tier through its CLI.              |
| [vitest](skills/vitest/SKILL.md)                                         | Write or diagnose unit tests.                                     |
| [playwright-best-practices](skills/playwright-best-practices/SKILL.md)   | Write or diagnose meaningful browser journeys.                    |
| [playwright-cli](skills/playwright-cli/SKILL.md)                         | Drive an available browser interaction tool.                      |

Keep the catalog focused on building and maintaining the Trinity client. Branding,
marketing-page workflows, fixed visual presets, and generic reference sheets belong
outside it. For product design, read the [design overrides](skill-overrides.md#product-design)
and preserve Trinity tokens, public components, interaction models, and accessibility.
A skill mentioning an external service does not require installing or paying for it.

## Use a repository-owned reference

| Reference                                                   | Task                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------- |
| [Electron](skills/electron/SKILL.md)                        | Trace desktop host capabilities, IPC, storage, packaging, or signing. |

## Maintain managed imports

Run the [skills CLI](https://github.com/vercel-labs/skills) with pnpm from the repository.
Inspect the installed catalog and current help before an authorized change:

```bash
pnpm dlx skills --version
pnpm dlx skills --help
pnpm dlx skills list --json
```

For an explicitly requested addition or update, examples supported by the inspected
CLI help are:

```bash
pnpm dlx skills add angular/angular --skill angular-developer --agent codex --yes
pnpm dlx skills update angular-developer vitest --project --yes
```

`add` defaults to project scope; `--project` makes update scope explicit. Use global
scope only for a requested global installation. Update only the requested names,
then inspect their files, supporting references, links, and lockfile diff. Preserve
local references and shared symlinks. The version/help/list commands were exercised
for this guide; add/update examples were inspected, not executed. The unpinned
`pnpm dlx` invocation can resolve a newer CLI, so recheck its help when maintaining.

## Maintain local rules and configuration

Edit local guidance through normal review.
and put detailed conditional guidance behind the existing task pointers rather than
expanding always-loaded instructions.

| Rule                                                      | When it applies                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| [Code quality](rules/code-quality.md)                     | Split responsibilities while treating file size as a soft signal. |
| [Branch protection](rules/git/branch-protection.md)       | Choose the authorized base and publication workflow.              |
| [Conventional commits](rules/git/conventional-commits.md) | Prepare an authorized commit.                                     |
| [Semantic versioning](rules/git/semver.md)                | Prepare a coordinated release version change.                     |
| [Changelog](rules/docs/changelog.md)                      | Record meaningful impact before final validation.                 |
| [README accuracy](rules/docs/readme-accuracy.md)          | Update affected entry-point claims and navigation.                |
