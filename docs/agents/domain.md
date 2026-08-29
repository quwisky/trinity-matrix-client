# Domain docs

Trinity uses a single-context domain-documentation layout.

## Before exploring

Read these when they exist and relate to the work:

- `CONTEXT.md` at the repository root
- Relevant ADRs under `docs/adr/`

Proceed silently when they do not exist. The `domain-modeling` skill creates
them lazily when terminology or architectural decisions are resolved.

## Layout

```text
/
├── CONTEXT.md
└── docs/adr/
    └── NNNN-decision-name.md
```

## Vocabulary

Use terms as defined in `CONTEXT.md` in issues, proposals, hypotheses, code, and
tests. Avoid synonyms the glossary explicitly rejects.

An undefined concept may indicate either unsuitable terminology or a genuine
domain-model gap. Reconsider it or record it for `domain-modeling`.

## ADR conflicts

Surface conflicts with existing ADRs explicitly instead of silently overriding
them.
