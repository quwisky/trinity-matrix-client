---
name: recurring-issues
description: Recurring UI/UX and a11y anti-patterns observed across Trinity components, to spot faster next time
metadata:
  type: project
---

Patterns seen repeatedly across the Trinity UI (first full review 2026-06-27). See [[design-system]].

- **No focus-visible styling almost anywhere.** Custom `<button>`s (server rail pills, channel rows, userbar logout, message rows/toolbar, emoji picker, reactions) strip native outline via `interactive-row`/`border:none` and define only `:hover`, never `:focus-visible`. Keyboard users get no focus indicator. Only `encryption-setup` heading has a focus-visible rule. **Why it matters:** keyboard operability is a core a11y requirement; the whole app is effectively unusable by keyboard-only users today.

- **Hover-only affordances with no keyboard/touch path.** Message toolbar and the `.msg__gutter` continuation timestamp are revealed only on `:hover`/`:focus-within` with `opacity:0` + `pointer-events:none`. On touch there is no hover, so reply/edit/delete/react are unreachable.

- **Native browser dialogs used for app UI.** `window.confirm('Delete this message?')` in message-list and the `AlertController` password prompt — jarring against the custom dark theme. Prefer themed Ionic alert/action-sheet.

- **No h1 / heading hierarchy on most pages.** Auth login, rooms shell, sso-callback rely on `ion-title` (not a heading). Crypto pages do use a styled `<h1 class="heading">`. No skip-link/landmark consistency.

- **Async states under-announced.** Spinners (`ion-spinner`) lack `aria-busy`/live-region text; new incoming messages aren't announced; sync state changes silent. `recovery-key-display` and `encryption-banner` are the good examples to copy (role=status + aria-live).

- **Emoji/markdown contrast risk on dark.** `--trinity-text-muted` (#949ba4) on dark surfaces for secondary text, reaction counts, timestamps — verify 4.5:1 in context (some likely borderline at small sizes).

- **Disabled-state and loading affordances are minimal** on Ionic buttons (default opacity) and the composer has no send button (Enter-only), which hurts discoverability/touch.
