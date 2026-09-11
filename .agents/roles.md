# Planning, implementation, and review

The coordinator uses the active session configuration, preserves accepted decisions,
integration, and authorized publication. Choose a role for substantive work;
handle a short, unambiguous edit directly.

## Select a role

| Role        | Use it for                                                              | Return                                                                                    |
| ----------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Planner     | Investigating requirements or architecture before a change is accepted. | Evidence, unresolved decisions, dependencies, scoped slices, and validation choices.      |
| Implementer | Completing an accepted slice with defined ownership.                    | Changed files, behavior, actual checks, and limits.                                       |
| Reviewer    | Independently checking a frozen artifact.                               | Evidence-backed findings with locations, or a clear no-findings result and review limits. |

Assign one writer to a set of files. Delegate only bounded work that can proceed
independently. The coordinator may prepare integration or inspect dependencies
while that work proceeds, then routes material findings to the implementer.

## Use the configured defaults deliberately

The tracked role files below set model and effort for named roles. This checkout
does not ship `.codex/config.toml`: root defaults, generic subagent defaults and
concurrency come from the active client configuration. Explicit user choices take
precedence; the live tool schema and available slots determine what can run.

| Role | Configuration | Default |
| --- | --- | --- |
| Planner | [planner.toml](../.codex/agents/planner.toml) | Astra/high; retained Trinity planning role |
| Implementer | [implementer.toml](../.codex/agents/implementer.toml) | Luna/medium; retained Trinity implementation role |
| Explorer | [explorer.toml](../.codex/agents/explorer.toml) | Luna/medium; read-only repository exploration |
| Worker | [worker.toml](../.codex/agents/worker.toml) | Luna/medium; bounded implementation |
| Tester | [tester.toml](../.codex/agents/tester.toml) | Luna/medium; focused verification |
| Researcher | [researcher.toml](../.codex/agents/researcher.toml) | Luna/medium; read-only research |
| Reviewer | [reviewer.toml](../.codex/agents/reviewer.toml) | Astra/low; read-only independent review |

Existing planner and implementer names remain available for existing handoffs.
Named roles pin their own model and effort;
update their TOMLs as well as generic defaults when changing routing. Built-in
review uses the active client configuration, independently of the named reviewer role.

Start a new Codex session from a trusted checkout to load project settings.
The root retains the active session's permissions. Worker and tester roles declare
workspace-write; explorer, researcher and reviewer roles declare read-only. Planner
and implementer permissions inherit from the client.
Personal configuration remains outside this installation. If the client does not
expose named roles, supply the role instructions and configured model through its
available delegation interface and report any unsupported selection.

## Superpowers dispatch

Use this mapping when a process skill requests a subagent; keep its task-specific
brief and acceptance criteria alongside the [handoff](#handoffs).

| Superpowers assignment | Trinity role |
| --- | --- |
| Requirements, architecture or plan investigation | `planner` |
| Locate symbols, callers or existing tests | `explorer` |
| Verify external APIs or version-specific facts | `researcher` |
| Implement an accepted slice | `implementer` (`worker` for a narrow coding task) |
| Reproduce a failure or run independent validation | `tester` |
| Task spec compliance and code quality; final review | `reviewer` |

With Codex, dispatch named roles using `agent_type` and `fork_turns: "none"`.
Supply the exact worktree, bounded scope, owned files, accepted requirements,
applicable references and evidence paths. Named roles already pin model and effort;
use an explicit supported model/effort pair only when deliberately overriding the
role or when the client lacks named roles. Never assume full-history forks accept
the same parameters. The active tool schema is authoritative.

Keep one writer per file set, and parallelize only independent work while the
coordinator has useful work to do. Reuse the implementer for fix rounds with
`followup_task` when exposed. Keep child assignments non-recursive and respect
live capacity rather than a hardcoded thread count.

A task reviewer checks both spec compliance and code quality on the same frozen
artifact. Include base/head, staged and unstaged diff, relevant untracked contents,
and validation evidence; commit-only review packages are insufficient for
uncommitted work. The reviewer verifies implementation claims against the actual
files, reports the two verdicts, and names anything it cannot verify. Follow-up
review covers the fixes and affected behavior; final review covers integration.
The coordinator handles authorized commits and publication after review.

## Upstream installation and maintenance

The role defaults were adapted from [donvito/codex-astra-luna-orchestrator](https://github.com/donvito/codex-astra-luna-orchestrator)
at commit `84a2d194b7c10c60c7ba67c8136130797bf47044` (Apache-2.0).
The upstream [license](LICENSE.astra-luna) is retained for the role configurations.

Trinity adds repository instruction pointers and publication ownership to the roles
and retains planner and implementer compatibility. For updates,
compare the pinned revision with the desired upstream revision and merge only
these files; the upstream installer would replace existing configuration and
repository guidance. Update this revision and the changelog, parse every TOML,
and validate with the installed Codex CLI before publication. Named-role execution
requires a separate live session to verify.

## Work in sequence

1. **Plan when needed.** Reuse accepted decisions and current evidence. Ask
   again only when a material scope change or unresolved decision requires it.
   The planner returns slices that another person can implement and test.
2. **Implement an accepted slice.** Give the implementer file ownership,
   acceptance criteria, applicable references, and the handoff below. They
   change only that slice, select validation from repository policy, and report
   what actually happened.
3. **Freeze and review.** Record the comparison base and head plus staged,
   unstaged, and relevant untracked files. The reviewer inspects this stable
   artifact independently against the requirements and repository rules.
4. **Resolve and re-check.** The coordinator routes material findings to the
   implementer, verifies affected behavior, and requests focused follow-up
   review. Track unrelated concerns separately.
5. **Publish when authorized.** The coordinator keeps prior authorization for
   the same necessary reviewable work; it does not ask again merely because a
   plan or handoff was reused. New external actions remain the coordinator's
   responsibility and need the authorization required by repository policy.

## Handoffs

Use this single compact template for a substantive handoff. Replace bracketed
text, keep full logs at their existing paths, and link to the evidence needed
to act on the next step.

```text
Task: [outcome and bounded scope]
Status: [planned | implementing | ready for review | blocked] — [what changed or remains]
Decisions and authorization: [accepted decisions; authorized work; unresolved decision, if any]
Worktree and revision: [directory] — [branch] — base [commit] — head [commit] — patch [clean | staged/unstaged/untracked paths]
Ownership: [files/capability owned by this handoff]
Evidence and revision: [source/config/issue links and the revision they describe]
Validation: [command or check] — [pass/fail/not run] — [environment/log or artifact path]
Limits: [unavailable host, unrun check, stale or unresolved evidence]
Next owner and action: [role/person] — [specific next action]
```

The receiver reuses the packet while its relevant inputs remain unchanged.
Refresh validation or investigation after changed code, dependencies,
configuration, environment, a failure, or an unresolved concern. A handoff
does not transfer publication ownership: the coordinator handles authorized
commits, pushes, issue updates, and pull requests.
