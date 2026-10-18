# Claude-specific configuration

Start with [AGENTS.md](../AGENTS.md). Shared instructions live
in [AGENTS.md](../AGENTS.md); the root [CLAUDE.md](../CLAUDE.md) is a regular forwarding
file, not a symlink.

- [CLAUDE.md](CLAUDE.md) contains the source-change Angular/TypeScript style guide.
- [settings.json](settings.json) declares the Nx plugin and its marketplace, and the hooks below.
- `skills/` and `rules/` are directory symlinks to `.agents/skills` and `.agents/rules`.
  Edit the canonical files under `.agents/`, following the [catalog ownership rules](../.agents/README.md).
- `agents/` holds the subagents below.
- [`.mcp.json`](../.mcp.json) declares two project MCP servers: `nx-mcp` (`npx nx mcp`,
  the workspace's Nx MCP server for projects, targets and Nx docs) and context7
  (`npx -y @upstash/context7-mcp`) for library documentation no installed skill covers
  (matrix-js-sdk, Capacitor, Electron, WebdriverIO/Appium).

## Hooks

| Event                                  | Script                                                  | Effect                                                                                                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`                         | [agent-session-status.mjs](../scripts/agent-session-status.mjs) | Fetches `origin/main` and prints, only when it applies: how far local `main` is behind, a missing `user.email`, and a homeserver lock left by a journey run that has ended. Never blocks. |
| `PreToolUse` `Bash`                    | [agent-guard.mjs](../scripts/agent-guard.mjs)         | Blocks staging `docs/superpowers` or `.superpowers`, `pgrep -f` wait loops, a `git push` whose `node scripts/nx.mjs affected -t typecheck --base=origin/main` fails (branch deletions skip the typecheck), `gh pr create` without `--draft`, and `gh pr ready` when `gh pr checks` does not pass. Also blocks `gh pr merge`, `gh pr review --approve` and ruleset writes (the maintainer runs those, with `! <command>` if they ask an agent); a commit with no configured email, or with a `Release-As` footer or tool attribution; a push to a pull request marked ready; and working-tree git commands (`checkout`, `switch`, `reset --hard`, `stash`, `rebase`, `merge`, `pull`, and similar) while a live journey run or `validate-change --run` holds the checkout's lock. |
| `PreToolUse` `Edit\|Write\|MultiEdit` | [agent-guard.mjs](../scripts/agent-guard.mjs)         | Blocks hand edits to the root `CHANGELOG.md` and to the `version` of `package.json` or `electron/package.json`, which release-please owns. |
| `PostToolUse` `Edit\|Write\|MultiEdit` | [agent-format.mjs](../scripts/agent-format.mjs)       | Runs the repository Prettier on the edited file; skips unsupported and `.prettierignore` paths and never blocks.                                                                                                                                                                       |

To turn a hook off for yourself, set `"disableAllHooks": true` in your untracked
`.claude/settings.local.json`, or remove its entry from `hooks` in `settings.json` for
everyone. `scripts/agent-guard.spec.mjs` covers the guard and `scripts/agent-session-status.spec.mjs` the status.

## Subagents

| Agent                                                     | Model  | Use                                                                                                    |
| --------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| [ci-fixer](agents/ci-fixer.md)                            | Sonnet | Classify a PR's CI failures as branch-caused, pre-existing or flaky; fix and push branch-caused ones. Owner's same-repository PRs only, unless approved. |
| [design-system-reviewer](agents/design-system-reviewer.md) | Sonnet | Read-only review of changed templates and styles against the design-system contracts.                  |

Which instructions or plugins a client loads depends on its runtime and configuration.
Check the available tools; these paths alone do not prove discovery or plugin execution.
There is no tracked session scratch document. Pass verified context directly when work
changes hands.
