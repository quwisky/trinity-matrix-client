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
| `PreToolUse` `Bash`                    | [agent-guard.mjs](../scripts/agent-guard.mjs)         | Blocks staging `docs/superpowers` or `.superpowers`, `pgrep -f` wait loops, a `git push` whose `node scripts/nx.mjs affected -t typecheck --base=origin/main` fails (branch deletions skip the typecheck), `gh pr create` without `--draft`, and `gh pr ready` when `gh pr checks` does not pass. |
| `PostToolUse` `Edit\|Write\|MultiEdit` | [agent-format.mjs](../scripts/agent-format.mjs)       | Runs the repository Prettier on the edited file; skips unsupported and `.prettierignore` paths and never blocks.                                                                                                                                                                       |

To turn a hook off for yourself, set `"disableAllHooks": true` in your untracked
`.claude/settings.local.json`, or remove its entry from `hooks` in `settings.json` for
everyone. `scripts/agent-guard.spec.mjs` covers the guard.

## Subagents

| Agent                                                     | Model  | Use                                                                                                    |
| --------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| [ci-fixer](agents/ci-fixer.md)                            | Sonnet | Classify a PR's CI failures as branch-caused, pre-existing or flaky; fix and push branch-caused ones.  |
| [design-system-reviewer](agents/design-system-reviewer.md) | Sonnet | Read-only review of changed templates and styles against the design-system contracts.                  |

Which instructions or plugins a client loads depends on its runtime and configuration.
Check the available tools; these paths alone do not prove discovery or plugin execution.
There is no tracked session scratch document. Pass verified context directly when work
changes hands.
