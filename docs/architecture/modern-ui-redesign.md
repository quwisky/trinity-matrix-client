# Modern UI redesign plan

Status: proposed

This plan modernises Trinity using the interaction and visual-system ideas behind Discord's
2025-2026 refresh while keeping Trinity recognisably its own Matrix client. It is not a request
to reproduce Discord's branding, illustrations, proprietary typeface, or product model.

The reference direction is deliberately practical:

- reduce visual noise and improve legibility;
- let people choose comfortable information density;
- use shape to distinguish people from places and tools;
- keep the composer spacious by moving infrequent actions into a clear insert menu;
- make settings easier to scan and search;
- keep desktop and mobile familiar while respecting each platform's interaction model.

Those goals are consistent with Discord's published
[desktop refresh](https://discord.com/blog/player-release-q12025),
[settings redesign](https://discord.com/blog/a-cornucopia-of-updates-make-discord-on-desktop-fresher-than-a-crisp-fall-breeze),
[cross-platform shape and spacing update](https://discord.com/blog/improving-mobile-with-squircles-styles-and-spacing),
and [mobile navigation work](https://discord.com/blog/you-bar).

## Outcome

The finished app should feel quieter, more cohesive and more responsive without making an
existing user relearn Matrix. The room list remains the home surface, rooms and spaces remain
where they are, keyboard shortcuts remain stable, and no visual phase changes encryption,
notification, account, timeline, or sending semantics.

Success means:

- the application has one clear surface hierarchy across Web, Electron, Android and iOS;
- light, dark, Onyx and named palettes look intentional rather than recoloured;
- Cosy and Compact density affect the entire communication shell, not only message rows;
- people, spaces, rooms, apps and actions have consistent shapes and icon treatment;
- primary actions are obvious and secondary actions remain discoverable without crowding the UI;
- compact windows and phones do not inherit desktop-only spacing or navigation assumptions;
- loading, empty, error, offline, focus, hover, pressed and selected states all look designed;
- the redesign is delivered in small, independently testable changes rather than one theme rewrite.

## Existing foundation

Trinity already has most of the architecture the redesign needs:

- a Discord-shaped room shell with a 72px space rail, resizable room list, timeline and optional
  right panel;
- semantic `--trinity-*` surface, text, spacing, radius, elevation and motion tokens;
- orthogonal mode and palette axes, including Onyx;
- Cosy and Compact density, currently applied mainly to timeline spacing;
- public UI wrappers under `libs/components/*`, with spartan-ng contained behind them;
- a shared page header, avatar, message toolbar, inputs, overlays and empty states;
- coarse-pointer touch targets, reduced-motion handling, safe-area support and mobile master-detail
  navigation;
- Playwright coverage for desktop, Pixel 5 profiles, Electron, Android, text scaling, contrast,
  pane resizing, gestures and settings scroll ownership.

The redesign should extend these systems. It should not introduce a second token vocabulary,
bypass `@trinity/components/*`, or replace the Angular/spartan stack.

## Current visual gaps

The source audit and the existing settings capture show five systemic gaps.

1. **Density is incomplete.** The setting changes message spacing, while navigation, member rows,
   settings, headers and the composer retain independent fixed measurements.
2. **Surface hierarchy is too flat.** Rail, sidebar, content and settings are separated mostly by
   colour blocks and dividers. There is little sense of a recessed app frame and a focused working
   surface.
3. **Shape semantics are inconsistent.** Spaces can switch between square and round depending on
   selection, while unrelated controls often share the same radius. Shape does not reliably say
   whether an item is a person, place, control or container.
4. **Typography is only partially tokenised.** The core scale exists, but many feature styles still
   use literal pixel sizes. Settings also rely heavily on repeated uppercase section labels, which
   makes long pages feel like one continuous form.
5. **High-value surfaces carry too many equal-weight actions.** The room header and composer have
   already started demoting actions into overflow menus, but the hierarchy is not yet expressed as
   one application-wide pattern.

## Design principles

### Familiar, not copied

Borrow Discord's clarity, density controls and interaction hierarchy, not its trade dress. Keep the
Trinity name, icon, current accent initially, Matrix terminology, encryption cues and account model.
Any future brand refresh should be its own decision after the structural redesign is stable.

### Conversation first

The timeline and composer are the visual focus. Navigation is quieter, persistent and easy to scan;
status and security information stays visible but does not compete with the message being read.

### People are circles; places and navigation tools are squircles

- Matrix users, account avatars, DMs and other presence-bearing identities use circles; bots/apps
  stay in this group until the client has reliable metadata that can distinguish them;
- every room and space uses a stable squircle, whether it has an uploaded image or an initial;
- account/workspace containers and navigation tool tiles may use stable squircles around their
  contents without changing a person's avatar inside them;
- selected state is expressed with surface, border or indicator changes, never by changing the
  identity's fundamental shape;
- containers use larger radii than the controls nested inside them.

`AvatarComponent` exposes the explicit semantic API `shape="person|place"`. The former boolean
`square` input was removed atomically when every call site migrated, avoiding ambiguous states where
both APIs could disagree. App-level semantic radius tokens drive the geometry, with component-local
fallbacks so the public component still renders correctly in isolation.

### Layered surfaces, restrained elevation

Use a recessed outer frame, a navigation surface and a primary workspace surface. Use borders and
small tonal steps for static separation; reserve shadows for floating menus, action trays, dialogs
and drawers. Avoid gradients, glass effects and permanent card outlines in the communication shell.

On desktop, prototype the main workspace as a subtly rounded surface inside the rail frame. On phone
layouts, remove the decorative outer radius and use the full viewport.

### One action hierarchy

- primary: the action that advances the current task;
- secondary: one or two frequent actions visible beside it;
- tertiary: low-emphasis text or icon actions;
- overflow: infrequent, advanced or destructive actions.

An action moved into overflow must retain a tooltip or label, keyboard access and an efficient route
for frequent users. Destructive actions remain separated and use the existing danger roles.

### Motion confirms cause and effect

Use the existing motion vocabulary:

- 90ms press feedback;
- 120ms hover/focus tint;
- 200ms menus, toolbars and local transitions;
- 320ms full-surface panel changes.

Prefer opacity and transform. Icons may use the existing semantic motions when the motion explains
the result (send, rotate settings, back nudge); they should not animate merely because they are
hovered. Every motion must collapse under `prefers-reduced-motion`.

## Target experience

### Desktop and Electron shell

- Keep the space rail and resizable channel sidebar; they are already strong, familiar navigation.
- Treat the rail as the recessed app frame and the chat/sidebar region as the active workspace.
- Preserve the 56px content-header alignment across chat and right panels.
- Keep one clear global search/command entry point. Prototype it in app-level chrome rather than
  adding another full-width box to every surface.
- Use a compact selected indicator plus a tonal selected surface. Unread, mention and selected states
  must remain distinguishable without relying on colour alone.
- Keep resizable panes and store widths exactly as today. The redesign changes presentation, not pane
  ownership or resize behaviour.

### Space rail and room list

- Make space icons stable squircles, including the selected item.
- Retain the left active indicator, but refine it into a consistent 3-state system: unread dot,
  hover bar and selected bar.
- Apply density tokens to rail gaps, sidebar padding, category spacing and room rows.
- Give the persistent room filter and command entry point different jobs: filter narrows the current
  list; command search navigates the whole app.
- Preserve message previews and typing text, but reduce metadata contrast and keep badges aligned on a
  stable trailing grid.
- Modernise the user panel into an identity dock: avatar, active account/status, and a small group of
  account/settings actions. Multi-account identity must stay more prominent than decorative chrome.

### Chat header and right panels

- Keep room identity and encryption state together at the leading edge.
- Keep at most three frequent actions visible at normal desktop widths; move the remainder into the
  existing overflow menu with logical grouping.
- Give active panel buttons a persistent selected state, not only a tooltip.
- Present member, thread, pin and search panels as the same family: identical header height, surface,
  divider, close behaviour and resize affordance.
- On narrow layouts, keep the established full-height drawer/full-screen behaviour and safe-area
  ownership.

### Timeline and messages

- Preserve grouped messages, virtualization, scroll anchoring and full-width hover bleed.
- Improve the author/time hierarchy with tokenised type roles and calmer metadata.
- Use a subtle local action surface for the hover/focus message toolbar; it should appear attached to
  the message being acted on, not float across the previous row.
- Standardise reply, thread, reaction, receipt, warning and sending states as compact inline
  components with shared radii and typography.
- Add skeletons shaped like real message groups for initial and room-switch loading. Pagination may
  retain its compact textual status because it does not replace the whole surface.
- Keep system events visually quiet and preserve the existing user setting that hides categories.

### Composer

- Keep the current single field containing insert, text, emoji and send actions.
- Increase its separation from the timeline with a slightly raised/tinted composer surface and
  consistent outer inset, without turning it into a detached floating pill.
- Keep the most frequent quick actions visible; leave poll, location, voice, sticker, GIF and file
  actions in the insert menu according to capability and platform.
- Merge reply/edit state visually with the composer surface rather than rendering a loose text strip
  above it.
- Keep the formatting toolbar contextual by default and user-pinnable.
- Preserve multiline growth, preview height, IME behaviour, draft retention, attachment progress and
  soft-keyboard safe-area handling.

### Settings

- On wide desktop/Electron windows, present Settings as a centred, bounded workspace with a recessed
  backdrop rather than a full-bleed form. Keep its own single scroll owner.
- Add a search field above the settings directory. Search filters the directory and points to the
  matching section; it does not create a second nested scroller.
- Group related controls into semantic sections with sentence-case headings, short supporting text
  and optional dividers. Do not wrap every group in a bordered card.
- Keep the existing one-pane mobile drill-in navigation.
- Add a small live preview to Appearance for mode, palette, text size and density so changes are
  understandable before leaving the page.
- Finish density across settings and replace repeated literal spacing with tokens.

The settings search is a product enhancement and should be its own issue/PR after the visual shell is
stable. The floating/bounded layout does not depend on search.

### Mobile

- Preserve the room-list -> chat hierarchy and swipe/back behaviours.
- Do not shrink desktop chrome onto a phone. Use full-width list/chat surfaces and coarse-pointer
  targets of at least 44px.
- Rework the bottom user panel into a touch-first identity dock on the list surface. Prototype
  notifications and account/settings shortcuts there before considering any new global bottom-nav
  destinations.
- Do not combine a new primary bottom navigation bar with the existing rail/drawer model unless a
  separate information-architecture study proves the destinations. Two simultaneous primary nav
  systems would make the hierarchy less clear.
- Keep composer quick actions near the thumb and make the insert menu a bottom sheet on mobile OSes.
- Maintain safe areas, soft-keyboard resizing, system-back handling and Android WebView coverage.

### Authentication, encryption and secondary surfaces

- Apply the same type, surface, field and action hierarchy to auth cards, recovery flows and
  verification dialogs after the communication shell is stable.
- Keep recovery keys, warnings and destructive confirmation visually distinct. Modernisation must
  never reduce the salience of security-critical information.
- Bring empty states, QR surfaces, media/lightbox overlays, toasts and errors onto the same radius,
  elevation and motion vocabulary.

## Design-system work

### Tokens

Continue using `apps/trinity/src/theme/variables.scss` as the single source of truth. Add or clarify
semantic roles only when at least two components need them. Likely additions are:

- outer app frame, workspace and raised-control surfaces;
- selected, selected-hover and attention surfaces;
- shape roles for person, place, control and container;
- component density values derived from the existing spacing scale;
- focus, pressed and disabled opacity roles if repeated values remain after the first migrations.

Components consume semantic roles, never raw colour values. Helm mappings remain references to the
Trinity roles. No new design-token package or runtime theming library is needed.

### Typography

- Expand the current four roles into caption, metadata, body, control, title and display roles while
  keeping rem units so Appearance -> Text size continues to work.
- Migrate high-traffic literal pixel sizes first: message row, room list, member list, composer and
  settings navigation.
- Use tabular numbers for timestamps, counters, recording time and transfer progress.
- Prototype a bundled open-source UI typeface with character, with Geist Sans as a candidate and the
  system stack as the fallback. Verify licence, bundle cost, WebView rendering and non-Latin coverage
  before adoption; the redesign must not depend on the font swap.
- Keep code on a bundled or system monospace stack and preserve the independent code-size setting.

### Density

Complete the existing token-based mechanism before adding another choice.

1. Adopt spacing/density tokens in the shell, sidebars, member list, headers, settings and composer.
2. Verify Cosy and Compact at every supported text scale and viewport.
3. Only then evaluate a third Spacious option. Do not advertise a global setting while only the
   timeline responds to it.

Touch hit areas remain at least 44px regardless of visual density. Density changes layout spacing,
not accessibility targets.

### Components and Storybook

Prefer evolving existing public components over adding feature-local copies:

- `AvatarComponent`: semantic person/place shape;
- `PageHeaderComponent`: active actions and consistent surface variants;
- `MessageToolbarComponent`: attached floating action surface;
- input, textarea, select, switch and radio wrappers: shared state and density recipes;
- `EmptyStateComponent`: illustration-free line, panel and page variants;
- overlay primitives: consistent menu, dialog, side-panel and mobile-sheet surfaces.

Add a new public component only when multiple feature libraries need the same markup and behaviour.
Every visual primitive should have Storybook stories for light/dark, default/Onyx, Cosy/Compact,
disabled/focus/error and reduced motion where relevant.

## Delivery plan

Each phase should be a separate issue or a small cluster of issues. A phase may ship independently;
there should be no long-lived branch containing the entire redesign.

The semantic-avatar slice is the Phase 0 pilot for this plan. It preserves the existing 30% place
radius rather than claiming a newly measured target, moves that value behind one semantic token,
and adds Storybook plus real-browser comparisons so later prototypes can tune it centrally. It does
not complete Phase 0: the reference screenshots, viewport fixtures and broader desktop/phone
prototypes below remain the gate before finalising the rest of the Phase 1 token system.

### Phase 0 - baselines and prototypes

Deliverables:

- capture reference screenshots for the room shell, settings, login and encryption flows;
- define desktop, compact-window and phone viewport fixtures;
- prototype the workspace surface, shape rules and settings layout in Storybook or static branches;
- choose measurable token targets only after comparing light, dark and Onyx together.

Acceptance:

- product direction is approved from at least one desktop and one phone prototype;
- no prototype requires a new framework or direct vendor imports from feature code;
- baseline screenshots cover long names, unread badges, a busy timeline, empty states and errors.

### Phase 1 - foundations

Primary ownership:

- `apps/trinity/src/theme/variables.scss`
- `apps/trinity/src/theme/spartan.css`
- `libs/platform-native/src/lib/theme.service.ts`
- `libs/components/*`
- `docs/architecture/ui-and-theming.md`

Deliverables:

- final surface, shape, typography and component-density roles;
- semantic avatar shape API;
- complete shared hover, active, pressed, focus, disabled and floating-surface recipes;
- representative Storybook stories and contrast checks.

Acceptance:

- no new hard-coded colour in component SCSS;
- all new motion uses existing duration/easing tokens and respects reduced motion;
- text and focus contrast pass in every mode/palette combination;
- no theme flash or native status-bar regression.

### Phase 2 - desktop shell and navigation

Primary ownership:

- `libs/feature/rooms/src/lib/rooms/`
- `libs/feature/rooms/src/lib/server-rail/`
- `libs/feature/rooms/src/lib/channel-sidebar/`
- `libs/feature/rooms/src/lib/member-list/`
- `libs/components/page-header/`

Deliverables:

- recessed frame and workspace surface;
- stable space squircles and refined active/unread states;
- density-aware rail, channel, member and user-panel spacing;
- unified header action hierarchy and right-panel family;
- modern identity dock in the channel sidebar.

Acceptance:

- persisted pane widths, min/max bounds and drag handles behave unchanged;
- 1280x720, 1024x768 and 900x700 have one vertical scroll owner per pane;
- long space/room/account names truncate without hiding actions or badges;
- keyboard and touch access remains complete at every density.

### Phase 3 - timeline and composer

Primary ownership:

- `libs/feature/rooms/src/lib/message-list/`
- `libs/feature/rooms/src/lib/message-row/`
- `libs/feature/rooms/src/lib/message-composer/`
- `libs/components/message-toolbar/`

Deliverables:

- tokenised message hierarchy and metadata;
- attached message toolbar surface;
- consistent reply, thread, reaction, receipt and status treatments;
- initial/room-switch message skeleton;
- integrated reply/edit composer header and refined insert menu.

Acceptance:

- virtualization measurements and scroll anchoring remain stable;
- composer height does not jump between input, preview, reply, edit, upload and recording states;
- keyboard send, IME, paste, draft, mobile sheet and long-press flows retain their tests;
- Compact visibly increases useful conversation area without reducing touch targets.

### Phase 4 - settings

Primary ownership:

- `libs/feature/settings/`
- `libs/components/page-header/`
- shared form components under `libs/components/*`

Deliverables:

- bounded/floating desktop settings workspace;
- grouped section rhythm and tokenised form rows;
- Appearance preview;
- optional settings search as a separate product slice;
- unchanged mobile drill-in navigation.

Acceptance:

- exactly one vertical scrollbar appears at 1280x700, 1024x700 and below the historical 863px
  threshold;
- deep links, back navigation and section focus remain correct;
- 125% text size and Compact density do not clip labels or controls;
- search, if included, is keyboard reachable and announces result counts.

### Phase 5 - mobile refinement

Primary ownership:

- responsive rules in the room and settings feature libraries;
- `@trinity/platform-native` capability/OS branches;
- mobile overlay/action-sheet components;

Deliverables:

- touch-first identity dock;
- consistent bottom sheets and drawers;
- phone-specific composer/action hierarchy;
- refined transitions between room list, chat and right-side details.

Acceptance:

- Pixel 5 and a 320px-wide viewport have no horizontal document scroll;
- Android system back, swipe-to-reply/edit, drawer swipe and soft keyboard remain correct;
- safe-area insets are applied once, not lost or doubled;
- Android WebView and browser mobile-profile tests agree on layout-critical behaviour.

### Phase 6 - auth, crypto and remaining surfaces

Deliverables:

- modern auth and registration cards;
- consistent encryption setup/unlock/verification surfaces;
- aligned dialogs, pickers, media overlays, empty states, toasts and error surfaces;
- removal of obsolete local styling recipes after consumers migrate.

Acceptance:

- security warnings and recovery material remain more prominent than surrounding chrome;
- focus trapping, autofocus, escape/back and destructive confirmations remain unchanged;
- no feature library imports a vendor UI package directly.

### Phase 7 - hardening and rollout

Deliverables:

- visual regression coverage for the agreed reference screens;
- accessibility, contrast, responsive and performance sweep;
- removal of obsolete compatibility inputs and unused tokens;
- user documentation and screenshots updated to the shipped interface;
- release notes/changelog entry describing visible changes and any moved controls.

Acceptance:

- full lint, stylelint, format, unit, typecheck and relevant Playwright suites pass;
- Web, Electron and Android smoke journeys pass from the same built bundle;
- no known P1/P2 accessibility, navigation, scroll or clipping regression remains;
- rollout can be reverted by normal commits and does not depend on a permanent hidden legacy theme.

## Validation matrix

Every implementation issue selects the relevant rows; the phase-closing PR runs the full matrix.

| Axis         | Required coverage                                                          |
| ------------ | -------------------------------------------------------------------------- |
| Viewport     | 1440x900, 1280x720, 1024x768, 900x700, Pixel 5, 320x568                    |
| Platform     | Chromium web, WebKit where layout differs, Electron, Android WebView       |
| Mode/palette | light and dark default; dark Onyx; Amethyst spot check                     |
| Density      | Cosy and Compact                                                           |
| Text         | Default and Larger (125%)                                                  |
| Input        | mouse, keyboard-only and coarse pointer                                    |
| Motion       | normal and `prefers-reduced-motion: reduce`                                |
| Content      | empty, loading, error, offline, long names, unread-heavy and busy timeline |

Visual assertions belong in Playwright, not jsdom. Existing behavioral tests should remain focused
on semantics; add screenshot tests only for stable representative compositions, with fonts and data
made deterministic.

## Implementation loop for every issue

Use the repository's usual loop:

1. plan the smallest independently shippable slice;
2. have a critique agent challenge scope, accessibility, responsive behaviour and architecture;
3. update the plan from the critique;
4. implement with tests;
5. update architecture/user documentation and `CHANGELOG.md` when the slice changes shipped UI;
6. run formatting, lint, stylelint, unit tests, typecheck and the relevant real-layout Playwright
   coverage;
7. push and open a PR with before/after evidence;
8. dispatch code, UX/accessibility, test and security review agents as appropriate;
9. fix validated findings, rerun affected checks and push.

## Non-goals

- copying Discord logos, illustrations, sounds, typeface or exact colour values;
- adding games, voice/video features or social concepts that do not map to Matrix;
- replacing Angular, Tailwind, spartan-ng or the existing component-boundary architecture;
- changing Matrix protocol behaviour as part of a visual PR;
- shipping a separate legacy theme instead of migrating the design system;
- using animation, gradients, glass or shadows as substitutes for information hierarchy.
