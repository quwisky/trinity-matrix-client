---
title: Make your first change
description: Complete a small documentation-only contribution through focused validation.
audience: developer
contentChannel: develop
canonicalTopic: start-first-change
pageType: tutorial
platforms: [web]
---

Use a documentation edit to learn the repository workflow without changing product behavior.

## Choose one owned page {#choose-page}

Pick a page under `apps/docs-developers/src/content/docs/` whose canonical topic matches the fact you need to improve. Keep the page in the `developer` audience and `develop` content channel. Every Markdown heading needs a stable explicit ID such as:

```markdown
## Explain the boundary {#explain-boundary}
```

Do not link public prose to private documentation, agent instructions, temporary plans, generated output, or another site's source tree.

## Preview the developer site {#preview-site}

```bash
pnpm nx serve docs-developers
```

Use the printed local URL to inspect navigation, narrow and wide layouts, light and dark appearance, and link destinations.

## Run focused checks {#focused-checks}

```bash
pnpm nx test docs-site -- content-coverage
pnpm nx run docs-developers:check
pnpm nx run docs-developers:build
pnpm nx run docs-site:check
pnpm format:check
```

These checks cover route metadata, Astro types/content, the production site, public-content boundaries, local links, and formatting. They do not prove product behavior because this journey changes no product code.

## Review the change {#review-change}

Inspect `git diff --check`, the changed page, and the rendered site. Record the commands and actual outcomes. Commit only the files owned by the change, using an imperative Conventional Commit subject such as `docs(developers): clarify workspace navigation`.

Read the [system overview](../../architecture/system-overview/) before moving on to application code.
