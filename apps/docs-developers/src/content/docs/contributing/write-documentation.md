---
title: Write documentation
description: Maintain the separate release user guide and develop-branch developer guide without publishing private material.
audience: developer
contentChannel: develop
canonicalTopic: contributing-write-documentation
pageType: how-to
platforms: [web]
---

Trinity publishes two English Starlight sites. The user guide describes only the latest published release; the developer guide describes `develop`. Until the first release, the user site contains only its work-in-progress page.

## Choose the channel {#choose-channel}

Put released product procedures in `apps/docs-users/src/content/docs/` only after the release manifest names that version. Put current architecture, development, testing, platform, contribution, and reference material in `apps/docs-developers/src/content/docs/`.

Do not publish maintainer procedures, credentials, agent instructions, temporary plans, historical validation, or private operational details. Shared code under `tools/docs/` owns presentation and validation, not public prose.

## Author a stable page {#author-page}

Use a stable slug, one unique `canonicalTopic`, the correct audience and channel metadata, and explicit heading IDs. Link to one canonical explanation instead of copying it into several pages. Keep commands separate from claims about what their successful result proves.

## Validate both source and output {#validate-docs}

```bash
pnpm nx test docs-site
pnpm nx run docs-site:check
pnpm nx run docs-site:assemble
pnpm format:check
```

The checks validate schemas, route coverage, headings, local links, public/private boundaries, source-derived reference facts, clean site builds, and the assembled Pages artifact. Preview the affected site for navigation and layout changes.

Public URL compatibility pages are intentionally not maintained. Update links to the new canonical route instead.
