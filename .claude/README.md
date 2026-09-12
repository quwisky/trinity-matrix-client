# Claude-specific configuration

Start with [AGENTS.md](../AGENTS.md). Shared instructions live
in [AGENTS.md](../AGENTS.md); the root [CLAUDE.md](../CLAUDE.md) is a regular forwarding
file, not a symlink.

- [CLAUDE.md](CLAUDE.md) contains the source-change Angular/TypeScript style guide.
- [settings.json](settings.json) declares the Nx plugin and its marketplace.
- `skills/` and `rules/` are directory symlinks to `.agents/skills` and `.agents/rules`.
  Edit the canonical files under `.agents/`, following the [catalog ownership rules](../.agents/README.md).

Which instructions or plugins a client loads depends on its runtime and configuration.
Check the available tools; these paths alone do not prove discovery or plugin execution.
There is no tracked session scratch document. Pass verified context directly when work
changes hands.
