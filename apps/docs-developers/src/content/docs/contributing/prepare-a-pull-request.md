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

Rebase on the current `main` branch before opening the pull request. Resolve conflicts by preserving current owners and contracts, then rerun checks affected by the resolution.

Inspect the commit list, full diff, untracked files, generated changes, and artifact paths. Do not include screenshots, traces, local configuration, secrets, or unrelated working-tree changes.

## Write the description {#write-description}

Use these sections:

- **What:** one or two sentences describing the behavior change.
- **Why:** the problem or issue being resolved.
- **How:** only when the design is not apparent from the diff.
- **Testing:** exact commands and outcomes, plus tested and untested affected platforms.
- **Evidence:** for UI changes, screenshots of every new or changed state in the dark theme, on both desktop (1280×800) and mobile (390×844), captured against synthetic test data. Attach them to the pull request with `gh pr comment <number> --attach './shot.png#Alt text'` or by dragging them into the description, never as committed files.
- **Notes:** migrations, secrets handling, infrastructure, public API changes, limitations, or follow-ups.

Use `Closes #123` when the pull request resolves an issue and `Refs #123` for related work. Keep the title in Conventional Commit form.

## Hand off honestly {#review-handoff}

Open the pull request as a draft and mark it ready only when it can be merged as it stands: every check is green, the review is finished, and nothing is pending. Return it to draft while new work is in progress. Call out failed, retried, skipped, and unavailable checks. Mention changes to migrations, security boundaries, infrastructure, configuration, or public APIs so reviewers can focus appropriately.

Before marking it ready, have someone other than the author review the final diff: the maintainer, another contributor, or a fresh review agent. Fix the findings that would block a merge and have the fix reviewed, and list the rest in the description or a follow-up issue. Give failing-first evidence for a fix or behavior change. When pull-request CI cannot exercise the change, such as a harness change that only the Synapse nightly runs, dispatch that workflow on the branch and link the run.

The maintainer merges: do not merge or approve the pull request, or bypass the branch rules, unless the maintainer asks you to.

## Stack dependent pull requests {#stacked-pull-requests}

Base a pull request that needs another one on that pull request's branch, and keep it a draft until the parent merges. Pull requests are squash-merged, so then fetch, rebase the branch with `git rebase --onto origin/main <parent commit it sits on> <branch>`, retarget it with `gh pr edit <number> --base main` if GitHub has not, rerun the affected checks, and push with `git push --force-with-lease`. Restacking your own stack this way is coordinated history rewriting.

## Change someone else's pull request {#others-pull-requests}

Review a pull request someone else opened when asked, and change it only when asked. Add commits on top. Rewrite its history only when asked to, with `git push --force-with-lease=<branch>:<reviewed commit>` so that a push you have not seen is never overwritten, and say in the description what you rewrote.

## After the merge {#after-merge}

Once the maintainer merges the pull request, remove its worktree if it is clean and delete the local branch. Then check the CI run for the merge commit on `main`. When a newer push lands on `main`, CI cancels the older run and the newer run covers both. Fix a failure in a new pull request.

Read [validate a change](../validate-a-change/) and [branches and commits](../branches-and-commits/) before publishing the branch.
