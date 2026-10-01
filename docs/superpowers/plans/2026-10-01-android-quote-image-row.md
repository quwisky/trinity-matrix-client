# Android quote suite: find the image row by its image

**Spec:** none — follow-up to #836 / PR #850 (merged to develop and into this branch at b6175e9b).

## Context

Since #850, an `m.image` without `info` renders as an image (`trn-media-bubble` →
`<button class="media media--image" aria-label="Open image shot.png">` with
`<img alt="shot.png">`) instead of a download tile showing the filename as text.
The browser predecessor `e2e/browser/journeys/conversations/message-quote.spec.mts`
already finds the row with `has: getByRole('button', { name: 'Open image shot.png' })`.
The Android suite (`e2e/android/message-quote-*.mts`) still finds the image row by
the text `shot.png` in the row's textContent, so it will fail on the device.

## Global Constraints

- Keep the repository's id-free selectors and the shared strict scrub; no Matrix ids,
  tokens or passwords in artifacts.
- The image row must still be proved to be the fixture `m.image` event, with exactly
  one media attachment, rendered as an image (`media--image`), and no message text.
- The long-press that opens the action sheet must target the image row.
- The `scripts/*-migration.spec.mjs` ledgers were deleted on this branch; do not
  recreate them.
- Validation: `pnpm nx run trinity-e2e-android:message-quote` passes on the emulator
  (see `e2e/android/MIGRATION.md` "Run and inspect"), plus typecheck of the e2e project
  and `pnpm nx test scripts`.

## Task 1: Target the image row by its rendered image

Files: `e2e/android/message-quote-contract.mts` (`assertImageRow`, its doc comment,
the observer fields it needs), `e2e/android/message-quote-observer.mts` (record what
identifies the image, e.g. the media button's accessible name), and
`e2e/android/message-quote-journeys.mts` (the image-row long-press at the
`openSheet(..., { text: QUOTE_IMAGE_FILENAME }, 'image-sheet-ready')` call).
Update the `e2e/android/MIGRATION.md` message-quote passage that says the fixture
renders as a "named download tile". Run the suite on the emulator once, green.
