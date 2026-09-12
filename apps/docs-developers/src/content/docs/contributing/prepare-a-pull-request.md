---
title: Prepare a pull request
description: Rebase, verify, describe, and hand off a focused Trinity contribution for review.
audience: developer
contentChannel: develop
canonicalTopic: contributing-prepare-pull-request
pageType: how-to
platforms: [web, desktop, android, ios]
---

A pull request should present one reviewable concern with evidence that matches its affected behavior.

## Prepare the branch {#prepare-branch}

Rebase on the current `develop` branch before opening the pull request. Resolve conflicts by preserving current owners and contracts, then rerun checks affected by the resolution.

Inspect the commit list, full diff, untracked files, generated changes, and artifact paths. Do not include screenshots, traces, local configuration, secrets, or unrelated working-tree changes.

## Write the description {#write-description}

Use these sections:

- **What:** one or two sentences describing the behavior change.
- **Why:** the problem or issue being resolved.
- **How:** only when the design is not apparent from the diff.
- **Testing:** exact commands and outcomes, plus tested and untested affected platforms.
- **Notes:** migrations, secrets handling, infrastructure, public API changes, limitations, or follow-ups.

Use `Closes #123` when the pull request resolves an issue and `Refs #123` for related work. Keep the title in Conventional Commit form.

## Hand off honestly {#review-handoff}

Call out failed, retried, skipped, and unavailable checks. Mention changes to migrations, security boundaries, infrastructure, configuration, or public APIs so reviewers can focus appropriately. Do not merge the pull request as part of preparation.

Read [validate a change](../validate-a-change/) and [branches and commits](../branches-and-commits/) before publishing the branch.
