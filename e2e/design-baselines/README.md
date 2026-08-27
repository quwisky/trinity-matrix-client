# Current application design evidence

This directory records the Phase 0 “before” state for the
[modern UI redesign](../../docs/architecture/modern-ui-redesign.md). Unlike the proposed static
scenes in `e2e/design-prototypes/`, this suite drives Trinity's real built Angular application
against disposable Synapse.

The PNGs under `archive/` are historical evidence, not visual-regression baselines. They remain
unchanged while later phases intentionally redesign the application. The normal test target still
drives every surface and checks semantic readiness, responsive ownership, horizontal overflow,
primary-control reachability and the absence of recovery-key content.

## Evidence matrix

All three profiles run the signed-out login, room shell, appearance settings and safe encryption
setup introduction. The archive keeps all four primary desktop/phone captures plus room/settings
captures at the compact desktop height that has historically exposed settings scroll defects.

| Profile         | CSS viewport | Archived surfaces                         |
| --------------- | ------------ | ----------------------------------------- |
| desktop-wide    | 1440x900     | login, room, appearance, encryption intro |
| desktop-compact | 900x700      | room, appearance                          |
| phone-pixel-5   | 393x727      | login, room, appearance, encryption intro |

Each profile owns fixed disposable reader/sender accounts and three deterministic rooms. The
sender posts before the reader signs in, leaving long names, previews, unread counts and a mention
for the real initial sync to project. One stepped journey per profile avoids multiple crypto
devices or cross-test account-data bleed.

## Run and promote

Docker is required because the suite owns the repository's fixed-port Synapse stack. Run it
manually; it is intentionally not in the PR workflow until its extra build, Synapse boot and three
UI logins have been measured.

```bash
pnpm e2e:design:current
pnpm e2e:design:current:update
```

Every green run writes 12 ephemeral screenshots and its Playwright report under
`dist/.playwright/current-baselines/`. The update command then validates the complete expected set
and atomically replaces the 10-file Linux archive. A failed or partial journey cannot leave a
half-updated tracked archive.

`archive/manifest.json` records the source commit, exact Playwright/Chromium/Node/Linux environment,
canonical viewport values and the two normalized volatile strings. The current application keeps
its real system-font policy; no replacement font is injected, so these non-gating images document
their precise generation environment instead of claiming cross-distribution pixel identity.

## Security and scope

- Accounts and passwords are fixed only inside disposable local Synapse and are not read from a
  developer environment.
- The login capture has empty credential fields.
- The encryption capture stops at the untouched setup introduction, asserts that no recovery key
  exists, and never clicks **Set up encryption**.
- Retained failure traces are short-lived build artifacts and are not promoted.
- The suite lives outside `e2e/playwright/` because these archival browser captures are not product
  journeys requiring Android parity. Real behavior shared with Android remains in the canonical
  app-journey directory.

This archive closes only the current-state evidence deliverable. Phase 0 still requires human
approval of the proposed desktop and phone candidates before the Phase 1 token targets are final.
