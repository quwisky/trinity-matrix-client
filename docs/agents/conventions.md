# Apply source conventions

Read [contributor conventions](../contributing/conventions.md) before a source edit,
[Angular/TypeScript style](../../.claude/CLAUDE.md) for language and framework choices,
and [code quality](../../.agents/rules/code-quality.md) when a file needs splitting.
These are the canonical rules; use the following pointers when a change reaches a
known pitfall.

| Change reaches                                                | Contract to inspect                                                                                                                                                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component API, template, form, selector, or test hook         | [Component conventions](../contributing/conventions.md#components-templates-and-forms) and [style/interaction hooks](../contributing/conventions.md#styles-and-interaction-hooks)                         |
| Helm or a new vendor dependency                               | [UI and theming](../architecture/ui-and-theming.md): public tier, generator ownership, existing-alias handling, and recorded vendor overrides                                                             |
| Theme, danger ink, Markdown styles, or an ineffective utility | [UI and theming](../architecture/ui-and-theming.md): semantic roles and layered/unlayered cascade                                                                                                         |
| Responsive layout, safe areas, overlay, or touch interaction  | [Feature geometry and interaction contracts](../architecture/ui-and-theming.md#preserve-feature-geometry-and-interaction-contracts): inset ownership, OS versus pointer predicates, and desktop detection |
| Commit, branch, version, or changelog                         | [Publication conventions](../contributing/conventions.md#branches-and-publication) and adjacent commit/release sections                                                                                   |

Preserve the source guards and read their explanations before changing a guarded
contract. Select proof from [Testing](../contributing/testing.md), using a browser
for rendered CSS and the relevant host for native behavior.
