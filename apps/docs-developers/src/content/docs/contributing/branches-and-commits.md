---
title: Branches and commits
description: Base contributions on main and create small Conventional Commits without disturbing unrelated work.
audience: developer
contentChannel: develop
canonicalTopic: contributing-branches-commits
pageType: how-to
platforms: [web, desktop, android, ios]
---

Use `main` as the normal branch base and pull-request target. A different integration base applies only when the task explicitly requires it.

## Create a scoped branch {#create-branch}

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git switch -c docs/short-description
```

Use `type/short-kebab-description`, adding the issue number when one exists. Keep unrelated active work in another worktree and never discard changes you do not own.

## Commit one logical change {#commit-change}

Use `type(scope): imperative subject`. The subject begins lowercase, has no trailing period, and stays within 72 characters. Common types include `feat`, `fix`, `docs`, `test`, `build`, `ci`, and `chore`. `release` is reserved for release-please's release pull requests, titled `release: cut the vX.Y.Z release`.

Stage only task-owned files, inspect the staged diff, and commit after its relevant checks pass:

```bash
git diff --check
git diff --cached
git commit -m "docs(developers): clarify Matrix test ownership"
```

Use a body when the motivation or behavior change is not self-evident. Mark breaking changes with `!` and a `BREAKING CHANGE:` footer. Do not add tool attribution or generated-by footers.

## Release lines {#release-lines}

`main` is the integration branch: pull requests target it and prereleases are cut from it. A stable line lives on a `release/X.Y.x` branch, cut by a maintainer from a tested prerelease. Release branches accept only fixes, through pull requests; open the same fix against `main` too, or let the automatic back-merge pull request carry it. release-please keeps a release pull request open on each branch: merging it on `main` cuts an `X.Y.Z-next.N` prerelease, and merging it on `release/X.Y.x` cuts a stable patch release and updates `CHANGELOG.md`. `feat`, `fix`, `perf` and `revert` subjects become the release notes, so write them for users.

Never edit versions or `CHANGELOG.md` by hand, and do not add `Release-As` footers: every release line reads them. Maintainers cut release branches and merge release pull requests; publishing and the back-merge to `main` then happen automatically.

To get a merged `main` fix onto a release line, add the label `backport release/X.Y.x` to its pull request. Once the pull request is merged, a workflow opens a backport pull request into that branch automatically; review and merge it. If the fix cannot be cherry-picked cleanly, the workflow comments on your pull request with the commands to backport it by hand.

Do not rewrite pushed history without explicit coordination. Continue with [prepare a pull request](../prepare-a-pull-request/).
