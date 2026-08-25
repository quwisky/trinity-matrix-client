# CLAUDE.md

**The project instructions live in [`AGENTS.md`](AGENTS.md).** Read that file.

It moved there because this repository is worked on by more than one agent, and
`AGENTS.md` is the name they all look for — keeping the guidance in a Claude-specific file
meant every other tool started from nothing. There is one copy, and it is that one.

Still Claude-specific, and still loaded automatically:

- [`.claude/CLAUDE.md`](.claude/CLAUDE.md) — the Angular/TypeScript style guide.
- [`.agents/README.md`](.agents/README.md) — the skills and rules catalog.
- [`.agents/rules/`](.agents/rules/) — commit conventions, changelog, branch protection.
  (`.claude/rules` is a symlink to it, so Claude Code loads them from where it expects.)
