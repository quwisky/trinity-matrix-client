# Planning, implementation, and review

The coordinator keeps the user's chosen session model, accepted decisions,
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

The repository-owned definitions record the default model and reasoning effort
for delegated work:

| Role        | Configuration                                                         | Default                 |
| ----------- | --------------------------------------------------------------------- | ----------------------- |
| Planner     | [`.codex/agents/planner.toml`](../.codex/agents/planner.toml)         | `gpt-6-astra`, `high`   |
| Implementer | [`.codex/agents/implementer.toml`](../.codex/agents/implementer.toml) | `gpt-5.6-terra`, `high` |
| Reviewer    | [`.codex/agents/reviewer.toml`](../.codex/agents/reviewer.toml)       | `gpt-6-astra`, `high`   |

These defaults do not change the main session's user-selected model. For a client
that supports named custom agents, ask it to delegate a bounded task to `planner`,
`implementer`, or `reviewer`, then confirm the selected role and model in its result.
The [Codex custom-agent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
specifies that a named file's model and effort take precedence over explicit spawn
arguments. Where those file values are absent, selection falls through spawn
arguments, configured agent defaults, and the parent session. Changing a named
role's defaults means reviewing its TOML; a prompt alone does not replace them.
Project configuration is also subject to [project trust](https://learn.chatgpt.com/docs/config-file/config-reference).

In the coordination runtime inspected for this guide, delegated tasks can receive
explicit model and reasoning arguments, but there is no named-custom-agent field.
A full-history fork cannot combine those overrides; use a bounded context packet.
Explicit Terra/high implementation and Astra/high review were exercised during this
rewrite. The TOMLs and Codex CLI 0.153.4 help were inspected; named-role loading and
the built-in review command were not exercised. When a role or model override is
unavailable, apply its instructions with the available model and record that limit.

[`review_model`](../.codex/config.toml) is independent model-only configuration
for the built-in review feature, as described in the [Codex configuration
reference](https://learn.chatgpt.com/docs/config-file/config-reference). It
currently names `gpt-6-astra`; it does not set reasoning effort and does not
control the `code-review` skill.

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
