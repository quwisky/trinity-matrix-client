# Planning, implementation, and review

The coordinator uses the configured Astra default, preserves accepted decisions,
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

The project configuration in [`.codex/config.toml`](../.codex/config.toml) sets
Astra/high for the root, Luna/medium for generic execution subagents, and six
concurrent child threads. Explicit user choices take precedence.

| Role | Configuration | Default |
| --- | --- | --- |
| Planner | [planner.toml](../.codex/agents/planner.toml) | Astra/high; retained Trinity planning role |
| Implementer | [implementer.toml](../.codex/agents/implementer.toml) | Luna/medium; retained Trinity implementation role |
| Explorer | [explorer.toml](../.codex/agents/explorer.toml) | Luna/medium; read-only repository exploration |
| Worker | [worker.toml](../.codex/agents/worker.toml) | Luna/medium; bounded implementation |
| Tester | [tester.toml](../.codex/agents/tester.toml) | Luna/medium; focused verification |
| Researcher | [researcher.toml](../.codex/agents/researcher.toml) | Luna/medium; read-only research |
| Reviewer | [reviewer.toml](../.codex/agents/reviewer.toml) | Astra/low; read-only independent review |

The [astra-orchestrator skill](skills/astra-orchestrator/SKILL.md) supplies the
role-selection and delegation workflow. Existing planner and implementer names
remain available for existing handoffs. Named roles pin their own model and effort;
update their TOMLs as well as generic defaults when changing routing. The separate
review_model setting keeps built-in review on Astra.

Start a new Codex session from a trusted checkout to load project settings.
The root uses upstream's workspace-write and on-request defaults; execution roles
use workspace-write and exploration/research/review roles use read-only.
Personal configuration remains outside this installation. If the client does not
expose named roles, supply the role instructions and configured model through its
available delegation interface and report any unsupported selection.

## Upstream installation and maintenance

Installed from [donvito/codex-astra-luna-orchestrator](https://github.com/donvito/codex-astra-luna-orchestrator)
at commit `84a2d194b7c10c60c7ba67c8136130797bf47044` (Apache-2.0).
The upstream license is retained beside the imported skill. This is a manually
vendored integration, separate from CLI-managed skills-lock.json imports.

The skill and role defaults come from upstream. Trinity adds repository instruction
pointers and publication ownership to the roles, retains planner and implementer
compatibility, and merges orchestration guidance into AGENTS.md. For updates,
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
