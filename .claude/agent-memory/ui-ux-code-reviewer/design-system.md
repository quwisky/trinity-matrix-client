---
name: design-system
description: Where Trinity's design tokens, SCSS mixins, and global styles live, plus the Discord-dark conventions to reuse
metadata:
  type: reference
---

Trinity = Angular 20 standalone + Ionic 8, Discord-inspired always-dark theme.

- Color tokens (CSS custom props): `apps/trinity/src/theme/variables.scss`. Surface ramp `--trinity-rail` (darkest) → `--trinity-sidebar` / `--trinity-sidebar-header` → `--trinity-chat` → `--trinity-hover` → `--trinity-active`. Text: `--trinity-text` (#dbdee1), `--trinity-text-muted` (#949ba4), `--trinity-text-bright` (#f2f3f5). Brand `--trinity-accent` #5865f2 (blurple), `--trinity-accent-hover`, `--trinity-green` #23a55a. `--trinity-radius` = 8px. Ionic `--ion-color-primary` is mapped to blurple.
- Shared SCSS mixins: `libs/feature-rooms/src/lib/styles/_mixins.scss` — `ellipsis`, `category-label` (11px/700/uppercase muted), `column($bg)`, `interactive-row` (Discord hover: transparent→`--trinity-hover`, muted→text), `scrollable` (thin rail scrollbar). Import with `@use '../styles/mixins' as *;`.
- Global styles: `apps/trinity/src/global.scss` — only Ionic core CSS + `dark.always.css`. NO app-level resets, NO global `:focus-visible`, NO `prefers-reduced-motion` block. Each component owns its focus styling (and most omit it).
- An `.sr-only` visually-hidden helper exists only locally in `recovery-key-display.component.scss` — there is no shared one.
- Hard-coded hex that escapes the token system (watch for these): `#ed4245` red (channel badge, retry, delete-hover, decryption-fail), avatar palette in `avatar.component.ts`, white `#fff` on accent surfaces.
- Notable spacing scale in use: 4 / 6 / 8 / 12 / 16 px. Sidebar/member columns = 240px, rail = 72px, split-pane side total pinned to 312px, member-list hidden under 1100px, split-pane drawer breakpoint `when="md"`.
