---
title: Branches and commits
description: Base contributions on develop and create small Conventional Commits without disturbing unrelated work.
audience: developer
contentChannel: develop
canonicalTopic: contributing-branches-commits
pageType: how-to
platforms: [web, desktop, android, ios]
---

Use `develop` as the normal branch base and pull-request target. A different integration base applies only when the task explicitly requires it.

## Create a scoped branch {#create-branch}

```bash
git fetch origin
git switch develop
git pull --ff-only origin develop
git switch -c docs/short-description
```

Use `type/short-kebab-description`, adding the issue number when one exists. Keep unrelated active work in another worktree and never discard changes you do not own.

## Commit one logical change {#commit-change}

Use `type(scope): imperative subject`. The subject begins lowercase, has no trailing period, and stays within 72 characters. Common types include `feat`, `fix`, `docs`, `test`, `build`, `ci`, and `chore`.

Stage only task-owned files, inspect the staged diff, and commit after its relevant checks pass:

```bash
git diff --check
git diff --cached
git commit -m "docs(developers): clarify Matrix test ownership"
```

Use a body when the motivation or behavior change is not self-evident. Mark breaking changes with `!` and a `BREAKING CHANGE:` footer. Do not add tool attribution or generated-by footers.

Do not rewrite pushed history without explicit coordination. Continue with [prepare a pull request](../prepare-a-pull-request/).
