---
name: pr-evidence
description: Capture dark-theme phone and desktop screenshots of app routes with Playwright and attach them to a pull request. User-invoked only.
disable-model-invocation: true
argument-hint: <pr-number> <route>...
---

# PR screenshot evidence

Attach dark-theme phone (Pixel 5) and desktop (1440×900) screenshots of each changed
state to a pull request. Screenshots are evidence, never repository content: keep them
in ignored `dist/` or a scratch directory and never stage or commit them.

Arguments: `$ARGUMENTS` (PR number, then routes such as `/rooms` or `/settings/appearance`).

1. Start the development server if it is not running (`pnpm start`, default
   `http://localhost:4200`), or point `--base` at the running one.
2. Capture each route in both profiles:

   ```bash
   node .agents/skills/pr-evidence/capture.mts --base http://localhost:4200 \
     --out dist/pr-evidence/<pr> /rooms /settings/appearance
   ```

   For signed-in routes, add `--hs <homeserver> --user <name> --pass <password>`; the
   script logs in through the UI with the browser journeys' `login` helper. A disposable
   homeserver from `pnpm e2e:verify:up` works; stop it with `pnpm e2e:verify:down`.
   The script prints one PNG path per route and profile.
3. For a state a route alone cannot reach (an open dialog, a hover menu), extend a
   scratch copy of the script with the interaction, or drive it with `playwright-cli`
   using the same dark scheme and viewports from `e2e/browser/support/design-viewports.mts`.
4. Look at every image before attaching; recapture blank, loading or error frames.
5. Attach them in one comment, with alt text naming each state after `#`:

   ```bash
   gh pr comment <pr> --body "Dark theme, phone and desktop" \
     --attach 'dist/pr-evidence/<pr>/rooms-phone-pixel-5-dark.png#Rooms, phone, dark' \
     --attach 'dist/pr-evidence/<pr>/rooms-desktop-wide-dark.png#Rooms, desktop, dark'
   ```

6. Confirm `git status` shows no PNG files staged.
