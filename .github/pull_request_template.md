<!--
Trinity ships from one codebase to Web, Desktop, Android and iOS, and it is
end-to-end encrypted. The prompts below are the things a reviewer here always ends
up asking for — filling them in up front is what gets a PR reviewed quickly.

Keep the parts that apply, delete the rest. A one-line docs or dependency change
does not need every heading.
-->

## What and why

<!-- What this changes, and the problem it solves — not a restatement of the diff.
Link the issue it closes (`Closes #123`) if there is one. -->

## How it works

<!-- The design decisions a reviewer can't read off the diff: the approach you chose
and what you ruled out, any non-obvious constraint, the tricky bit you'd point at in
person. Skip for a trivial change. -->

## Platforms

<!-- Tick every target the change actually runs on. `isNativePlatform()` is false in
Electron, service workers and push are off on desktop, and native builds go through
Capacitor — so a change is often correct on one target and broken on another. -->

- [ ] Web (browser / PWA)
- [ ] Desktop (Electron)
- [ ] Android
- [ ] iOS
- [ ] Not platform-specific

## Verification

<!-- What you actually ran, and what it showed — not "tests pass" but which. -->

- [ ] `pnpm lint` and `pnpm test`
- [ ] `pnpm build` (production build / AOT template typecheck)
- [ ] `pnpm stylelint` (only if SCSS changed — it is not part of `pnpm lint`)
- [ ] End-to-end (`pnpm nx e2e trinity-e2e`, or a named `pnpm e2e:*` flow) — needs Docker
- [ ] Ran it by hand (say where: `pnpm start`, a device, the desktop shell)

<!-- If a check doesn't apply or you couldn't run it (e.g. no Docker locally), say so
plainly rather than leaving it unticked in silence. -->

## Checklist

- [ ] Commits follow Conventional Commits (`type(scope): subject`) — the `commit-msg` hook enforces it
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]` (any user-visible change; see `.agents/rules/docs/changelog.md`)
- [ ] Docs updated if setup, commands or a public API changed (README / `docs/*`)
- [ ] No new component imports `matrix-js-sdk` directly — SDK access stays in a `@trinity/data-access/*` service
- [ ] No secrets, access tokens, recovery keys or real message content in the diff, tests or fixtures

<!--
Security: anything touching encryption, key handling, sessions or transport is
sensitive. If this PR could weaken any of those, say so explicitly here — and if it is
a *fix* for such a flaw, coordinate a private disclosure first (see the security
contact link when opening an issue) rather than describing the hole in the open.
-->
