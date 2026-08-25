# `.claude/` — Claude Code's corner

The skills and rules catalog lives in [`../.agents/README.md`](../.agents/README.md), and the
skills and rules themselves in `.agents/`. `skills/` and `rules/` here are **symlinks** to those
directories, so Claude Code finds them where it expects while any other agent can read them too.
Edit the files under `.agents/`; the links hold no content.

What is genuinely Claude-specific, and stays here:

- [`CLAUDE.md`](CLAUDE.md) — the Angular/TypeScript style guide, loaded on every session.
- `settings.json` — enabled plugins and marketplaces.
- `RESUME.md` — session scratch notes.

Project-wide instructions are in [`../AGENTS.md`](../AGENTS.md).
