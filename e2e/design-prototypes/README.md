# Modern UI design prototypes

These static scenes are non-shipping design tools for the
[modern UI redesign](../../docs/architecture/modern-ui-redesign.md). They render against the
built application's real global stylesheet and semantic tokens, but no application route,
production bundle or public component exports them.

## Design direction

This is a preservation-first redesign of a cross-platform Matrix communication app. It keeps
Trinity's information architecture and brand accent while testing a quieter, more layered,
Discord-inspired product language.

- Design variance: 4. Familiar structure with measured asymmetry only where it helps hierarchy.
- Motion intensity: 3. Static reference captures with ordinary hover, focus and press feedback.
- Visual density: 7. Conversation content stays information-rich without shrinking touch targets.

The workspace prototype covers a long workspace, room and account name, unread and mention
badges, a busy timeline, an empty room and a reconnecting error. The settings prototype covers a
bounded desktop workspace, a phone drill-in view, an appearance preview and grouped form rows.
Authentication and encryption redesign candidates remain Phase 6 work; Phase 0 captures their
current application state without proposing replacement layouts.

## Canonical viewport matrix

The source of truth is
[`design-viewports.mts`](../playwright/support/design-viewports.mts). Desktop profiles use a
desktop user agent. Phone profiles retain Playwright's full Pixel 5 device descriptor, including
its mobile user agent, touch support, device scale and `isMobile` behavior.

| Profile          | Size     | Purpose                         |
| ---------------- | -------- | ------------------------------- |
| desktop-wide     | 1440x900 | primary desktop design evidence |
| desktop-standard | 1280x720 | common desktop window           |
| desktop-tablet   | 1024x768 | narrow desktop window           |
| desktop-compact  | 900x700  | compact supported shell         |
| phone-pixel-5    | 393x851  | primary phone design evidence   |
| phone-small      | 320x568  | smallest supported phone width  |

## Run and update

```bash
pnpm e2e:design
pnpm exec nx run trinity-e2e:design-e2e -- --update-snapshots
```

Visual baselines are generated on Linux Chromium, which is the repository authority for pixel
comparison. The harness uses fixed local content and times, waits for fonts, disables animation
and carets, and requests reduced motion. Other platforms may inspect the prototypes, but should
not rewrite the committed Linux snapshots because system-font rasterization differs.

The pixel comparisons are supported by semantic checks for landmarks, selected navigation,
accessible action names, status and alert semantics, label associations, text/action contrast,
horizontal overflow, and 44px phone targets. A screenshot is evidence of appearance, not a
replacement for those assertions.

## Approval gate

Automated checks cannot approve product direction. Phase 0 remains open until a human reviewer
checks at least the desktop-wide and phone-pixel-5 captures and records decisions for:

- recessed outer frame and workspace surface;
- person and place shape rules;
- light Trinity, dark Trinity and dark Onyx hierarchy;
- compact-window behavior and phone edge-to-edge behavior;
- settings workspace width, grouping rhythm and phone drill-in layout;
- busy, empty and error-state treatment.
