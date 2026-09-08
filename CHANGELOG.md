# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Independent CI jobs report Storybook, styling, browser, QR protocol, production
  renderer, Web container, desktop, Android, and iOS results while sharing one verified
  production renderer. A fail-closed aggregate reports the complete expected result set,
  and unsigned iOS compiler failures retain validated build diagnostics.

- A rootless Web container host packages the verified production renderer with tested
  deep-link routing, security and cache headers for every generated bundle, and offline
  PWA behavior. Local Nx targets build and check the image without rebuilding Angular
  or publishing to a registry.

- Open Markdown formatting and Preview from an Aa composer action, using a desktop
  popover or a mobile action sheet while preserving the editing selection.

- MIT license for Trinity, with license metadata in the application and desktop
  package manifests and links from the README and contributor guide.

- Search the Settings directory by section name or group in both the page and dialog.
  Keyboard-accessible clear and result announcements accompany filtering, while selected
  sections, mobile Back focus, navigation history and the search during resizing are preserved.
  Shared Settings frames also return to side-by-side panes when a compact window is widened.

### Changed

- Keep empty message inputs at one row even when a long room-name placeholder wraps,
  so the composer remains reachable on small screens with larger text.

- Replace the persistent and selection-triggered composer toolbar with the Aa formatting
  action, and remove the toolbar visibility preferences from Appearance.

- Clarify which Accounts appear together in Room Library with matching desktop and mobile
  selectors, clearer identity rows, and an explicit “Always included” Active Account state.
  Selections apply immediately, with Done dismissing the mobile dialog.

- Restyle Edit history with the Settings dialog surface, title bar close action,
  responsive fullscreen presentation and a clearer highlighted revision list.

- Measure unread-divider thread connectors in one browser turn so timeline scrolling
  cannot cause a false geometry failure in CI. Refresh the reviewed assertion inventory
  so Android suites accept the updated test, and allow subpixel rounding in WebView.

- Wait for shared locations to finish sending before testing their message menus,
  preventing server-echo row replacement from closing the menu during the check.

- Resolve disposable federation signing keys directly between the test homeservers,
  preventing slow public-notary lookups from failing room-preview alias resolution.

- Exercise thread replies through Android's long-press action sheet in the shared
  quote regression test, instead of waiting for the desktop-only hover toolbar.

- Keep the timeline's reading position steady when the older-history loading indicator
  appears, including Android, and preserve that position when the messages arrive.

- Make the CI process-cleanup test wait for its child to be ready before checking
  forced termination, so slower startup cannot cause a false failure.

- Thread messages no longer show automatic fallback quotes in the sidebar. Explicit
  replies to a particular message retain their quote and jump action.

- Timeline threads now keep their connected preview beneath the parent message, including
  short replies and image messages. The connector aligns with the avatar center at both
  densities. Previews show the latest reply author and text, relative activity time, reply
  count and unread status. The whole preview opens the thread, with touch-sized targets
  and single-line text on narrow mobile screens.

- Refine the bottom Account bar and switching menu with clearer identity rows, aligned
  status indicators, grouped account actions, and explicit account-removal wording.
  Settings and System Status remain directly available across desktop and mobile.

- CI now compiles the production web renderer once per run from the exact checked-out SHA,
  records a version 2 file and digest manifest, and makes desktop, Android, iOS, and the
  production renderer journey consume the validated artifact. Restoration verifies the
  immutable run and artifact coordinates before replacing `www/`; iOS adds an unsigned
  `macos-26` simulator compile, and local `ios:build:prebuilt`, `android:build:prebuilt`,
  `trinity-e2e-electron:full-prebuilt`, and `trinity-e2e-electron:smoke-prebuilt` commands
  expose the same parity path. Development E2E prerequisites and styling/browser suites
  retain their intentional development bundle.

- CI now classifies documentation changes into formatting and source-contract checks,
  retains full code validation for uncertain diffs, rejects flaky retry passes, and
  uploads hidden Playwright diagnostics after failures and managed timeouts. Browser
  prerequisite failures preserve installer logs; Android waits for KVM permissions
  and caches browser downloads separately from Gradle.

- Simplify contributor issue forms and pull requests: bug reports separate observed and
  expected behavior, accept unknown environment details and support multiple platforms;
  feature requests focus on outcomes. Both forms enter triage automatically, and PRs
  request concrete validation and limitations instead of blanket checklists.

- Install project-scoped Astra orchestration and Luna execution defaults, specialized
  Codex roles and the upstream astra-orchestrator skill, preserving Trinity role
  instructions and existing planner/implementer names.

- Settings, Room settings and Space settings now share the same dialog layout, icon navigation,
  typography and section presentation. Room and Space context stays visible beneath the title;
  mobile opens the section directory unless a shortcut selects a section. Larger text also adapts
  the navigation layout. Pending section edits reveal Save and Discard, while read-only General
  details remain selectable and permission loss preserves clearly marked unfinished edits.

- System Status now reuses the public Settings layout for its desktop directory/detail view and
  compact mobile navigation. Overview is the default, the directory keeps only actionable capability
  groups alongside Overview and Support details, and Back returns from detail to the directory before
  dismissing. Compact geometry follows text scaling independently from the OS-selected mobile sheet.

- The Storybook Axe scan concurrency regression now has a dedicated accessibility-helper spec,
  leaving the navigation and overlay catalog focused on product-surface behavior while retaining
  distinct scan-owner and completion proof with retries disabled.

- **Space settings now owns Account-bound Rooms and Spaces management.** Members can inspect
  direct child Rooms and nested Spaces with explicit loading, empty and failed states, while
  live Space permission controls whether Add existing, Create Room, Create Space and confirmed
  Remove actions appear. Candidate search, hierarchy reads and every parent-link write remain
  attached to the Account and Space that opened settings. Creation links only through the parent,
  removal neither leaves nor deletes the child, and a created item whose link fails is preserved
  by name and Matrix ID with a link-only retry that cannot create a duplicate. The existing Space
  header shortcuts remain available, and Organise rooms now opens this same destination. Each child
  row exposes immediate shared-order and Suggested controls when permitted, with boundary-aware
  moves, retryable failures, optimistic rollback, and a Space-wide lock that waits for the exact
  Account's synced echo before accepting another conflicting write. These shared changes never
  overwrite the Account's Recent, Alphabetical, Space order, or default preference.

- **Room Widgets now has an Account-bound section in the responsive Room settings hub.** Existing
  declarations, URL-template disclosures, restricted in-app opening and external-browser launch
  remain readable to ordinary members, while Add and confirmed Remove actions follow the opening
  Account's live widget-state permission. Creation failures retain both inputs, unfinished drafts
  are protected on section, Back and Close navigation, and pending or completed actions remain
  explicit. Account switches cannot redirect projected widget identity or writes, long declarations
  stay reachable on phones, and Space settings continues to omit Widgets.

- **Room and Space member administration is consolidated inside Account-bound settings.** The
  Members section keeps the opening Account's live roster, role groups, search, member detail and
  banned list together. Invite, role, remove, ban and unban actions recheck that exact target after
  pickers and confirmations; later Account switches cannot redirect them. Ordinary members retain
  readable membership and policy while unavailable administration is hidden, Space invitations
  affect only the Space itself, and the existing Room and Space member shortcuts open the same
  lifecycle-owned destination.

- **Room and Space addresses now stay bound to the Account that opened settings.** Their own
  readable section shows the primary address and every local address, including long values and
  an explicit empty state. Copy and Matrix-link actions remain available without edit permission;
  administrators get separate add, make-primary and confirmed removal actions with independent
  progress and failure feedback. Failed additions retain the entered address, Account switches
  cannot retarget pending work, and removing the primary address clears canonical state before
  deleting its directory entry.

- **Room and Space access policies now have dedicated settings sections.** Members can read the
  live join and Room-history policy with field-level permission explanations and no unusable Save
  footer. Administrators get exact-target Save and Discard behavior, required-Space validation,
  partial Room-policy retries, unfamiliar-state preservation, and Space-specific scope guidance.
  Room addresses moved to their own section without removing the existing address controls.

- **Space settings now has a personal Room-order section.** For you stages Use my default,
  Recent activity, Space order or Alphabetical for the exact Account and Space that opened the
  hub, stores the choice only on this device, and protects unsaved changes on section, Back and
  Close navigation. Loading, persistence failure and pending Save states stay explicit. Removing
  an override continues following later Account-default changes, never rewrites shared Space
  hierarchy order, and leaves the existing Space-header shortcut working.

- **Room settings now has an Account-exact For you section.** Every Room member can stage its
  notification mode, Favourite and Low priority values for the Account that opened settings,
  including when one sidebar row represents several Accounts. Authoritative Matrix rule and tag
  reads expose loading, unavailable and failed states instead of guessed defaults; Save retains
  successful fields, retries only failures and protects unfinished edits on Close or Back. The
  existing sidebar shortcuts keep their intentional combined-row scope, and installation-wide
  read-receipt and link-preview preferences remain outside Room settings.

- **Space settings now shares the Account-bound responsive settings hub.** General and Access
  stay attached to the Account and Space that opened the hub, preserve section drafts across
  live Matrix updates, retry only failed fields, and never retarget a late write after an Account
  switch. Desktop keeps the section directory beside the editor; phones use a full-screen
  master-detail flow with protected Back and Close navigation. Existing unfamiliar access rules
  remain readable without offering new restricted choices, while Addresses and the exact-target
  Members destination remain reachable. Leaving a Space now confirms the exact
  Account and Space and makes clear that membership in its Rooms is retained.

- **Room settings is now an Account-bound responsive hub.** Web and desktop keep a centred
  directory-and-section dialog, while a real phone uses a full-screen master-detail flow with
  reachable scrolling and Back behavior. General opens first with the opening Account and Room
  clearly identified; General and Access keep independent drafts, save successful fields
  separately, and retry only failures. Browser, device and in-hub navigation protect dirty work,
  live permission changes disable only affected writes, and Account switching or sign-out cannot
  retarget pending Room updates. Existing local-address and Widgets workflows remain reachable,
  with their exact-target migrations completed by the subsequent dedicated sections.

- System Status now presents startup blockers and live capability limits from one application-owned
  English catalogue, grouped by user-facing capability and Account with scoped recovery, recurrence-aware
  dismissal, explicit recovery outcomes, and privacy-safe copyable support details. Startup stays calm for
  fast paths before naming its current step; Android Back is owned before readiness and remains single-owned
  afterward. The append-only runtime-warning model and its compatibility ledger have been removed.

- Account removal and installation reset now require complete operation-specific confirmation,
  own destructive cleanup after UI detachment, bound every finite cleanup step without cancelling
  underlying work, and distinguish pending uncertainty from settled residue and success. Reopened
  recovery joins or replays the owned attempt, retries only safe local residue, reconciles late
  IndexedDB deletion, and carries value-free scope/recovery detail through Application Runtime
  instead of legacy warnings or false readiness.

- Room Administration now reports separate exact Account-and-Room health for permissions,
  members and bans. Retained membership failures preserve and label last-known roster or ban data,
  initial and released states no longer look like authoritative empty Rooms, state-backed changes
  require coherent permissions, and targeted retry repairs the retained projection or restores
  both released owners without closing the remembered members panel.

- Room notification rules, notification presentation, native push registration, app badges and
  update checks now report separate scoped health. Room-rule recovery reattaches released
  projection ownership without implying that delivery failed; unsupported or disabled hosts stay
  expected states. Failed notification navigation/presentation, badge writes and host Back or
  deep-link actions are contextual incidents with safe feedback rather than permanent startup
  warnings. Native-push listeners and finite host checks have targeted, generation-safe retry,
  privacy-safe diagnostics and explicit fallbacks while messaging and Workspace remain usable.

- Trust now distinguishes coherent current encryption health from explicitly stale or unavailable
  state, so failed crypto reads cannot imply verification, unlock readiness or disabled backup.
  Application Runtime reports opaque active-Account Trust health with bounded scoped recovery,
  retries retained failed projections in place, and recreates released ownership without
  restarting Workspace, Conversations or unrelated session capabilities.

- Preference startup now settles all twelve current producers independently into declared safe
  defaults and reports exact recoverable health instead of permanent warnings. Concrete
  initializers preserve invalid/unavailable-storage fallback evidence, typed presentation explains
  each default's consequence, late success repairs health, and removed producers retire stale
  recovery. Room ordering uses
  opaque per-Account health with its recent-activity default, and the session-owned Appearance
  effect can restart without a lifetime deadline. Reset still requires `DEFAULTS`, now preserves a
  value-free per-entry partial ledger, owns late setters, and retries only outstanding exported
  settings while keeping drafts, Accounts, push ledger and per-Account ordering excluded.

- Application startup now applies one bounded required-producer policy from Host negotiation
  through final readiness. Room Library preparation cannot wait indefinitely, optional session
  work settles independently, failed saved navigation falls back to a safe root, and the overall
  watchdog rejects obsolete late results without timing healthy retained ownership. Every producer
  records an exact ready, degraded, blocked, or dependency-skipped settlement, and recovery resumes
  from the narrowest ownership stage instead of repeating healthy upstream startup. Inactive
  Accounts recover in independent opaque scopes without rerunning healthy Accounts, while denied
  browser persistence continues with an explicit local-data eviction-risk warning.

- Application Runtime now tracks scoped Identity presence health separately from preparation
  and subscription ownership. Unavailable presence is unknown, and its visible retry preserves
  the Conversation. Independent Account scopes can recover without blocking one another.
  Unexpected runtime adapter failures expose safe, executable startup retry.

- Documentation now has reconciled reader paths and complete first-party ownership, with
  superseded plans and migration pointers retired after preserving active requirements and
  decisions. Push integration and production-renderer guidance describe their current owners
  and validation scope.

- Agent documentation now separates task onboarding from catalog maintenance, explains role
  models and runtime limits, and provides one compact handoff. Local desktop and UX references
  follow Trinity contracts, with duplicated architecture and command guidance consolidated.

- Maintainer documentation now connects CI diagnosis, coordinated release preparation, signing,
  partial-artifact recovery and dependency updates, with a canonical warning guide and explicit
  distinctions between current automation, historical evidence and pending proposals.

- UI contributor documentation now connects public component composition, appearance and cascade
  contracts, Storybook verification and image-pack presentation. Deferred redesign requirements
  have tracked owners so the superseded plan can be removed during final integration.

- Architecture documentation now connects capability owners, runtime lifetimes and Matrix/Trust
  contracts, with source-backed recovery limits and a separate record of historical decisions
  and validation evidence.

- Platform documentation now follows Web/PWA, Electron, Android and iOS run/debug/package
  workflows, with current capability boundaries and explicit validation and signing limits.

- Contributor documentation now provides a checkout-to-review workflow, a canonical command
  reference, scoped validation guidance and source-checked setup and troubleshooting notes.

- Everyday-use documentation now connects account scope, Rooms and Spaces, messaging,
  personal settings and notification workflows with implemented permissions and host limits.

- First-use documentation now guides host choice, installation, sign-in and registration,
  device verification and encrypted-access recovery, with explicit limits and recovery
  consequences checked against the implementation.

- Documentation now offers task-based entry points for users, contributors, maintainers and
  agent users, with a content ownership and migration inventory for the ongoing rewrite.

- Agent instructions now load detailed command, capability and convention guidance on demand,
  use compact handoffs and reuse current investigation and validation evidence. Implementation
  uses Terra with high reasoning; required validation and independent review remain intact.

- Repository agent roles now use Astra for planning and independent review, and Terra for
  implementation, with explicit handoffs and Trinity-specific scope and validation rules.

- Repository skills now focus on Trinity client work: removed 18 overlapping or unsuitable
  skills, added CLI-managed Ponytail simplicity guidance for a total of 26 product and engineering
  skills, and repaired design-reference routing. Ponytail follows Trinity's architecture and
  validation requirements through repository-owned overrides.

- The CLI-managed Angular developer skill now comes from `angular/angular`, including its
  updated Angular Aria guidance.

- Agent guidance now shares contributor policies for branching, releases and validation:
  `develop` is the default, integration branches are task-specific, and checks are selected
  by the changed behavior, including single-component browser layout checks.

- **Room-surface compatibility access is removed.** Explicit thread, pins, search, member, and
  reveal intents now form the only mutation boundary. Internal state records no longer leak into
  callers or tests, and structural and type guards keep panel and jump state private.

- **Room panels now share one predictable lifecycle.** Every shell starts with the member list
  closed. An explicit member choice survives Room and Account changes for that shell, while
  Threads, thread detail, pinned messages, search, and member details temporarily take the same
  slot and retreat to the remembered member list. The lifecycle also owns responsive drawer
  cleanup, focus restoration, Escape, swipe, and Workspace Back behavior; stale Conversation
  payloads and message reveals cannot leak into the next Room.

- **Session projection startup no longer belongs to routes or presentation hosts.** Room Library,
  Trust, Identity, Notification, and Room Administration services now expose cold owned
  `runProjection()` sources instead of public generic connect/disconnect pairs. Application Runtime
  is their sole lifetime subscriber; stopping it releases listeners, queued reconciliation,
  warning collection, and projected state, while restart creates a fresh generation. An empty
  Account scope remains prepared and dormant, then attaches on a later login. Exact Conversation
  and settings projections keep their independent local lifetimes.

- **Notification and Room Administration projections now belong to Application Runtime.** Named
  cold lifetimes retain per-Room notification rules, permissions, and member summaries while a
  routed Room surface needs them. They follow active-Account projection transitions, release on
  blocked startup, stop, or restart, and report expected preparation failures as safe optional
  warnings. The Rooms route now only consumes their state; notification delivery and activation
  still flow through host-neutral intents and Workspace.

- **Trust and Identity projections now belong to Application Runtime.** Named cold lifetimes retain
  Trust health and incoming verification across routes, while Identity presence attaches only when
  the routed Workspace can display it. They reattach when an Account becomes active and release on
  blocked startup, stop, or restart. The Rooms route and verification host now consume state without
  starting session projections; expected capability failures become safe runtime warnings and
  broken adapters still error.

- **Workspace restoration now waits for its Room Library projections.** Application Runtime owns
  one cold Room Library lifetime after Account restoration, prepares Rooms, Spaces, invitations,
  hierarchy and the selected-Account view through Projection Runtime, and keeps live deep-link,
  Back, notification, update and presentation streams gated until final readiness. Blocked startup,
  stop and restart release and reacquire that lifetime without retaining listeners.

- **Room Library now owns one selected-Account projection path.** The selected view directly
  reconciles live Account clients through one internal listener registry and projects Rooms,
  Spaces, and invitations behind its public interface. The three compatibility mixed services,
  their exports, and page-shaped tests are removed; single-Account selection still delegates to
  the existing active projections without attaching duplicate Matrix listeners.

- **Room actions now retain exact selected-Account ownership.** Room, Space, invitation, permalink,
  and shortcut navigation use the same selected Room Library generation as the visible sidebar.
  Shared-Room read, notification, favourite, and priority changes target each contributing Account
  exactly once, while asynchronous create, join, and confirmed-membership flows keep the Account
  that started the action instead of following a later Active Account switch.

- **Room-shell lists now render one coherent selected-Account generation.** Recent, Home, Rooms,
  Space, rail, account-badge, and invitation presentation no longer choose between active and mixed
  sources. Shared Rooms and Spaces retain their selected-view ownership and child-union policy,
  while per-Account hierarchy membership keeps each winning Room in the right list. Scope changes
  replace the complete visible generation together, and the page no longer fans Account selection
  into three compatibility projectors.

- **Room Library now publishes one selected-Account view.** Local search reads one coherent Room,
  Space, and invitation generation instead of choosing active or mixed sources, so invitations
  from every selected Account are searchable with exact ownership. Single-Account selection keeps
  the efficient active projections; shared Rooms retain every owner and their loudest unread state,
  while shared Spaces retain the union of joined children. Account selection now uses a typed
  capability-owned preference command that leaves the prior view published when storage fails.

- **Room-shell navigation now crosses a semantic Workspace boundary.** Account and scope changes,
  exact Room opens, compact-list close, Room removal, shortcuts, Room hopping, and Workspace Back
  submit product intent while Workspace owns scope retention, pane and history policy, canonical
  URL projection, Account readiness, Conversation focus, and typed outcomes. Shortcut history
  retains exact Account-and-Room identities across mixed accounts. Global Search, local and native
  notification activation, and inbound restoration now use that same cold semantic command;
  Application Runtime no longer constructs Room URLs, and repeated same-Room event activations
  publish a fresh target without reporting a navigation failure. The application-owned Workspace
  service now also owns Router projection and route restoration for its full lifetime, removing the
  lazy activator, page-scoped transition seam, caller-built destinations, and caller-supplied
  history policy while preserving transition repair, visit history, Media release, and
  Conversation focus behind one interface.

- **The atomic design-system migration is integrated and ready for delivery.** Tailwind,
  Theme and Appearance ownership, public component recipes, the authored cascade, accessibility
  catalogs and host-specific proof now form one documented route across Web, PWA, Electron,
  Android and static iOS contracts. The final audit also removes stale migration wording and
  restores repository-wide formatting conformance.

- **Native Appearance now has installed Android and static iOS proof.** The real Capacitor WebView
  exercises Mode, Theme, density and text size, verifies native status-bar style,
  safe-area/coarse-pointer geometry and exact shared-bundle parity, and retains successful
  screenshots outside Git for review. Linux validation also pins the shared production renderer
  and iOS status-bar bridge while recording the Xcode-only Simulator build as unavailable.

- **Production Web, PWA and Electron now prove the shipped Appearance system end to end.** The
  exact production artifact covers untouched defaults, system changes, every Theme × Mode on
  desktop and mobile, static first paint, offline styling, overlays, density, safe areas, reduced
  motion and the Electron custom protocol. The signed-out surface now uses Trinity's actual app
  icon instead of a placeholder letter, and forced-colour keyboard focus uses the system highlight
  colour so it remains visible when shadow-based rings are suppressed.

- **Tailwind now exposes a closed Trinity design namespace.** Stock colour, elevation and
  open-ended radius utilities are reset in favour of semantic colour, scrim, shadow and invariant
  radius roles. A sparse synthetic Theme, compiled namespace checks, contrast/gamut contracts and
  a dated accessibility inventory prove new Theme metadata and overrides remain data-only.

- **Onyx now has a fully achromatic sRGB-safe OKLCH palette in both modes.** Neutral surfaces,
  text, controls and interaction states lose their remaining blue cast, while the dark rail and
  canvas retain true black for OLED displays. Inherited accent, status and syntax colours keep
  their established meanings and remain readable across every Onyx surface.

- **Amethyst light and dark now use a coordinated sRGB-safe OKLCH palette.** A sparse violet
  accent and violet-neutral surface family replaces the legacy hex and HSL values while inherited
  success, warning, danger, and syntax colours retain their established meaning. Text, controls,
  icons, and focus remain readable across every Amethyst surface.

- **Trinity light and dark now use a coordinated sRGB-safe OKLCH palette.** Neutral, indigo,
  success, warning and danger families provide explicit interaction, solid and tint stops;
  success and warning text/icons no longer share their filled-status colours. Local contracts
  enforce gamut, text contrast, graphic contrast and focus contrast across every Theme and Mode.

- **The authored cascade migration is complete.** Every component stylesheet and inline rule now
  emits through the named `components` layer, while static vendor CSS and the narrow invariant
  override allowlist remain explicit. The temporary unlayered-rule fingerprint ledger is removed,
  and repository contracts reject any new unlayered authored rule or unapproved `!important`.

- **Public components now expose only canonical Trinity contracts.** Removed temporary styling
  aliases, numeric and CSS-length size inputs, overlay Promise wrappers, legacy dialog placement,
  and the tab panel's arbitrary inner-class input. Strict template and source guards reject the
  retired vocabulary; tab panels now own their shared stack layout internally.

### Added

- CLI-managed repository agent workflows for design interviews, issue maps, ticket publication,
  research, prototypes, diagnosis, review, conflict resolution and Nx tasks. Shared guidance
  now preserves accepted approvals, isolates unrelated work and follows Trinity's Angular
  and prototype-storage conventions through update-safe repository overrides.

- **Navigation, overlays and shipped feature states now have complete browser catalogs.** Every
  public recipe axis and meaningful open, selected, invalid, disabled, destructive, clipped,
  portal, backdrop, focus-restoration and outside-press state runs across all six Theme/Mode
  combinations. Inactive tabs and media-error metadata now use their owning semantic treatments
  and meet AA contrast; the toast wrapper repairs its vendored list/live-region roles; and desktop
  plus coarse-pointer browser checks guard geometry, keyboard behavior and accessibility.

- **Controls now have a complete accessibility catalog.** One Storybook inventory covers every
  button, choice, toggle, field, select, emoji-picker and QR-scanner recipe across all supported
  variants, sizes, presentations, states, densities and Theme/Mode combinations. Local browser
  gates enforce Axe, keyboard, coarse-pointer, text, graphic, focus and disabled-readability
  contracts; emoji choices are now real named buttons and checkbox boundaries retain 3:1 contrast.

- **Foundations and Generic Content now have a complete accessibility catalog.** One Storybook
  canvas inventories every public treatment, supported recipe axis, meaningful state, density and
  bounded exact-size case. All six Theme/Mode combinations now gate Axe results, browser-composited
  text and graphic contrast, native disabled semantics and non-colour accessible names, while the
  static contrast matrix covers every status surface pair.

- **Overlays now expose one bounded Trinity vocabulary.** Dialogs, panels, sheets and popovers
  share semantic surface, ordinal size and structural layout recipes while placement remains a
  separate behavior choice. Dropdown items, alerts, action sheets and toasts use canonical
  neutral, status and danger variants; dialog, confirm and prompt results use cold, finite RxJS
  commands. Storybook and the application resolve the same recipes inside both document and CDK
  portal layers.

- **Navigation and layout primitives now separate meaning from structure.** Tabs expose neutral or
  accent treatment independently from pill or line presentation; page headers expose the same
  semantic treatments independently from page or toolbar layout; cards offer only neutral/muted
  surfaces and compact/default spacing; and separators offer neutral/accent lines while retaining
  native orientation and accessibility behavior.

- **Fields and rich controls now use bounded Trinity recipes.** Labels separate normal or strong
  emphasis from validation; native inputs and textareas expose `sm`–`lg` sizes; selects own their
  full-width trigger and expose only `sm` or `md`; and emoji sizing no longer leaks vendor pixels.
  Native names, descriptions, focus and keyboard behavior remain authoritative, while scanner,
  field and picker styles now live in explicit cascade layers.

- **Action and choice controls now share bounded Trinity recipes.** Checkboxes, switches, radio
  groups, standalone toggles and toggle groups expose only the semantic variants, ordinal sizes
  and structural axes they implement. Native inputs own checked, invalid, disabled and keyboard
  semantics; toolbars retain one roving tab stop; buttons announce loading; and the composer no
  longer restyles control internals.

- **Foundations and generic content now use bounded Trinity recipes.** Icons, avatars, badges,
  banners, empty states, progress and spinners expose only the semantic variants and ordinal
  sizes they support, while tooltip position stays a behavior choice. Browser checks prove the
  recipes resolve through Theme tokens without leaking vendor types.

- **Buttons now speak Trinity's design language instead of the underlying UI kit's.** Public
  button recipes introduce semantic `primary`, `secondary` and `danger` variants, ordinal
  `xs`–`lg` sizes, and separate presentation and icon-shape choices. Unsupported design-system
  values fail template type-checking rather than falling through to an accidental style.

- **Room links now open a safe information preview before anything changes.** Links in both
  `matrix.to` and `matrix:` form show the room name, address, topic, member count, encryption and
  access rule without navigating or changing membership. Joined rooms offer **Open**; public rooms
  offer an explicit **Join**, invitations can be accepted, and knock-enabled rooms can receive an
  access request; restricted rooms offer **Join** only when the account belongs to an allowed
  room. Successful joins stay visible before **Open**, while private, inaccessible,
  malformed, offline and rejected links explain what happened and keep retryable actions available.
  Aliases are resolved through the room directory, validated routing hints are preserved, and the
  stable Matrix room-summary API is preferred with compatibility for older homeservers.

- **Install and manage sticker packs without another Matrix client.** Settings now has a
  **Stickers & emoji** section that finds MSC2545 packs by room ID or alias, lets you choose
  among multiple packs in one room, enables or disables their supported usages, and installs or
  removes them for the active account. A **Manage** action in the sticker picker opens the same
  screen, and pack headings distinguish **All rooms** from **This room** sources. Installed packs
  update the composer immediately and follow the account to other devices; broken or inaccessible
  references remain removable instead of disappearing. Trinity reads legacy pack data for
  compatibility but writes only the stable Matrix event type.

- **The room list shows who is typing.** A room where somebody is typing now says so in
  place of its last message, in italics, until they stop — so you can see a conversation
  starting up without opening it.

- **Threads show who is typing, and tell the room when you are.** The reply box in a thread
  now announces your typing to the room the way the main composer does, and carries the same
  typing line above it. Matrix tracks typing per room rather than per thread, so that line
  names everyone typing in the room — including people writing in the main timeline.

- **The typing line has animated dots, and holds its place.** When someone is typing, the
  line under the timeline now ends in three pulsing dots instead of a full stop, so it reads
  as something happening rather than a label. The line also keeps its space whether or not
  anyone is typing — and stays one line, shortening a long name rather than wrapping — so the
  messages above it no longer shift up and down each time somebody starts or stops. If you
  have asked your system for reduced motion, the dots stay still.

- **Swipe a message to reply to it — or to edit it.** On a phone, drag a message sideways
  and it replies to that message, or opens it for editing if it is one of yours you can
  still change. The icon behind the message fades and grows in as you drag, so you can see
  which action is coming and how close you are to it; it changes colour once you have gone
  far enough, and sliding the message back puts it away without doing anything. It is **off
  until you turn it on**, under Settings → Appearance → Message gestures, where you also
  choose which way to drag: your phone already uses both screen edges for its own back
  gesture, so there is no direction that is free for everyone.

- **Room and space settings are tabbed.** Everything a room has used to be one long column
  in a narrow dialog; it is now General, Access and Bans, so finding the join rule no
  longer means scrolling past the topic. Saving still covers every tab at once — the Save
  button sits outside them, and a room that cannot be saved says why from whichever tab
  you are on.

- **A density setting.** Under Settings → Appearance, "Compact" tightens the spacing in
  the room shell, message list and composer so more of a conversation fits on screen. It
  never shrinks a touch target below the shared 44px floor.

- **The member list has a filter.** Type a name or a user id above the list to narrow it —
  useful in a room where scrolling to find someone was the only option. Large rooms also
  render far fewer rows at a time, so opening the member list in a busy room no longer
  builds thousands of rows up front.

- **Right-click or long-press a message for its actions.** The overflow set — pin, quote, copy,
  copy link, forward, view source, report, edit, delete — is now a right-click away on desktop,
  instead of only reachable through the small "⋯" button that appears on hover. (Reply, react
  and Reply in thread stay on the hover bar; the long-press sheet below carries all of them.) On a phone or
  tablet, where there is no hover and no right-click, a long press brings that same full set up
  as a sheet from the bottom of the screen: thumb-sized rows you can read, the six most-used
  reactions along the top, and a way to reach any other emoji. It rises from the bottom edge
  rather than floating over the timeline, it scrolls if your permissions make the list long,
  and picking something or tapping outside it puts it away.

  Highlight some text first and you still get the browser's own menu, because that is the one
  with Copy in it — and right-clicking a link or an image still gets you "Open link in new tab"
  and "Save image as…".

- **A third Theme: Onyx.** A neutral, achromatic Theme whose dark Mode is true black — on an
  OLED screen a black pixel is simply switched off, so it saves power and looks properly dark
  rather than dark grey. Pick it under Settings → Appearance, in either light or dark mode.

### Changed

- **Room administration, search, media, and auxiliary flows now use canonical design-system
  recipes.** Governance, members, widgets, pickers, polls, location, edit history, link previews,
  and the remaining Room dialogs, sheets, panels, and popovers keep their existing behavior while
  public recipes own their chrome. One-shot prompts and dialog results now use cold RxJS commands,
  every Room component style participates in the named cascade, and no Room consumer remains on a
  compatibility or cascade migration ledger.

- **Live Conversation surfaces now compose canonical design-system recipes.** Timelines, message
  rows, the composer and its suggestion popovers, reactions and their picker/dialog, media and
  voice attachments, reply and thread summaries, the message toolbar, typing, thread views,
  pinned messages, and the encryption prompt use named foundation sizes, canonical controls,
  neutral surfaces, and `danger` feedback while preserving virtualization, message and composer
  geometry, touch targets, and safe areas. Conversation confirmations and dialog results now use
  cold RxJS commands, and the slice's component styles participate in the named cascade.

- **Rooms workspace navigation now composes canonical design-system recipes.** The account picker,
  server rail, channel sidebar, room list, user panel, and workspace header use named avatar and
  icon sizes, canonical toolbar, button, menu, empty-state, overlay, and danger inputs while
  retaining their feature-owned wide, compact, touch, mobile, and safe-area geometry. Their
  component styles now participate in the named cascade, and navigation prompts, confirmations,
  and dialog results use cold RxJS commands without changing selection, unread, invitation,
  disabled, hover, or focus behavior.

- **Settings now composes Trinity's public design-system recipes.** Settings, Appearance,
  Advanced configuration, and their dialogs use canonical semantic button and overlay inputs,
  including `danger` feedback, while feature code owns only surrounding layout. Confirmations,
  prompts, lazy configuration loading, and one-shot actions use cold RxJS pipelines; component
  styles participate in the named cascade without changing validation, focus order, saving
  feedback, or the routed and dialog workspace layouts.

- **Authentication, Trust, startup, and host-shell surfaces now use Trinity's public recipes.**
  Their buttons, fields, cards, alerts, toasts, and modal surfaces use canonical semantic axes
  instead of vendor-shaped aliases or local appearance overrides. Alert results stay cold RxJS
  commands, component styles now participate in the named cascade, and focused interaction tests
  preserve the existing recovery, verification, routing, and startup behavior.

- **Runtime vendor styling now has named, audited seams.** The advanced configuration editor uses
  CodeMirror's supported theme extension instead of a global component override. CDK overlays,
  ng-icons, and the Sonner toaster remain behind Trinity's public wrappers, while a versioned
  architecture allowlist records their unavoidable runtime styles and inline geometry. Static CDK
  and emoji styles still enter the explicit `vendor` layer, and repository checks reject package,
  injection-mechanism, import-boundary, or seam drift without adding another global `!important`
  escape hatch.

- **Application styles now follow one explicit cascade.** Theme values, browser defaults,
  third-party styles, component defaults, utilities, and narrow invariants have a fixed order
  shared by the app and Storybook. Focus, disabled, responsive shell, and safe-area behavior no
  longer depends on an accidental unlayered rule; repository checks fingerprint every remaining
  component-style exception and browser checks prove the compiled precedence while later
  migrations remove them.

- **Appearance no longer carries its migration facade.** The obsolete platform Theme service,
  Palette-shaped API, direct preference writers, and legacy test hooks are gone. Current code uses
  Mode, Theme, and Appearance vocabulary through descriptor, projection, and effect interfaces;
  predecessor storage keys remain read-only migration metadata, and source guards prevent those
  bypasses from returning through document carriers, templates, or widget projections.

- **Appearance now follows one application-owned lifetime everywhere.** Startup hydrates the six
  descriptor-backed axes before routing and keeps one document/native effect subscription for the
  whole session. Advanced configuration exports and imports the current `appearance.*` values,
  with portable format 2 importing the former version 1 Theme paths through a one-way migration.
  The Capacitor status bar receives only resolved light/dark Mode, and widget links read that same
  read-only projection.

- **Appearance settings now saves every visual choice through one reliable model.** Mode, Theme,
  text size, density, code size, and code-line presentation keep the previous choice visible until
  persistence succeeds. A failed save shows Retry beside that control, while a restore problem
  produces one warning and repairs only the affected defaults without overwriting the other axes.
  Startup completes hydration before the route becomes available, and a fixed Mode remains
  authoritative when the system colour scheme changes.

- **Appearance rendering now has a safe boundary.** Mode, Theme, text-size, density, and code
  display updates reach the page only after they are saved, and a system light/dark change is
  ignored whenever a fixed Mode is selected. First paint remains unchanged.

- **Appearance preferences now keep their capability ownership.** Mode, Theme, text size, and
  density are independently persisted Design System descriptors, while Conversations owns code
  size and code-line presentation. One read-only application model composes all six values and
  their per-axis states without duplicating storage; an invalid or unavailable axis keeps its own
  default and contributes to one recoverable startup warning. The new versioned
  `trinity.appearance.*` identities upgrade from predecessor storage keys, and Theme choices
  are validated directly against the Theme Foundation catalog.

- **Preference storage keys now upgrade in one direction.** Capability descriptors can name
  ordered, read-only predecessor keys without exposing them through Settings. The current key
  remains authoritative; otherwise a valid legacy value is written into its current versioned
  envelope before it becomes visible. Invalid data and storage failures affect only that
  preference and return value-free recovery, and all later writes use only the current key.

- **Theme ownership now has one source.** Theme and Mode identity, defaults and preview metadata
  come from one read-only catalog, while one aggregate stylesheet owns the semantic token values
  and private Helm/Tailwind mappings. The application and Storybook consume those interfaces
  directly, Storybook derives all six fixed Theme/Mode previews from the catalog, and source guards
  prevent compatibility catalogs or root Theme definitions from returning elsewhere.

- **Local validation output is quiet and classified.** Nx commands now normalize contradictory
  color variables, Vitest configs are ready for Vite's native loader, component tests install
  deterministic browser APIs and the icons they render, and expected failure logs are asserted at
  their owning specs. Production browser floors, script budgets and Matrix SDK CommonJS dependencies
  are explicitly tracked; the oversized message-row styles were split into focused presentation
  children without weakening the shared component-style limit. Remaining generated and
  package-owned Capacitor compiler diagnostics are recorded in the contributor warning ledger.

- **Electron and Android E2E now have explicit lifecycle owners and unified local reporting.**
  `trinity-e2e-electron` owns the launched-shell smoke and full desktop suites, while
  `trinity-e2e-android` owns the emulator, installed-WebView fixture and native journeys; the host
  applications retain delegating targets only. Registry-driven pull-request, scheduled,
  environment and exhaustive aggregates now write one JSON/Markdown summary grouped by
  environment, capability and contract type, distinguishing retries, quarantine, unavailable
  hosts and tier skips from failures. Strict selections fail preflight before starting, while
  `e2e:all` requires every current suite and can continue only past a future suite explicitly
  classified optional. CI tiering,
  artifact roots, fixture boundaries and compatibility aliases are source-guarded; old commands
  remain until a documented, reference-free release cycle completes without migration failures.

- **Protocol E2E journeys now run as ordinary Playwright Test specs.** The
  `trinity-e2e-protocol` project owns all verification, crypto, media, relation, room,
  search and emoji flows with standard reports, traces, retries and attempt-scoped Matrix
  resources. The focused package commands remain compatible, the duplicated raw-script
  runners are gone, and an assertion inventory reconciles all 209 pre-migration checks after
  centralizing 21 duplicated login and replace-safe toolbar checks.
  Mutating flows can also target an explicitly selected remote HTTPS homeserver when complete
  credentials are supplied; validation errors and reports never include password values, and
  traces stay disabled so authenticated request tokens cannot enter artifacts.

- **Canonical browser journeys now have capability ownership.** The new
  `trinity-e2e-browser` project groups 110 independently focusable specs under accounts,
  workspace, room library, room administration, conversations, trust, identity, notifications,
  discovery/search, settings, and host shell. Ambiguous mobile-navigation and pinned-message
  files have behavior names, while the multi-account, Settings, and room-settings catch-alls are
  split around shared support-owned setup. A typed catalog classifies every file by capability and
  primary contract, a reporter emits per-test annotations and grouped JSON coverage, and
  source-shape guards preserve all 266 tests and 1,782 assertions while keeping Android's shared
  collection explicit. The one Synapse-owning Nx target remains uncached, serialized, and limited
  to two Playwright workers; path and test-name arguments provide focused execution.

- **Web/PWA and visual browser contracts now have lifecycle-owned Nx projects.**
  `trinity-e2e-web` owns production startup, routing, service-worker, offline-shell and renderer
  coverage; `trinity-e2e-components` owns Storybook, styling and cross-browser scrollbar targets.
  Small configs compose the shared invocation/report builders, while retained public
  commands delegate through registry-checked compatibility aliases. Historical phase names are
  gone from executable test paths and selectors. Playwright evidence now lands under
  `dist/.playwright/<project>/<run-id>/` with registry metadata plus mergeable blob and JUnit
  reports, and production renderer reuse is manifest-verified before Web, Electron or Android
  consume the shared payload.

- **System-level tests now have one executable ownership contract.** A typed E2E registry
  classifies all 22 current browser, Web/PWA, component, protocol, Electron and Android suites by
  lifecycle, capability, prerequisites, CI tier, serialization, timeout, artifacts, commands and
  destination project. Canonical `pnpm e2e`, `e2e:all` and environment commands run only through
  uncached Nx targets after registry and prerequisite preflight, while existing focused commands
  remain guarded compatibility aliases. Mutation-tested source guards now reject unregistered
  resolved Nx targets or CI entrypoints, cacheable runtime results, missing annotations, stale
  spec counts, undefined resource ownership, command drift and expired quarantine. Unsafe
  fixed-port Playwright target atomization is disabled, shared fixed-port drivers use explicit
  cross-process serialization, and registry timeout classes terminate their owned process groups.

- **E2E processes now have one lifecycle owner.** The new `trinity-e2e-support` project binds
  dynamic application, Storybook and report endpoints, publishes a validated private session,
  starts the fixed-port Synapse stack once per aggregate, and makes every child join without
  restart or teardown authority. Browser, Android and Electron fixtures no longer import one
  another, protocol compatibility entrypoints share one runner, per-attempt resource namespaces
  isolate multi-client data, and bounded cancellation, stale-lock recovery and aggregate cleanup
  failures are executable contracts.

- **The capability-centered architecture is now contracted and enforced.** All migration
  exception ledgers and secondary entrypoints are empty, rich message kinds use one normalized
  presentation path, and native preferences, push registration, external browsing, and platform
  detection stay behind Trinity adapters. Native push taps now emit semantic destinations for
  Application Runtime and Workspace to navigate instead of routing from data-access; the runtime
  session owns the native listeners and their exact teardown, and settings checks plugin
  capability rather than the device OS. Structural
  guards hard-fail SDK, Router, platform-vendor, UI-vendor, host-composition, and retired legacy
  import escapes, while the generated Nx dependency map records the final graph.

- **Electron is now a first-class Nx host application.** `trinity-desktop` exposes the
  standalone dependency install, compile, typecheck, unit test, shared-renderer build, launch,
  verification, serialized Playwright and host/platform packaging lifecycles without duplicate
  inferred package-script targets. Existing `pnpm electron:*` commands delegate to those targets,
  and the normal module-boundary rule now covers the shell. A Docker-independent launched-shell
  journey verifies the `trinity://app` scheme, streamed crypto WASM, custom-protocol dark styling,
  protocol-v1 capability negotiation, bounded grouped preload surface, renderer isolation, secure
  storage and scoped CORS. Every privileged preload operation now stays inert until its latest
  accepted negotiation grant, while file export, lifecycle and update checks flow through shared
  cold Observable host contracts. The existing sender checks, ASAR/fuse hardening and explicit
  unavailable Back/update operations remain intact.

- **Android and iOS are now first-class Nx host applications.** `trinity-android` and
  `trinity-ios` expose discoverable build, sync, run, static verification and native-toolchain
  verification targets while continuing to consume the one production `www/` renderer through
  Capacitor. Existing `pnpm android:*`, `pnpm ios:*` and Android WebView journey commands now
  delegate to those targets. An executable native-host contract pins project ownership, shared
  artifact flow, plugin/deep-link wiring and host scripts. Capacitor capability negotiation now
  advertises hardware Back/backgrounding only on Android; iOS keeps those operations and update
  checks explicitly unavailable while retaining native history gestures.

- **The Web/PWA host is now a thin composition root.** `apps/trinity` selects routes,
  environment/build values, cold application-surface loaders and the Web-only service worker;
  `@trinity/application/runtime` owns the concrete startup/session adapters, Workspace presenters,
  cross-capability providers and lifetime subscription behind `provideTrinityApplication()` and
  `startApplicationRuntime()`. The production build still emits the same flat `www/` artifact
  consumed unchanged by Capacitor and Electron. A Docker-free `trinity-e2e-web:production-pwa` Nx target now
  verifies production startup, unknown deep-link repair, the installable manifest, service-worker
  control, offline shell routing and cached crypto WASM. Poll presentation now accepts the deeply
  immutable Conversations model, restoring a green production Angular compilation.

- **The shared design system now has five stable category entrypoints instead of dozens of
  shallow component projects.** Foundations, controls, generic content, navigation/layout and
  overlays retain the same `trn` APIs while keeping Spartan, CDK, ng-icons and the emoji vendor
  internal. Public barrels use named exports and an executable ownership contract prevents new
  shallow projects or migration exceptions. Message media and the message toolbar now live with
  Conversations; Settings and Trust presentation stay in app/Application Runtime composition,
  whose lazy feature loaders are cold RxJS Observables.

- **Discovery and search now have capability-owned boundaries.** The new
  `@trinity/data-access/discovery` boundary owns `.well-known` homeserver resolution, paginated
  public-room and Space lookup, room-link preview and bounded remote user-directory search.
  Room Library owns the Quick Switcher's ranked local room, Space, DM and invite index, while
  Conversations owns E2EE-honest loaded-message matching and paginated server search. The
  Quick Switcher remains available with the same destinations and navigation behavior, but now
  consumes an `@trinity/application/search` session that owns RxJS debounce, cancellation,
  loading, truncation and safe per-group failure state and emits fully qualified Workspace
  search intents. Workspace resolves every selected Room, Space, person or invitation on its
  exact Account. Message search is attached to the immutable Account-and-Room Conversation child,
  so an Active Account transition cannot retarget an in-flight search or scrollback.
  Post-create and post-invite navigation waits for the exact Account's SDK graph through a cold,
  bounded Room readiness barrier; stopped sync and deadline failures tear down listeners and
  reach the existing safe search error state instead of repairing away the new Room or hanging.
  Authentication reaches pre-login Discovery through a narrow composition-root port, so the
  capability graph stays free of cross-capability exceptions.

- **Profiles and presence now live behind Identity.** Stable safe user summaries, own-profile
  changes, arbitrary public-profile lookup, presence and ignore state now use the explicit
  `@trinity/data-access/identity` boundary through a lifecycle-free Matrix port. Remote directory
  search belongs to Discovery, and feature callers no longer reach the Matrix client for Identity
  state. Avatar bytes upload through Media before Identity publishes the resulting
  `mxc://` reference. Room Administration retains membership and power, with its contextual
  display name and avatar explicitly marked as Room-scoped rather than duplicated as global
  profile ownership. Identity commands remain cold RxJS Observables with typed offline,
  unavailable, not-ready and server-failure behavior.

- **Verification and recovery now live behind the Trust boundary.** Encryption health, device
  management, QR/SAS verification, cross-signing, secret storage, recovery reset, and room-key
  transfer now use `@trinity/data-access/trust` through a lifecycle-free Matrix crypto port.
  Account connection and crypto-machine startup remain in the Matrix adapter; Trust screens no
  longer consume authentication lifecycle services directly. All Trust commands are cold RxJS
  Observables with typed, secret-safe recovery guidance, and QR payload bytes are emitted once to
  transient page-local presentation state instead of being retained in the application signal graph.

- **Room governance now lives behind Room Administration.** Joined-member summaries, roles,
  moderation, aliases, power-level policy, room configuration, and Conversation pin/redaction
  decisions now share the explicit `@trinity/data-access/room-administration` boundary. Member
  and ban rosters reconcile only from authoritative Matrix room state; moderation no longer edits
  membership views optimistically. Commands remain cold RxJS Observables and expose typed recovery metadata
  for live permission changes, invalid input, homeserver rejection, and partially completed avatar
  updates. Conversation and Room Library reach governance only through application-composed policy
  ports, and the former governance exports have been removed from the Discovery and Room Library
  entrypoints.

- **Room relationships now live behind Room Library.** Joined room and space summaries,
  invitations, account scope, favourites, ordering, filtering, hierarchy, mixed-account
  projections and aggregate unread state now share the explicit
  `@trinity/data-access/room-library` boundary. Account-scope and ordering preferences,
  favourite/priority writes, hierarchy changes, and unread cleanup are cold RxJS operations
  whose persistence or SDK failures remain observable by their callers.
  Workspace, Settings, Search, badge coordination and application startup consume that boundary
  instead of the broad legacy rooms service; the standalone invites entrypoint and its migration
  allowlist are gone. Remote discovery remains in its narrower rooms adapter for the follow-up
  Discovery migration.

- **Native notifications and unread badges now share capability contracts.** Live notification
  intents are presented through Web Notifications, Capacitor Local Notifications, or Electron's
  validated protocol-v1 main-process operation, with the same typed activation destination on
  every host. Android and iOS now register the local-notification plugin; Electron waits for an OS
  shown/failed result instead of reporting success after a one-way send. `BadgeCoordinator` is a
  separate application workflow that reads Room Library's aggregate unread signal and writes only
  through `BadgeSink`, so Notifications no longer owns or imports badge state. Permission,
  presentation, and badge failures become non-blocking Application Runtime warnings without ending
  notification activation or Workspace navigation.

- **Web notifications now travel as typed intents.** Matrix events, push-rule results, foreground
  visibility and bounded deduplication are normalized before a platform-free Notifications policy
  decides delivery. A host presenter owns permission, service-worker or constructor delivery, and
  validated activation. Clicking a notification carries its exact Account, Room and event into
  Workspace, which switches Accounts, repairs missing destinations and anchors the Conversation;
  Application Runtime owns the stream across sign-out, later login, restart and teardown.

- **Startup now runs through one explicit Application Runtime.** Host negotiation, preference
  hydration, Account restoration, optional session capabilities, Workspace restoration and final
  readiness run in one ordered cold RxJS workflow. Required failures expose executable typed
  recovery, while push, badge and update failures remain visible, non-blocking warnings. The
  runtime owns deep links, Back handling, route focus, badge projection, space-order hydration,
  update watching and Workspace surface registrations until explicit shutdown, and can restart without
  retaining subscriptions. The app entrypoint now supplies the production adapter, starts the
  runtime, and holds initial Router navigation until startup reaches the Workspace stage.

- **Privacy settings now come from capability-owned typed preferences.** Conversations declares
  the ownership, installation scope, defaults, validation, versioned migration, sensitivity,
  storage/export policy, and toggle editors for read receipts and link previews. A shared
  Preferences Store hydrates context-keyed signals and runs writes as cold RxJS commands with
  typed, secret-safe recovery, while Settings renders the catalog without owning raw keys or
  product policy. Existing stored values migrate into versioned envelopes without changing the
  user-visible Privacy journey.

- **Host integrations now have explicit operation contracts.** Authentication handoff, deep links,
  Back, file export, notification presentation, location, app badges, secure storage, lifecycle,
  and updates publish supported or unavailable capability outcomes instead of relying on optional
  platform methods. The app-wide unread badge is the cross-host tracer: one cold RxJS command selects
  Web Badging, Capacitor, or Electron at composition and shares one adapter contract suite. Login
  handoff, deep links, host Back, and notification presentation now use the same selected operation
  seam, while file export and location callers ask platform adapters about capability semantics.
  Electron negotiates protocol v1 with validated senders, grouped capability APIs, and a dedicated
  badge IPC channel whose hostile or failed responses are normalized to stable, secret-safe codes.

- **Back now follows semantic Workspace surfaces instead of registration timing.** Application
  surfaces such as Settings and encryption, nested Room panels, and the compact Conversation have
  typed identities and a fixed dismissal order before browser history or native host fallback.
  Settings and trust actions use cold RxJS commands with semantic return destinations; the app
  alone maps those intents to lazy dialogs or canonical routes. Cold deep links now return to a
  valid Workspace root rather than minimizing a native app with no history.

- **Room destinations now stay coherent in links, reloads, Back, and Account switches.** Workspace
  owns one atomic Account, sidebar, Room, and pane view and projects it into a canonical URL, so a
  deep link can select an inactive Account and exact Room without briefly exposing mixed state.
  User navigation adds history while malformed, legacy, or unavailable destinations repair the
  current entry. Moving between compact and wide layouts changes placement without changing the
  destination or adding a history entry.

- **Threads and pinned messages now belong to the exact Conversation.** Thread lists and pins
  no longer follow mutable root services: Conversation Runtime exposes keyed Account-and-Room
  children, with an additional immutable root key for an opened thread. Navigation, Account
  switching, blur and eviction release stale thread generations, and cold RxJS commands reject
  instead of retargeting. Thread reactions, redactions, retries, receipts and staged attachments
  reuse the shared message and Media Pipeline adapters. Pin changes delegate current RoomState
  permission policy and publish only server-authoritative `m.room.pinned_events`; the former
  pinned-message library and thread action facade are removed.

- **Message actions now stay with the exact Conversation that owns them.** Replies, edits,
  reactions, deletions, failed-send retries and main-timeline read acknowledgements no longer act
  through a mutable focused-room singleton. They run as cold, typed RxJS commands bound to an
  immutable Account-and-Room handle, re-read SDK-authoritative relations when subscribed, and
  return safe retryability without leaking Matrix errors or event content. Room Administration
  supplies redaction decisions through an application-level port, while public/private receipts
  and the fully-read marker share the same exact-Conversation adapter.

- **Encrypted attachments now cross one Media Pipeline from composer to display.** Picked,
  pasted, dropped and downloaded GIF files are staged as opaque references, then sent through
  the exact Account-and-Room Conversation as cold RxJS progress streams with typed validation,
  cancellation, retry and terminal outcomes. An unchanged retry resends the SDK's failed local
  echo; confirmed cancellation or an edited caption keeps the upload but rotates the Matrix
  transaction id. Message Presentation exposes only safe render metadata—never MXC URLs,
  encrypted-file descriptors, keys, IVs or hashes—and media rows
  resolve display/download bytes back through the bounded pipeline cache. Gallery acquisition
  and file export now sit behind platform host-media adapters.

- **Writing text now stays with the exact Conversation that owns it.** The main room composer’s
  durable draft, reply or edit target, typing ownership and send lifecycle now live on its
  immutable Account-and-Room handle, so switching rooms or accounts cannot retarget an in-flight
  send or discard parked intent. Sends are cold RxJS commands with typed rejection and duplicate
  outcomes; Trinity clears intent only after the Matrix SDK accepts the event and exposes its
  authoritative local echo. The persisted snapshot is not cleared while delivery is pending;
  rejection or SDK-confirmed cancellation restores it for retry, while an event that may already
  be on the wire is never falsely restored into the field. The component still owns the textarea
  caret, focus, autocomplete and formatting toolbar.

- **Text and room activity now cross a dedicated Message Presentation boundary.** Matrix
  events are normalized into bounded plain records before Conversations renders them, and
  text, formatted messages, system changes, authenticity shields and malformed-event
  fallbacks become immutable presentation models. Sanitization, link-preview URL policy and
  syntax highlighting are applied inside that boundary, while the timeline, threads and
  message components no longer consume the legacy shared message projection directly.

- **Open rooms now run through immutable Conversation handles.** A handle is keyed by exactly
  Account and Room, owns its own timeline child and remains anchored to the Matrix client that
  created it instead of following a global active-client pointer. Workspace focus controls read,
  typing and action effects; blurred conversations keep a compact warm projection in a
  two-entry per-Account LRU, while eviction and application teardown permanently release their
  listeners. Room links, notifications, search, tombstones, reactions, source inspection and
  message actions now consume the focused child interface rather than a retargetable root
  timeline singleton.

- **Account sign-out and installation reset now run through Account Runtime.** Sign-out always
  targets one explicit account, keeps surviving accounts coherent, and reports safe recovery
  guidance when cleanup is partial. Erasing an installation still clears only Trinity's approved
  account, crypto, preference, secure-storage, IndexedDB, and service-worker scopes, now as a cold
  RxJS command that never exposes raw database names or secret-bearing failures to the UI. The
  temporary authentication lifecycle facades and their dependency exceptions have been removed.

- **Account switches now commit as one coherent Workspace transition.** Trinity first moves to a
  safe room-shell fallback and releases the outgoing conversation, then Account Runtime persists
  and activates the target Account, reattaches every live active-Account projection through
  Projection Runtime, waits for their generation acknowledgements, and finally repairs the
  requested room or space. Identical concurrent switches join one attempt; conflicting rapid
  switches and unavailable targets return typed outcomes instead of racing or queuing. Work may
  be cancelled before commit, while a started commit always finishes its projection cleanup.

- **Account readiness now includes a Projection Runtime barrier.** Projection lifecycle is
  bounded to active-account, all-live-accounts, exact-account, and exact-conversation scopes, with
  generation-safe publishing, coalesced cold RxJS reconciliation, deterministic acknowledgement,
  cancellation, reset, and resource diagnostics behind one runtime interface. Matrix sync state is
  the first production projection: each live Account retains one listener and at most 40 bytes of
  deterministic published-plus-pending payload with no duplicate SDK store, and Account startup completes only after that
  projection acknowledges its current generation within the 16 ms local barrier baseline.

- **Successful authentication now establishes Accounts through Account Runtime.** Password,
  SSO, OIDC, and registration flows hand over an opaque authenticated grant instead of writing
  credentials or starting Matrix clients themselves. Account Runtime persists and starts the
  Account before committing its requested active placement, joins identical in-flight attempts,
  and reports lifecycle conflicts and recoverable startup failures as typed outcomes. Existing
  saved sessions retain their crypto-store prefixes and remain compatible with cold-start restore.

- **Saved accounts now recover through one bounded startup flow.** Trinity starts the active
  account first while restoring the others concurrently, and one offline, expired, corrupt, or
  encryption-broken background account no longer disappears into a silent best-effort path.
  Every saved account reaches a terminal outcome under a deadline; an active account that needs
  sign-in still returns to login, while healthy inactive accounts remain available.

- **The public design system now has an executable ownership contract.** Foundations, controls,
  overlays, navigation and layout, and generic content each have an explicit Trinity entrypoint;
  product-specific components carry removal owners and follow-up tickets instead of silently
  becoming permanent shared UI. The sign-in screen is the first production tracer: its field
  composition and labels now come through the public tier, with source, interaction and
  accessibility checks guarding the boundary.

- **The architecture migration now has an executable contract.** Trinity's domain language,
  capability ownership, dependency roles, runtime seams and migration policy are recorded in a
  glossary and accepted decisions. Every shipped Nx project now carries target role and capability
  metadata alongside the existing layer tags; a generated dependency map freezes today's eight
  cross-capability edges, multi-capability projects, public secondary entrypoints and source-size
  ceilings so the incremental migration can shrink exceptions without silently adding new ones.

- **Scrollbars now look like one family everywhere.** Timelines, sidebars, dialogs, pickers and
  horizontal overflow use the former room-container design: an 8px rounded thumb in the active
  palette's rail colour over a transparent track. Firefox keeps its platform-native thin geometry.
  Intentionally hidden bars in the Settings directory and dropdown panels remain scrollable.

- **Visual review files no longer live in the source tree.** Design exploration, screenshots, GIFs
  and pixel baselines are kept out of the repository. UI proof is uploaded directly to pull
  requests, while automated coverage uses semantic, contrast, responsive and measured-layout
  checks against the real application.

- **Chat messages are easier to read at the default text size.** Conversation prose now starts at
  16px with 1.5 line spacing, while compact authors, timestamps, replies and navigation chrome keep
  their existing hierarchy. The Appearance preview uses the same message typography as the live
  timeline, and every Text size option continues to scale it from the browser or device default.

- **Settings content now follows the modern grouped hierarchy.** Appearance combines a compact
  conversation preview, a segmented mode picker and labelled two-column control rows, while every
  section gains a clear title and supporting description. Related controls use calmer group
  headings, switches sit on the logical trailing edge, and select fields expose their visible
  labels to assistive technology. Select values and switch labels retain readable theme-aware
  foregrounds in dark mode. The dialog title shares the navigation pane's inline inset in both
  density modes and right-to-left layouts. The layout remains contained at 125% text and Compact
  density.

- **Read-receipt avatars keep the full timeline edge beside authenticity shields.** A shield now
  reserves space only beside the message content; the “seen by” row spans underneath it and remains
  aligned to the trailing edge in both left-to-right and right-to-left interfaces. Both controls stay
  in normal layout flow, so virtualized timeline measurement includes them without covering text.

- **Icon buttons now behave as one family.** Standard square actions and purpose-built controls
  such as reaction chips, server-rail pills, avatar actions, composer controls and the floating
  message toolbar use the same pointer cursor, hover and pressed surfaces while preserving their
  meaningful resting shapes and contextual contrast. Custom controls also keep their glyphs
  centred inside the full hit target, including Settings in the floating account dock. Icon labels in
  navigation, member, receipt and message actions now use Trinity's themeable tooltip instead of the
  browser's native one, and shared tooltips keep a dark, readable surface when dark mode is selected.
  Tooltips in vertically stacked lists open sideways instead of covering the previous control, while
  sticker shortcodes stay visible below their images without a floating overlay. Each action gets a
  small semantic glyph
  motion—for example, Back nudges left, Settings rotates and Search pops—with keyboard parity and a
  static reduced-motion fallback that never shifts the control.

- **The modern interface is now hardened across the supported screen sizes.** The quieter layered
  room shell, responsive auth and encryption tasks, grouped settings workspace, compact density and
  floating pickers now share one tested visual system from 1440px desktop windows down to 320px
  phones. Light, dark, Onyx and Amethyst are covered across that matrix, including 125% text and
  keyboard, forced-colour, reduced-motion and genuine WebKit paths. The Electron and Android
  wrappers are also checked against the exact same production web payload rather than independent
  rebuilds, with unexpected wrapper files rejected.

- **Sign-in, encryption and secondary surfaces now share the modern interface.** Authentication
  and registration use a roomier, branded task card; encryption setup, recovery and verification
  use the same bounded routed surface and a distinct scroll-safe dialog treatment. Security
  warnings and recovery keys remain the strongest elements in those flows. GIF, sticker, emoji
  and user pickers now share the floating-surface vocabulary, and the full-screen image viewer
  adds a visible Close control without changing Escape or backdrop dismissal. Incoming device
  verification dialogs now announce their purpose to assistive technology.

- **Interface controls now go through Trinity's public component tier.** Buttons, dropdown
  menus and the toast viewport keep the same behaviour and appearance, but feature code no
  longer imports the vendored Helm kit directly. The lint boundary now has no exceptions.

- **The composer insert menu now follows the device.** On iOS and Android, including mobile web
  and installed PWAs, the `+` opens a thumb-sized bottom sheet for files, GIFs, stickers, polls,
  location and voice. Desktop web and Electron keep the compact anchored menu. Dismissing the
  sheet or choosing an action without a successor restores focus to the `+`; GIF, sticker and
  poll choices transfer focus into the picker or dialog they open. Switching rooms or changing
  any action's availability closes stale choices and restores the viable replacement trigger.

- **Settings opens over your work on web and desktop.** Web and Electron now present the grouped,
  bounded Settings workspace as a named dialog without changing the room URL. Escape, the
  backdrop and the visible Close button dismiss it; keyboard focus stays inside and returns to
  its opener. Short windows keep overflow in the detail pane, and narrow web windows retain the
  one-pane directory drill-in inside the dialog, including nested device-verification and recovery
  overlays. Failed or superseded dialog loads leave the current room in place. Installed Android
  and iOS apps, bookmarks and direct `/settings/...` links keep the routed flow. Appearance still
  includes the live theme, palette, text-size, time-format and density preview.

- **Messages and the composer now share a clearer conversation hierarchy.** Message bodies,
  authors, timestamps, replies, threads, reactions, receipts, status rows and typing/divider
  chrome now consume semantic type, surface, state and density roles. The floating message
  toolbar is narrower and raised over the row boundary, allowing message bodies to use the
  full timeline width without changing measured row heights. Its actions remain fully
  hit-testable on short grouped rows, clamp to the live scroll edge and flip quick reactions
  toward available space; hybrid touch desktops retain a non-overlapping 44px action track.
  Reply/edit context, attachments and the input read
  as one composer surface. Edit mode has a touch cancel action, and voice recording moves
  keyboard focus into and back out of its replacement controls. Growing the composer or opening
  the software keyboard keeps an exactly bottom-pinned conversation at the newest message and
  preserves every scrolled-up reading position in both the simple and virtual timelines.

- **The conversation shell is calmer and more compact.** The space rail, room list,
  conversation header, member list and account dock now share recessed semantic surfaces,
  clearer selected and pressed states, stable space squircles and density-aware spacing.
  Resizable pane widths and virtualized member-row measurements stay unchanged, and Compact
  density never reduces a coarse-pointer target below 44px.

- **The desktop account dock now floats above navigation.** Web and Electron inset the
  bottom-left identity panel as one raised surface across the Space rail and room sidebar,
  while reserving enough scroll space that the last Space, room and keyboard-focused row stay
  visible. Phones keep the touch-first panel in normal flow above the device safe area.

- **Shared controls now use one modern interaction language.** Floating message actions, status
  banners and file attachments share tokenised hover, press, focus, disabled, shape, type and
  density roles. Keyboard focus uses a measured high-contrast ring in every theme, and Compact
  density now tightens these pieces of chrome without shrinking touch targets.

- **People and places now keep distinct, stable avatar shapes.** People and direct messages stay
  circular, while rooms and spaces use squircles throughout navigation, search, directories and
  settings. Selecting or hovering a space no longer changes its fundamental shape; background,
  indicator and focus states carry selection instead.

- **Menus, tooltips and the indeterminate progress bar now hold still on their own for
  reduced motion.** They already did, but only because a blanket rule elsewhere in the app
  was catching them; each now asks for it directly, so the behaviour survives the component
  being used anywhere else. A progress bar that knows how far along it is still relies on
  that blanket to stop its fill sliding.

- **Clicking a mention opens the person's card beside it**, instead of a window centred
  over the conversation the mention is part of — so you can still read what was said while
  you look at who said it. On a phone it stays centred, where there is no room beside
  anything.

- **Opening an image gives it the whole screen properly.** The full-size view is now a
  real dialog: the page behind it does not scroll, Escape closes it, and the keyboard
  stays inside it. A message arriving underneath no longer slams it shut.

- **Signing in through your homeserver looks like signing in.** The page you land on
  while the redirect completes now wears the same card and wordmark as the sign-in form,
  rather than a bare spinner on a blank background.

- **Settings toggles are switches now.** Every preference you can turn on and off — appearance,
  privacy, notifications, the experimental flags — is a switch rather than a tick box, because
  each takes effect the moment you touch it and there is nothing to submit. A screen reader now
  announces them as switches too, which is the same thing said out loud. The four places that
  really are "pick some of these" keep their tick boxes: adding rooms to a space, managing a
  space's rooms, the room history options, and confirming you have saved a recovery key.
- **The "nothing here yet" messages all look the same now.** Fourteen places tell you a list is
  empty — no messages in a channel, no threads, no pinned messages, no search results, nobody in
  a space — and each had drifted into its own size and spacing. They are one panel now, at one
  size. The wording is unchanged everywhere; what moves is that the largest of them (the empty
  channel, an empty thread) are set at the same size as the rest rather than a few pixels larger,
  and the tightest gain a little breathing room.

- **The composer's buttons live inside the message box.** The `+`, emoji and send buttons used
  to sit outside the box you type in, flanking it. They are inside it now, so the whole thing
  reads as one control: pressing anywhere in it — including the empty space beside the buttons
  on a long draft — puts the cursor in the text, and the focus outline is drawn around the box
  rather than around a bare field sitting in it. Switching to the preview no longer nudges the
  composer up and down by a few pixels.

- **One panel at a time down the right-hand side.** Threads, a thread, pinned messages and
  in-room search used to open as floating panels _over_ the member list, so you could end up
  with two lists stacked on each other and no clear way back. There is now a single
  right-hand space, and whatever you ask for takes it: pressing Threads while the member list
  is up swaps to threads rather than covering it. Clicking someone in the member list opens
  their info in that same space — closing it puts the member list back, so you can watch a
  role change land in the list you were reading. Escape closes whatever is showing, and
  closing it hands the keyboard back to the button you opened it with.

- **The formatting buttons show what your selection already is.** Select some bold text and
  the **B** is lit; select plain text and it is not. Pressing a lit button takes that
  formatting off again, so the bar reads as the state of what you have selected rather than as
  a record of the last button you pressed. Link and code block do not light up, because there
  is nothing to switch off — pressing them always inserts.

- **The formatting toolbar comes when you need it.** It used to be a row that was either always
  there or never there, with four buttons out and the other five hidden behind a "⋯". Now
  selecting some text brings up all nine — bold, italic, strikethrough, inline code, code
  block, quote, link, bullets and a task list — grouped by what they do, and it goes away again
  when the selection does. If you would rather it simply stayed put, **Aa** on the bar keeps it,
  and Settings → Appearance has both switches: keep it open, and bring it up on a selection.
  Turning both off means the buttons never appear, which is what people who had already hidden
  the toolbar were asking for and what they will still get. The keyboard shortcuts work either
  way, as they always have.

- **The composer now tells you which slash commands exist.** Typing `/` at the start of a
  message brings up the list — `/me`, `/shrug`, `/plain`, `/spoiler` — each with what it does
  and what it takes, so you no longer have to already know the name to use one. Typing more
  narrows it, the arrow keys move through it, Enter or Tab fills the command in, and Escape
  puts it away. It only offers a command where one would actually work — at the start of a new
  message, never mid-sentence, and not while you are replying, editing, or captioning an
  attachment, because those are sent as written.

### Fixed

- Older-history loading indicators preserve the reader's latest timeline position even
  when the browser has not yet delivered its scroll event.

- Thread connectors reach the group's existing avatar through intervening messages,
  tall images, earlier thread previews, and unread markers without repeating the avatar.

- Thread previews give the same username the same width allowance across short and long
  replies, and their connector uses the same theme color as ordinary reply connectors.

- Loading older timeline history preserves deliberate reading offsets even near the bottom.
  Jumping to the latest message cancels pending history corrections so they cannot pull the
  reader back to an older message.

- Images load again when returning to a retained Conversation after switching Rooms. Media
  references survive view-cache cleanup while decoded URLs and staged uploads are still released;
  removed or replaced Account clients cannot resolve old references.

- Cross-user verification waits for the other user's identity to reach the crypto store,
  preventing startup failures during slow key refreshes. Startup is bounded and cancelled
  on session teardown; late requests cannot appear after leaving or changing Accounts.

- Startup no longer loops when an unsupported app badge reports its health
  synchronously, including on Android WebView and WebKit. Badge updates track
  unread totals without subscribing to signal reads made by outcome consumers.

- Trust health refreshes when account data changes, so a recovery reset followed by
  reload cannot remain stuck on stale secret-storage readiness.

- Virtualized timelines retain the reader's message position while newly prepended
  history finishes measuring. A reader who scrolls during an outstanding history request
  transfers its restore point to the new position. User scrolling after restoration and
  room changes cancel the previous correction.

- Back from routed Settings can return to Rooms without a second semantic dismissal
  cancelling the history navigation. Overlay dismissal guards still run first.

- Production renderer checks wait for the usable login form and verify the current
  mobile System Status control. Electron settings geometry checks use the shared
  Settings directory hook after the layout migration. Electron restart checks open
  System Status from the sidebar. Historical-notification checks now count presenter
  calls before and after restart. Browser installation-reset and Settings journeys
  follow the current confirmation, navigation and save controls, and key-import
  assertions distinguish the toast from its accessibility announcement.
- Browser touch checks preserve the touch pointer type and wait for ordinary controls
  to settle; only unavailable-action feedback bypasses the enabled check. Android unavailable-action taps
  allow legitimate drawer pointer capture, while wide-layout gestures use the viewport
  owner's connection and scaled physical coordinates. SSO and responsive Members controls
  use that input path; shell checks distinguish an open pane from rows still rendering.
  Reapplying an unchanged Android viewport tolerates pixel-ratio rounding and preserves
  open panes instead of briefly switching to the phone layout.
- Storybook theme checks wait for the selected theme and mode to reach the document
  root before checking semantic colours, avoiding a read during preview initialization.
- Android test controls guard touch targets through activation, dismiss the native
  keyboard before lower address actions, and feed deterministic native GPS updates. Screenshot capture preserves the configured viewport after Android
  resets its emulated metrics. Desktop-only interaction and development-hook fault injection cases
  no longer run against the production Android APK.

- System Status no longer floats over message-composer controls. It stays available as an icon immediately
  left of Settings in the sidebar and in the mobile conversation's More actions menu, with emphasis
  when a capability needs attention. Startup and problem-banner access remain available.

- Electron allows persistent storage for its trusted main window, preventing the
  “Protected browser storage is unavailable” warning when restoring a signed-in Account.
  Remote content and child frames remain denied.

- Storybook accessibility checks retain their injected Axe instance when the addon replaces
  the global during a scan. A regression exercises both owners without disabling accessibility
  checks. The repository media guard also distinguishes the four managed prototype-skill
  instruction files from forbidden design and review artifacts. Shell overflow checks reopen
  the member pane after the intentional transition into drawer layout.

- **Message swipe journeys no longer lose the edit gesture under parallel browser load.** The
  shared synthetic touch driver now advances with Chromium's renderer frames, and fresh-account
  journeys wait for the encryption banner before measuring message geometry. Touch paths now
  reach the application without being coalesced or displaced by a late layout change.

- **A fresh Electron login no longer reports one host-capability failure per historical
  notification.** Local notification delivery now waits for each Account's first successful sync
  transition instead of treating the SDK's initial-history `liveEvent` markers as new messages;
  genuine messages received after readiness still notify normally.

- **Prompt length limits no longer break application builds.** Shared Overlay prompts now model
  their optional maximum length in the Signal Forms schema, preserving native input limits and
  validation without the forbidden template binding that caused Angular `NG8022`.

- **A stalled native badge plugin can no longer hold the app on “Restoring your session…”.** Badge
  support, permission, and update calls now have a finite bound, report typed secret-safe outcomes,
  and discard timed-out readiness attempts so later startup attempts can probe again.

- **Repeated Android SSO launches no longer wait for a Custom Tab that already exists.** The
  installed-WebView adapter now recognizes both a new Chrome page and navigation of a reused tab,
  so rejecting a forged callback cannot make the legitimate provider continuation time out.

- **Fast Android OIDC redirects no longer look like a missing Custom Tab in local E2E runs.** The
  installed-WebView adapter observes external page creation and main-frame navigation throughout
  the authentication trigger, including a provider tab that redirects back and closes between
  polling samples, without extending the journey timeout or retrying the action.

- **Android virtual-timeline fixture positioning now survives WebView's one-pixel rounding.** The
  long journey returns through the product's jump-to-latest action while keeping its bottom-pin and
  deliberate-reading-offset assertions strict.

- **The room-unban journey now identifies the visible confirmation notification precisely.** Its
  assertion no longer collides with CDK's visually hidden live-announcer copy of the same message.

- **Long installed-Android journey runs now fail once at the lost host boundary instead of
  cascading across later tests.** Runner-owned API 36 emulators use a cold software-GLES,
  Vulkan-disabled launch; consecutive device-health probes and fixture failure markers stop a
  lost emulator, Playwright driver, app process, or WebView with process, memory, graphics,
  activity, WebView, logcat, and crash diagnostics. Reloads and relaunches wait for a finite
  routed surface; a stalled document receives one bounded recovery before the suite records the
  application-surface failure. Unrelated Android system-process crashes no longer fail Trinity
  journeys.

- **The homeserver-free SAS self-check runs without disposable Matrix credentials again.**
  Standalone protocol checks now join only the application lifecycle, while mutating journeys keep
  their attempt-scoped Accounts and secret-redacting diagnostics. A failed Continue response also
  records the current URL, button states and alerts before checking the guarded verification route.

- **Selecting the Room already open no longer reports a navigation error.** An exact Workspace
  selection is now a successful no-op: it neither writes duplicate browser history nor releases
  and refocuses the active Conversation. Selecting the same Room from the compact list still
  opens its Conversation because that changes the pane.

- **Signing in always leaves Rooms on its Account-qualified address.** The Workspace still avoids
  duplicate navigation when its state and URL are already exact, but now repairs a bare `/rooms`
  address even when the active Account already matches the in-memory destination.

- **The installed Android Settings journey no longer races its responsive redirect.** It now
  accepts the Settings index used on narrow layouts and the canonical first section selected on
  wide layouts, while still requiring the real Settings surface after the native touch.

- **The installed Android composer journey no longer depends on emulator autocorrect.** Its native
  keyboard proof now enters one deterministic token, keeping the real IME and viewport checks while
  avoiding dictionary-specific rewrites when an English word is committed with Space.

- **Runtime warnings no longer push the message composer below small phone screens.** The
  Application Runtime warning region stays visible and keyboard-scrollable while yielding the
  rest of the visual viewport to the routed surface, including with larger text and an encryption
  setup prompt present.

- **Signing in no longer freezes the authenticated app when browser notification permission is
  unavailable.** Notification listener reconciliation now reacts only to Account membership;
  a synchronous permission warning cannot become an accidental Angular signal dependency and
  retrigger itself until the renderer is saturated.

- **Restoring more than one account no longer races Rust crypto startup.** Each account still
  restores independently, while the SDK's process-wide crypto initialization step is serialized
  so one stored account cannot fail another account's migration state.

- **Browser Back and newly joined or created destinations now reach the requested Workspace
  reliably.** Canonical history destinations commit without redundant same-URL navigation, while
  directory joins, directory-created direct messages, and newly created spaces wait for the Matrix
  room to become observable before selecting it.

- **Optional browser capabilities no longer hold the startup screen open forever.** Storage
  persistence requests and service-worker update checks now settle with a non-blocking warning
  when a browser or test host leaves their permission or registration promise pending.

- **Unread dividers and compact message actions again match their visual contracts.** The unread
  marker now uses the design-system control emphasis weight, while four precise-pointer message
  actions fit their bounded continuation row and still retain the 24px target floor.

- **Sign-in stays inside small phone screens when larger text is enabled.** The edge-to-edge
  authentication card now scrolls its contents within the available app surface instead of
  extending below the viewport when startup warnings reduce its height.

- **Room mutes now stay in sync with other Matrix clients.** A mute set from FluffyChat or
  another device—including the modern empty-action Matrix rule—updates Trinity's room list
  live and shows a crossed-out bell without a
  reload. The menu distinguishes **Mute except mentions & keywords** from **Mute everything**,
  exposes disagreements across merged accounts, and applies rapid choices in order across the
  shared rules cache. A failed multi-step push-rule update restores the exact previous homeserver
  rules and their priority across every account represented by a merged room row instead of
  leaving the UI and server disagreeing, while preserving any newer same-rule edit made by
  another device during compensation.

- **Room actions now explain when your role cannot use them.** Inviting people, curating a
  space, editing room or space settings, managing aliases, changing roles, removing or
  banning members, and unbanning now follow the room's live Matrix power levels instead of
  a permission snapshot. Unavailable actions stay visible and focusable with a short
  explanation, including after a tap on mobile; they update when another client changes the
  room's permissions without hiding readable alias lists or discarding typed drafts, and
  are checked again immediately before Trinity writes to the homeserver.

- **Copy user ID now works in the Electron app.** Trinity's desktop permission policy allows
  sanitized clipboard writes only from the trusted main app frame while continuing to deny
  clipboard reads and remote frames. If the platform still rejects a copy, the complete Matrix
  user ID is focused and selected for keyboard-accessible manual copying.

- **Network failures no longer leave actions spinning forever.** Matrix requests now stop
  waiting after a bounded deadline, request controls release on completion or cancellation,
  and failed room invitations, room joins, and directory requests explain whether to
  reconnect, wait, sign in, or retry. A directory failure no longer also claims that no rooms
  were found. Raw SDK wrapper text stays out of both the UI and logs; diagnostics retain only
  the operation and a bounded, allowlisted error category.

- **Kicked and banned members disappear from the member list immediately.** The profile
  panel now returns to an already-updated roster after the homeserver accepts the action,
  instead of briefly showing the removed member until the next sync. Unrelated member
  updates cannot bring the stale row back while that membership update is still arriving.

- **Settings no longer shows two scrollbars side by side.** On a short window the list of
  sections scrolled independently of the section you were reading, so both drew a scrollbar
  next to each other — most visible under Notifications and Appearance, whose content is long
  enough to scroll too. The list still scrolls; it just no longer draws a bar of its own. The
  same fix also settles a dormant one: the dropdown panels have carried the instruction to
  hide theirs since they were added, and it had never taken effect.

- **The message menu no longer lingers after you leave the room.** On a phone, opening a
  message's action sheet and then navigating away — to Settings, or by following a link, or
  by signing out — left the sheet on screen over whatever came next, and picking anything
  from it did nothing at all.

- **Tabs, separators and toggles show their state too.** The same defect as the switches
  below, found by sweeping the rest of the design kit: the open tab in Room and Space
  settings drew no underline and no brighter label, so all three tabs looked alike; and every
  divider rule — including the ones separating the composer's formatting buttons into groups
  — rendered with no width at all, which is to say invisibly. Dropdown menus also animate
  open again.

- **Switches and checkboxes show which way they are set.** Every toggle in Settings —
  read receipts, link previews, notification rules, the experimental flag — rendered
  identically whether it was on or off: the track never took its colour, and the thumb never
  moved. Checkboxes had it too, staying unfilled when ticked. The
  controls were reporting their state correctly to screen readers and to the app the whole
  time; only the part you look at was missing, so a setting you had just changed looked
  untouched.

- **The side panels have their heading back.** Threads, a thread, pinned messages, search and
  member info all drew their top bar with the title jammed against the left edge and the bar
  itself 11px shorter than the room header beside it (45px against 56), so the two never
  lined up. The padding was being silently dropped rather than applied; all five now match the
  room header exactly, and still grow to clear the notch on a phone.

- **A room that has been upgraded no longer squashes the conversation.** In a room with a "this
  room has been replaced" notice, the notice was sharing a row with the message list instead of
  sitting above it, so the messages were squeezed into a narrow strip down the side and the
  composer had nowhere to put your text. The notice now spans the width above the conversation,
  which is where it was always meant to be.

- **Images and videos hold their place while they load.** The timeline used to jump as each
  one arrived — a message would be one line tall, then several hundred pixels tall a moment
  later, shoving everything you were reading down the screen. Every attachment now reserves
  its shape up front, including videos and the ones whose sender did not say how big they
  were. Tall images are no longer cropped to fit, either, and the placeholder shown while one
  loads is finally a different colour from the box around it, so you can see it at all.

- **Message actions no longer permanently cover neighboring messages.** The hover toolbar used
  to be forced open on every phone row. Phones and tablets now use a bottom sheet on long press;
  desktop and web show one compact, raised floating bar only for the active row, leaving
  the message body its full available width.

- **Starting the app no longer shows a blank screen.** Trinity has to open its local
  database, load the encryption engine and reconnect before it can show you anything, and
  until now it showed nothing at all while it did — on a cold start, or a slow phone, that
  was several seconds of blank white or black that looked like a crash. There is a startup
  screen now, from the first frame the browser paints through to the moment your rooms
  appear.

- **"Reduce motion" now reaches the timeline.** If your device is set to minimise animation,
  jumping to a reply, a search result, a pinned message or the first unread one used to
  animate the whole screen anyway — the setting was honoured everywhere except the place that
  moves the most. Those jumps are instant now.

- **Muted text and links are readable everywhere now.** Timestamps, member names, dialog
  captions and other secondary text failed the accessibility contrast floor the moment you
  hovered or selected the row they sat on — the exact moment you were most likely to be reading
  them. Links were worse: on the dark theme they sat at 2.18:1 against 4.5:1 required, which is
  closer to decoration than to text. Both are repaired across every theme in both light and
  dark, down to the "Get a free API key" link on Settings → GIFs, which was the last one still
  too faint to read against a dark background. A test now measures the theme's text colours
  against every background they can land on, so they cannot drift back.

- **The account switcher has its corners back.** On phones the dialog referred to a rounded
  corner that was never defined, so the browser dropped the rule and it rendered as a square.

- **Trinity no longer opens to a blank screen on some systems.** If your computer's language
  was set in an older style — common on Linux, and on anything configured with `LANG=en_US`
  or a `POSIX` locale — the app could not read your date and time preferences, and rather
  than falling back it stopped drawing the room entirely: no messages, no timestamps,
  nothing. Unusable, with nothing on screen to explain why. Trinity now ignores a language
  setting it cannot understand and carries on with the rest, or with your system default.

- **The emoji picker says what it is.** Opening the full picker to react to a message
  announced it to a screen reader as nothing but "dialog", with no indication of what it was
  for — on the most-used picker in the app. It now announces "Pick a reaction".

- **Settings dropdowns show the choice you made, not its internal name.** Once you had picked
  a palette, a time format or a date format, the closed dropdown went back to displaying the
  raw stored value — `amethyst`, `h24`, `iso` — instead of the wording you chose it by. All
  of them now read the same way open or closed, and the time and date dropdowns keep their
  worked example in view.

### Added

- **Attach several images at once.** Pick more than one in the file dialog, paste a batch of
  screenshots, select several photos in the phone gallery, or **drag them straight onto the
  conversation** — the room is the drop target, and it says so while you are dragging.
  Everything you have staged is listed above the message box, each with its own × so you can
  drop one without starting over, and picking again adds to the list rather than replacing it.
  You can keep adding while an earlier batch is still uploading; the new ones simply wait for
  the next send.

  One press sends the lot, in the order you staged them. They go out one at a time — the bar
  above the message box says which file of how many is uploading — so a big photo can't
  overtake a small one and land out of order. A caption written alongside a single image
  stays attached to it; write one for a batch and it is posted as its own message once the
  files are in.

  If one file fails, the others still go. The one that didn't is kept in the list, marked
  **Not sent**, with a retry button of its own — so a single bad file costs you that file
  rather than the whole batch. Leaving the room mid-send stops the rest rather than
  delivering them to wherever you went, and says so.

- **See what your homeserver is running.** Settings gains a **Server** section listing every
  account you are signed in to, and for each one: the server software and version — `Synapse
1.158.0` — the address it is reached at, the spec versions it supports, and, where the
  server says so, the room version it creates rooms at and whether passwords can be changed
  there. The version also appears under each account in the account switcher, so it can be read
  without opening Settings at all.

  The point is being able to check _now_, so there is a **Check again** button: each server is
  asked once and the answer kept for the rest of the session, and that button asks again rather
  than re-showing what it already had. Useful the morning after a server upgrade, when the deploy finished but
  nothing told you.

  Not every homeserver publishes its software version — it comes from an endpoint intended
  for other servers, which some deployments do not expose to browsers — so that row reads
  “Unknown” where it cannot be found. Nothing else on the page depends on it, and nothing
  fails or interrupts you when it is missing.

- **Your settings, readable and editable in one place.** Settings → **Advanced** shows
  everything Trinity keeps on this device as one formatted JSON document — appearance,
  privacy, timeline, date and time formats, keyboard shortcuts, GIFs and the push gateway —
  with **Copy** and, on the web and desktop apps, **Export to file**. Useful for setting a
  second device up, keeping a copy before experimenting, or answering "what's your config?"
  without a screenshot tour.

  On the web and desktop apps you can also edit the document in place, in a real editor: it
  suggests the settings a group holds as you type a name, offers exactly the values a setting
  accepts — so `amethyst` is picked from a list rather than guessed at as `mauve` — describes
  any setting you point at, and underlines a value it would refuse while you are still typing
  it, with the same wording Apply would give you. In the mobile app the document stays
  read-only, with Copy and Reset: settings there are changed on their own screens.

  You can also bring a document in with **Import from file** or
  **Paste from clipboard**, and apply it. Applying always checks the whole document first and
  then shows exactly which settings would change and to what, so nothing is written until you
  confirm it; if any value is wrong, Trinity names the setting that refused it and writes
  nothing at all rather than leaving half of it applied. What does go in takes effect
  immediately — there is no restart. A document written on another platform may name settings
  this one has no use for, such as a desktop keyboard shortcut on a phone; Trinity says which
  ones those are and applies the rest instead of quietly dropping them from your file.

  It is a preferences transfer, not a sign-in transfer: your accounts, access tokens,
  encryption keys, unsent drafts and anything your homeserver already carries for you are not
  in it, and the section says so and why. **Reset to defaults** puts every setting in that
  document back where it started — behind a type-the-word confirmation, and leaving your
  accounts and drafts untouched.

- **Code in messages has its own size, and long blocks can be numbered.** Until now the only
  way to shrink a pasted listing was to shrink the whole app with it, because Text size moves
  everything together. Settings → Appearance gains **Code size** — Smaller, Default, Larger —
  covering both code written inside a sentence and whole blocks, so a message never shows two
  sizes of code. It is relative to Text size rather than a fixed size, so the two work
  together: raising Text size still enlarges code, and this shifts code up or down within
  that. Code elsewhere in the app, such as your recovery key, is deliberately left alone.

  Alongside it, **Line numbers**: off, on for blocks over five lines (the default), or always.
  Numbering every snippet would put a gutter beside two-line pastes, so by default they appear
  only once a block is long enough to be worth pointing at by line. The gutter is one fixed
  width, so the code stays in a straight line down the block instead of shifting across as the
  numbers reach two and three digits. They stay put when you scroll a long line sideways, and
  they are never part of the message — selecting or copying a block gives you the code alone,
  and nothing extra is sent.

- **Code blocks are coloured for eighteen more languages.** Pasting C, C#, Dart, a
  Dockerfile, HTML, an INI or TOML config, Kotlin, Lua, a Makefile, Markdown, Perl, PHP,
  PowerShell, Ruby, Scala, a shell session or Swift now highlights the same way Python or
  Rust already did — thirty-one in total. Common short tags work too, so ` ```rb `,
  ` ```md ` and ` ```ps1 ` are understood. A block tagged with something still
  not on the list renders exactly as you wrote it, uncoloured, with the tag shown in the
  corner as before.

- **A way out when Trinity gets stuck.** If the app would not start, would not sign in, or
  rendered wrongly, there was nothing you could do about it from inside — signing out does
  not clear what was broken, and the one place with a fix, Settings, is behind the sign-in
  you cannot get past. On a phone or the desktop app there was no equivalent of a browser's
  "clear site data" either, so the honest answer was "reinstall". **Erase all data on this
  device** now sits at the bottom of the sign-in screen and erases everything Trinity keeps
  here — accounts, encryption keys, settings, drafts and cached messages — then restarts
  into a fresh app. It asks you to type `ERASE` first, because it cannot be undone: any
  message that only this device could decrypt becomes permanently unreadable. Nothing on the
  server is touched — your account, messages and rooms are all still there, and you can sign
  straight back in. Two details worth knowing: it works when your homeserver is unreachable,
  which is one of the reasons you might need it, and because of that your devices may still
  be listed on the server afterwards — remove them from another device or your account
  settings. And it reloads the app when it finishes, so you need to be online to use Trinity
  again afterwards.

- **Mentions look like mentions.** Someone's name in a message rendered as an ordinary
  link, indistinguishable from a URL, so a message addressed to you read no differently
  from any other. Mentions are now pills, and a mention of **you** is filled in the accent
  colour so you can spot it while scrolling past. It works on mentions written in Element
  and other Matrix clients too, not just ones written here.

- **Make the text bigger.** Trinity had no type-size setting at all, which is an
  accessibility gap rather than a preference — if the default was too small for you, there
  was nothing to do about it. Settings → Appearance gains **Text size** with four steps. It
  scales message text and everything written in it, all rendered markdown, and the settings
  area itself. Parts of the app's chrome still keep a fixed size for now, so they stay
  readable and consistent at their own size while the rest grows; those surfaces are being
  converted one at a time. The size is a proportion of whatever your browser is already set
  to, so if you have already made text larger there, this adds to it rather than overriding
  it.

- **Turn notification sounds off.** There was no way to stop Trinity's notifications making
  a sound short of silencing the whole app in your operating system. Settings →
  Notifications gains **Play a sound**, which covers every notification Trinity shows you on
  this computer. It is stored with your account rather than on this device, so it follows you
  to Trinity elsewhere, and each account you are signed in to keeps its own setting. Two
  limits worth knowing: it does not change the sound your **phone** makes for a pushed
  notification — that is chosen by the phone, not by Trinity — and it is Trinity's own
  setting, so other Matrix apps such as Element are unaffected and keep whatever they were
  set to.

- **Jump to a date in a conversation.** Finding what someone said last Tuesday meant
  scrolling and waiting, over and over. **Jump to date** in a room's ⋯ menu asks for a day
  and takes you to the first message on it, loading the history in between for you. It
  reaches a few hundred messages back — the range you would otherwise have scrolled by hand
  — and says so plainly when a date is further back than that, rather than appearing to work
  and leaving you where you were. It also tells you when a day simply has no messages, and
  when your homeserver is too old to support this at all, because those are three different
  problems and only one of them is worth you retrying.

- **Quote a message.** Replying points at a message; it does not bring its words with it, so
  answering one line of a long message meant retyping it. **Quote** in a message's ⋯ menu
  pulls the text into the composer as a `>` block with the cursor below it, ready to write
  around. It goes above anything you had already typed rather than replacing it, and quoting
  a second message stacks rather than swaps. Multi-paragraph messages stay whole inside the
  quote. Offered wherever there is text worth bringing — in threads as well as the room —
  and not on a photo or a poll, where the "text" is a filename or a question.

- **Filter the room list without losing it.** Ctrl/Cmd+K jumps you to a room and closes,
  which is the wrong shape for "show me my three design rooms and let me work through
  them". A filter box now sits at the top of the sidebar: type, and the list narrows in
  place and stays narrowed — rooms, invites and a space's other channels alike. Matching
  ignores case and accents, so `cafe` finds `Café`, and it matches anywhere in the name, so
  `dev` finds `core-dev`. Escape or the ✕ clears it, and it clears itself when you switch
  space. Alt+↑/↓ walks the filtered list too, so the keyboard cannot land you on a room you
  can't see, and **Mark all as read** still means all of them.

- **Push a room out of the way without leaving it.** The rooms you are in but rarely read —
  an archived project, a noisy announcements channel — sat in the middle of the list
  competing with the ones you actually use. **Low priority** in a room's ⋮ menu sinks it to
  its own section at the bottom of the sidebar, and **Restore to list** puts it back. It is
  the standard Matrix marker, so a room you demote here is demoted in Element too. A room
  you have also favourited stays in Favourites — the star wins. If the room is one you are
  in from more than one account, demoting it once demotes it everywhere it appears, so it
  cannot come back depending on which account you are looking at.

- **A way back in when you have lost your recovery key.** If you lost your recovery key and
  had no other signed-in device to verify from, Trinity had no way forward — the unlock
  screen offered your key or nothing. Settings → Security, and the unlock screen itself, now
  offer **I've lost my recovery key**, which builds your account a new encryption identity
  and gives you a new key to save. It is a last resort and it is spelled out before you
  confirm: your message backup on the server is deleted, so anything your devices cannot
  already read stays unreadable, and your other devices have to be verified again — they are
  not signed out. You have to type the word RESET to go ahead, and nothing is touched until
  your homeserver has accepted your password — so cancelling the prompt, mistyping it, or an
  account whose provider has to authorise the reset all leave you exactly where you started.
  If your account signs in through an identity provider, Trinity sends you there, since only
  the provider can authorise it.

- **Be notified when someone says a word you care about.** Settings → Notifications gains a
  **Keywords** list: add a word — your team's name, a project, an on-call term, a nickname
  you're known by — and any message using it notifies you and marks the room, in every room
  you're in. Matching is by whole word, so “call” will not fire on “oncall”. Each keyword can notify with or without a sound. Keywords are stored on
  your account, so they follow you to every device and to other Matrix apps: they use the
  same format Element does, so a list built in one shows up in the other. One deliberate
  limit, because people expect the opposite: a muted room stays muted, keywords included.

- **Mark a room as unread.** Glancing at a message on your phone and deciding it needs a
  proper reply later used to lose it: opening a room marks it read whether or not you dealt
  with it, and the room goes quiet in the list. **Mark as unread** in a room's ⋮ menu flags
  it to come back to, and the room stays flagged until you open it again. The flag lives on
  your account rather than the device, so it follows you everywhere you are signed in — and
  it interoperates with Element, which reads and writes the same marker.

- **The member list shows who owns the room.** Everyone at the top power level shared one
  **Admin** heading, so the person who created the room looked identical to everyone they
  had since promoted — in a room with four admins there was no way to tell whose room it
  was. The creator now gets their own **Owner** section above the admins, in rooms and in
  spaces. Being the creator is a fact about the room, so it is never something you assign —
  it does not appear among the roles you can give someone. A creator who is demoted below
  admin is listed by the power they now hold, so the section always reflects who actually
  runs the room. Direct messages have no owner: both people there are equals.

- **Spaces can hold spaces.** **Create a space inside** in the space menu nests a new space
  under the current one, and an existing space can be moved in from **Add existing rooms** —
  so a large space can be broken into sections instead of one flat list of rooms.

- **A space's members are visible, and can be moderated.** **Members** in the space menu lists
  everyone in the space with their role, and picking someone opens the same panel you get from
  a room — so kicking, banning and changing someone's power level work in a space too.

- **Rooms you are already in can be added to a space.** Until now a room could only join a
  space by being _created_ in it, so an existing conversation could never be organised into
  one — you had to make a new room and start over. **Add existing rooms** in the space menu
  lists everything you are in, filters as you type, and adds as many as you tick at once.
  Spaces appear in the same list, so an existing space can be nested inside another.

- **A space's rooms can be arranged for everyone.** Ordering a space's rooms only ever
  changed _your own_ view. **Organise rooms** in the space menu sets the arrangement the
  whole space sees, and marks rooms as **suggested** so new members know where to start.

- **A space's members can be let into a room.** Room settings gains **Space members can join**
  beside "Invite only" and "Anyone can join", so a room inside a space no longer has to be
  either invite-by-invite or open to the whole internet. Picking it lists the room's spaces
  with a tickbox each, so you can see exactly who is let in and change it — and a space you
  are not a member of stays allowed rather than being quietly dropped. The option appears only
  for rooms that sit in a space and are new enough to enforce the rule; anywhere else it would
  be a promise the server would not keep.

- **Spaces can be configured after they are created.** A space was set up once, at creation, and
  never again — its name, topic and who could join it were fixed from then on, and it could
  never be given a photo at all. **Space settings** in the space **⋮** menu now edits all four,
  alongside the space's published addresses and its banned members. Fields you lack the power
  level to change are shown but disabled, and each one saves independently, so a rejected topic
  no longer discards a rename that the server accepted.

- **Trinity installs from the browser.** The icons for it had been shipping for a while, but the
  one small file a browser looks for to offer **Install app** was missing, so the option never
  appeared and the docs quietly admitted it. It is there now: installing gives Trinity its own
  window without browser chrome, its own icon on the home screen or dock, and a maskable icon so
  Android can shape it to match everything else.

- **A newly deployed version now offers to load itself.** The web app is pinned to whichever
  version your tab started with, so a tab left open — which, for a chat client, can mean weeks —
  would go on running an old build indefinitely. Trinity now notices a new version and offers a
  Reload, and checks again whenever you come back to the tab. Nothing reloads under you: it
  waits for you to say so.

### Changed

- **The room you have open is now in the address bar, and the panels share the window.**
  Opening a room puts it in the URL, so you can bookmark a conversation, send someone a link
  straight to it, and reload without landing back on the room list. Your browser's Back
  button — and Back on Android — now closes the open room instead of leaving Trinity
  altogether.

  Threads, the thread you are reading, pinned messages, search results and member info now
  take turns in one panel beside the conversation rather than stacking up, so opening one
  puts the previous one away.

  That panel and the room list can both be **dragged wider or narrower**, and Trinity
  remembers the widths for next time. Drag the divider between them, or focus it and use the
  arrow keys — Home and End jump to the narrowest and widest, so a layout dragged somewhere
  unhelpful is one keystroke from being usable again.

  On a phone that panel is a drawer, and it now **swipes**: in from the right edge to bring up
  the member list, away again to put it back. Android's Back button closes it too, instead of
  walking straight past it and out of the room. On iPhone the swipe-from-the-left-edge that
  goes back in every other app finally works in Trinity as well.

- **Nothing sits under the notch or the home indicator any more.** On a phone with a rounded
  screen the thread composer and a member's action buttons ran underneath the bar at the
  bottom, because the panels only cleared the top edge. They clear both ends now.

- **The emoji picker follows your theme.** It came from a third-party library that only knew
  "light or dark", so it showed its own purple accent and its own greys whichever Trinity
  theme and palette you had chosen. It now uses the same colours as the rest of the app, in
  all four combinations of light/dark and palette.

- **Mentions now have to be meant.** Quoting a message put the quoted words into the
  message you sent, so quoting "Bob, can you look at this?" notified Bob a second time for
  a message that addressed nobody — and quoting anything containing `@room` pinged the
  whole room again. Trinity now marks every message with who it actually addresses, which
  is what tells your homeserver to stop matching on the text. The effect is that mentioning
  someone is deliberate: pick them from the autocomplete and they are notified, as before,
  but merely writing a name in passing — or carrying it along inside a quote — no longer
  is. `@room` still notifies everyone when you type it yourself and still needs the
  permission it always did; it just no longer fires from words you were quoting.

- **Library imports now mirror the directory layout.** The data-access, feature and util
  libraries each repeated their layer in their own directory name — `libs/data-access-rooms`,
  `libs/feature-shell`, `libs/util-matrix`. They now nest under a parent directory instead, and
  the import path says the same thing: `@trinity/data-access/rooms`, `@trinity/feature/shell`,
  `@trinity/util/matrix`. Nx project names are unchanged, so every `nx test data-access-rooms`
  command and every CI job name still works. Developer-facing only — nothing in the app behaves
  differently, though a branch opened before this will need its imports rewritten.

- **The documentation has been rewritten from the code up.** `docs/` was 15 flat files that had
  drifted apart from the thing they described — one roadmap listed thirteen already-shipped
  features as still outstanding, four pages linked to a source file that no longer exists, and
  the version table had to be corrected by hand after every dependency wave. It is replaced by
  27 pages in five sections, each rediscovered from the source rather than edited forward:
  **Using Trinity** (installing, signing in, encryption and recovery, messaging, notifications,
  settings — the first user-facing documentation the project has had), **Contributing**,
  **Architecture**, **Platforms**, and a **Reference** section whose troubleshooting page
  collects the traps that were previously scattered through prose or known only to whoever hit
  them. Every page states what is genuinely not supported rather than staying quiet about it.
  The ten roadmap and review documents are gone; git history keeps them, and the issue tracker
  is where prioritisation actually happens. Developer-facing only — nothing in the app behaves
  differently.

- **Trinity now needs Node 24.15 or newer.** Both Angular 22 and the test environment
  declare 24.15 as their floor, and both exclude the 25.x line entirely — so the project
  requirement now says exactly that (`^24.15.0 || >=26.0.0`) instead of the looser `>=24`
  it had drifted to. `.nvmrc` is pinned to match, because the engines field is only
  advisory: pnpm warns and carries on, so `nvm use` is what actually keeps you on a
  supported runtime.

- **A tap no longer leaves a tooltip stuck open.** On a touch screen, tapping something with a
  tooltip — the icon buttons in the composer and room header, the encryption shield on a
  message — used to open the tooltip and then leave you with no way to dismiss it, because the
  browser reports the start of a tap but never the end of a hover that never happened.
  Tooltips now open for a mouse or pen, and for keyboard focus. Where a tap moves focus to the
  thing you tapped, the tooltip still appears. Every one of these also carries its text as an
  accessible label, so nothing a screen reader announces has changed — with one detail worth
  naming: the encryption shield labels the finding itself ("Sent from a device its owner hasn't
  verified") but keeps the longer sentence explaining what to do about it in the tooltip alone.

- **The "your provider has to reset this" path is now tested against a real server.** When an
  account signs in through an identity provider, Trinity cannot authorise an encryption reset
  itself and says so — a claim that until now rested on a mocked homeserver reply. The
  disposable test stack grew a throwaway identity provider, so the suite holds an account with
  no password and drives that refusal end to end: a real sign-in, a real rejection, and a check
  that the account's backup and encryption identity both survive it untouched. That last check
  is what caught the reset destroying the backup before it gave up.

- **Where a sign-in in progress is kept has changed on the web.** Signing in through a
  provider needs Trinity to remember one short-lived secret while you are away at the
  provider's page. The Matrix library used to hold that itself, in storage the browser
  discards when the tab closes; the version Trinity now uses keeps nothing at all, so
  Trinity keeps it — in the same storage it already uses on phones and on the desktop app,
  which on the web survives a closed tab. It is used once and thrown away, expires after ten
  minutes either way, and is now cleared when you return to the sign-in screen. Nothing
  about how you sign in changes.

- **The space header makes room for the space's name.** A space's sidebar header carried up to
  six icon buttons on one row, which left the name itself about six characters before it was
  cut off — and on a touchscreen, where the buttons grow to a thumb-sized minimum, they needed
  more width than the sidebar has. Search and **+** stay where they were; ordering, inviting,
  marking everything read and leaving now sit behind a **⋮** menu, where they get readable
  labels instead of unlabelled glyphs and **Leave space** is no longer one mis-tap from
  **Invite people**. Home is unchanged — it has room.

### Fixed

- **On Android, back no longer closes a dialog that asked to stay open.** Setting up or
  unlocking encryption, and verifying a device, are steps that must not be dismissed
  half-finished — but the hardware back button closed them anyway, leaving the flow in an
  in-between state. Back now leaves those dialogs alone, and while any dialog is open it
  dismisses that rather than navigating the page behind it.

- **Hints under text boxes are read out again.** Where a field had explanatory text beneath it —
  the push gateway URL, its app id, and the manual location entry — screen readers never announced
  it. The text was in the page and visually correct, so the gap was invisible unless you used one:
  the description was being removed from the field before it reached the accessibility tree. It is
  now attached properly, and a test covers each of those fields so it cannot go quiet again.

- **GIF search works again: Tenor is replaced by KLIPY.** Google shut the Tenor API down on
  30 June 2026, and Tenor was the provider Trinity offered first — so the default path led to
  a sign-up page that had been closed since January and an API that no longer answers. GIF
  search now uses KLIPY, with GIPHY still there as the second option, and Trinity still ships
  no key of its own: you bring your own, so a GIF search only ever leaves your device once you
  have chosen to enable it.

  If you had configured Tenor, this device moves itself to KLIPY on the next start and clears
  the old key, because a Tenor key cannot work against another service — keeping it would have
  looked like a working setup that failed every search instead. Settings → GIFs says so, and
  points you at where to get a KLIPY key. A configuration file exported before this change
  still imports: it is read as KLIPY and tells you the same thing, rather than being rejected
  for naming a provider that no longer exists.

- **Tapping a notification opens the room it came from.** It focused the window and switched to
  the right account, then left you wherever you already were — the one thing a notification is
  for was the one thing it did not do. Every platform was affected. The room now opens, and the
  link is cleaned up behind it so Back does not walk you into it again.

- **Recording a voice message no longer closes the app on iPhone and iPad.** iOS requires an app
  to say why it wants the microphone before it takes it, and shuts the app down on the spot if it
  has not. Trinity said why it wanted the camera and your photos but never the microphone, so the
  mic button was offered and tapping it ended the app. The same was true of sharing your location.

- **A voice recording that gets interrupted no longer disables voice messages until you restart.**
  If the recorder stopped on its own — the microphone taken by another app, permission withdrawn
  mid-recording — stopping it failed in a way that left the microphone held and the app convinced
  a recording was still under way. Every later attempt then silently did nothing while the timer
  counted up. Recording now ends cleanly however it was interrupted, and the next one works.

- **Push notifications say when they could not be set up.** If the phone's push service refused
  to issue a token, Trinity treated it as done: nothing arrived, the setting showed neither
  success nor failure, and nothing would retry for as long as the app stayed open. The failure is
  now shown, and reopening the notification settings tries again.

- **Signing back in to an account keeps its badge and its notifications working.** After
  re-authenticating — a session that expired, a re-added account — that account could stop
  updating its unread badge and stop raising notifications entirely, silently, until the app was
  restarted. It stays connected now.

- **Changing your push gateway no longer leaves the old one receiving.** Moving from the built-in
  gateway to your own left the original registration in place on your homeserver, so the previous
  operator carried on being told which room each message arrived in, indefinitely. The old
  registration is now removed as part of the switch.

- **A stale or mistyped link no longer leaves a blank page.** Any address the app did not
  recognise loaded the shell and then showed nothing at all, with no way back except editing the
  URL. Unknown addresses now land you back in your rooms.

- **Signing out clears your unsent drafts.** Half-written messages are kept so they survive a
  reload, but they were left behind on sign-out — including drafts for encrypted conversations,
  in the clear, on a device that might be shared. They are now cleared with everything else.

- **Signing out no longer leaves the previous account loaded.** Rooms, members and presence for
  the account you signed out of stayed in memory until someone signed in again, and an account
  that had already been signed out remotely could leave its encryption store behind on disk with
  nothing left pointing at it. Both are cleaned up at the point of sign-out now.

- **Interrupting Trinity while it restores your session no longer risks your encryption store.**
  If a link or notification redirected the app while it was still starting your account up, the
  half-started session was abandoned rather than stopped, and the next attempt could open a
  second copy of the same encryption store. Starting an account is now safe to interrupt, and a
  second attempt joins the first instead of duplicating it.

- **Setting up encryption is no longer disturbed by switching accounts.** On a device with more
  than one account signed in, switching while the setup was mid-flight made it ask your
  homeserver to confirm the wrong account, which failed after the encryption work had already
  begun. Setup now stays with the account it started on, as resetting and recovering already did.

- **Errors that used to disappear are visible again.** Moving off Zone.js quietly disconnected
  the app's error handler from failed background work, so the noise it was written to filter came
  back and genuine failures reached nothing at all — which is why the voice-recording fault above
  was silent. It is reconnected.

- **A momentary failure to reach secure storage no longer locks you out for the session.** The
  first failed attempt was remembered permanently, so every later read and write of your tokens
  failed with it and the app looked signed out until it was restarted. It now retries.

- **Desktop: the first requests after launch no longer fail against some homeservers.** The
  shell was told which homeserver to expect only after the client had already started talking to
  it, so on servers that need that help the opening requests were blocked — costing threads for
  that session and delaying the first sync. It is declared before the client starts.

- **A "Suggested" tick that the server rejects no longer sticks.** In Organise, marking a room
  as suggested left the box ticked even when the change was refused — a toast said it had
  failed while the row said it had worked, and it stayed that way until you closed and
  reopened the dialog. The tick now goes back where it was, so what you see is what the space
  actually has.

- **Destructive buttons and menu items keep their contrast wherever they appear.** The red
  tint behind "Leave room", "Ban from room" and similar was translucent, so how readable the
  label was depended on what happened to be behind it — comfortably legible in a dialog or a
  menu, but close to the accessibility limit on the darker panels, and below it if one had
  ever been placed on the room-list background. The tint is now a fixed colour, so every one
  of these reads the same wherever it is used. Nothing looks different in the places they are
  used today.

- **Code blocks no longer tower over the conversation.** A pasted snippet rendered
  noticeably larger than the message text around it, and a pasted class of a few dozen lines
  dominated the timeline. Both were in fact the same size — the cause is that a monospace
  face simply reads bigger than the surrounding font at an equal size. Trinity already
  corrected for that on code written inside a sentence and then undid the correction inside
  a fenced block. Blocks now carry it too, so they sit at the same visual weight as the text
  around them. Nothing to turn on, and the code itself is untouched.

- **Signing back in to an account no longer creates a second device.** When a session was
  signed out by the server and you re-authenticated it, accounts that use the newer
  provider-based sign-in were given a brand-new device instead of picking their old one
  back up — so the account came back needing to be verified all over again, which is the
  one thing that flow exists to avoid. It now reuses the device it already had. Accounts
  signing in with a password or the older single-sign-on were never affected.

- **A sign-in you walked away from no longer leaves anything behind.** Starting a
  provider-based sign-in and then abandoning it — closing the tab, never coming back from
  the provider — left a short-lived secret from that attempt in local storage, because it
  was only ever cleaned up when a sign-in actually came back. It is now cleared the next
  time you open the sign-in screen, and a device whose clock is running ahead can no longer
  keep one alive indefinitely — for the older single-sign-on as well as the provider-based
  one. A clock that merely corrects itself by a few seconds while you are signing in still
  lets the sign-in through, so ordinary clock adjustments do not fail a genuine attempt.

- **Some providers no longer sign you out minutes after you signed in.** Trinity's session
  is kept alive by quietly renewing it in the background. A provider is allowed to answer
  that renewal with a fresh key and nothing else, and when one did, Trinity forgot the thing
  it needed to renew again — so the next renewal, typically only minutes later, failed and
  signed the account out, taking a perfectly good credential off the disk with it. Signing
  back in worked, and then it happened again. Providers that issue a fresh credential each
  time — the common case, including Matrix's own authentication service — were never
  affected. A provider that answers with a blank credential rather than none at all is now
  treated the same way, and can no longer overwrite the good one already saved.

- **A sign-in that fails at the last step no longer leaves a device behind.** If your
  homeserver became unreachable in the seconds between your provider approving the sign-in
  and Trinity asking who you are, the sign-in failed — but the session your provider had
  just created stayed alive, showing up as a device you could only remove from the
  provider's own account page, and every retry added another. Trinity now hands that session
  back, and tells you what went wrong straight away rather than waiting on the handover —
  which reaches your provider, not the server that just failed, and could take minutes.

- **Reconnecting an account can no longer sign you in as a different one.** When a session
  is signed out by the server, "sign in again to reconnect this account" sends your provider
  the identity of the account it belongs to. If you have two accounts on the same provider
  and it still had you signed in as the other one, it could approve without asking you
  anything — and Trinity would reconnect the wrong account, filing it under the first
  account's identity on this device. That could force the untouched account to be verified
  again. Trinity now checks who came back before saving anything, explains the mismatch, and
  hands the unwanted session back to the provider.

- **A sign-in that cannot be finished says so instead of spinning.** If the app could not
  read the sign-in it had saved — storage blocked or full, a phone failing to hand the link
  back — the screen sat on "Completing sign in…" with no message and no way out except
  force-quitting. It now tells you, and offers the way back.

- **A sign-in callback that arrives twice is only used once.** Some platforms can deliver
  the return-from-provider link more than once. The second one used to be processed as
  well, which could invalidate the session the first one had just established.

- **You can pinch to zoom again.** The app told mobile browsers and both native WebViews that
  it could not be zoomed, so pinch-zoom did nothing — on the two platforms where there is no
  text-size setting to fall back on, that left anyone who needs larger text with no way to get
  it. The lock is gone. Nothing else about the layout changes: the app still opens at the right
  size and still fills the notch area.

- **Leaving encryption setup half-way no longer costs you your recovery key.** Setting up
  encryption shows your recovery key exactly once. Pressing the browser's back button — or
  Android's — while that key was on screen closed the page without a word, and the key was
  gone. Doing it while setup was still running was worse: setup carried on in the background
  and finished, producing a recovery key nobody ever saw, after which Settings → Security
  cheerfully reported your messages were secured. Both now ask before they let you go. Backing
  out of a page that asks also no longer eats an entry from your history, so the next press of
  the back button goes where you expect instead of skipping one.

- **Direct messages show the other person's face.** A one-to-one conversation is never given
  a picture of its own, and Trinity only ever looked for one — so every DM in the sidebar, the
  quick switcher and the invite list showed a coloured letter, right next to the person's name,
  which had resolved perfectly well. DMs now fall back to the other person's avatar, and a DM
  invite to the inviter's. Group rooms with no picture still show their initial, which is
  correct.

- **A direct message's picture appears as soon as the other person's profile does.** It used
  to wait for whatever synced next, so a DM could sit on a coloured initial for a while after
  opening the app.

- **Thread "seen by" avatars follow the read markers.** In an open thread they stayed put
  when somebody read your reply, and only caught up when an unrelated event happened along.

- **A "seen by" avatar catches up when the reader's profile arrives.** The small avatars under
  a message showed a coloured initial for anyone who had read it but not written in it — a
  lurker, typically — and kept showing it even after their picture loaded, while the same
  person appeared correctly everywhere else. It only corrected itself once they read a newer
  message.

- **A brief network hiccup no longer costs you avatars for the rest of the session.** When a
  picture failed to load, Trinity was meant to wait a moment and try again — but the retry
  had never once re-sent the request it was added for, so the very first failure was final.
  Worse, any stumble at all made Trinity retry against the older, unauthenticated way of
  fetching media, which most homeservers now refuse outright; a server saying "busy, try
  again" was turned into "no such picture". A momentary drop in connectivity — walking out of
  wifi range, waking a laptop, a VPN reconnecting — could leave a scattering of people and
  rooms showing coloured initials until you reloaded the page. Trinity now genuinely retries,
  backs off between attempts, and only falls back to the old method when the homeserver
  really does not support the new one.

- **Accepting a room invite no longer hides the room you just joined.** Saying yes to an
  invite dropped you on the direct-message list — which, by definition, does not show rooms —
  so the room opened in the timeline but vanished from the sidebar until you clicked
  **Recent activity** or **Rooms**. Accepting a room now leaves you where you were, and
  accepting a DM still takes you to your direct messages.

- **Destructive menu rows are readable in dark mode again.** "Leave room" and "Remove from
  space" were drawn in a near-black maroon on the dark menu surface — a contrast of 1.38:1,
  which reads as an empty strip rather than as text. They now use the same red the rest of the
  app uses for alert text. Every destructive dropdown row is affected, including the new
  **Leave space**.

- **Line breaks no longer disappear when you format a message.** Writing a message across
  several lines worked — until you also made a word bold, at which point every line break in
  it silently collapsed and the message arrived as one run-on paragraph. Shift+Enter meant one
  thing in a plain message and another in a formatted one, with nothing to tell you which you
  were in. Line breaks are now kept either way.

- **Lists in messages have their bullets back.** Every bulleted and numbered list — in the
  timeline, in a message's edit history, and in the composer preview — rendered as indented
  lines with no bullet or number at all, because the CSS reset that clears list markers was
  never undone for message content. Nested lists step through the usual •, ◦, ▪ again, and
  numbered lists count.

- **Task lists survive being sent — and now arrive from other apps too.** Typing `- [x] done`
  produced a checkbox that was stripped out before the message ever left your device, so
  recipients saw a list with the done and not-done state simply missing. Task lists now arrive
  as ☑ and ☐, which every Matrix client and screen reader can show. A checklist sent to you
  _by_ another app used to lose its boxes the same way on arrival, and now shows the same
  ticks — and a task item no longer draws a bullet beside its box.

- **Binding a shortcut a browser keeps for itself now says so in more cases.** Settings →
  Keyboard shortcuts warns when the chord you pick only works in the desktop app, but the
  check ignored anything with Shift — so Ctrl+Shift+T, Ctrl+Shift+N and Ctrl+Shift+W were
  accepted with no warning and then silently did nothing on the web, where the browser
  reopens a tab or opens a window instead.

- **The test suite no longer fails at random.** `pnpm test` was being killed part-way through
  on roughly half of all runs — no failing test, just a dead process — because the Angular
  test plugin quietly ran every suite in a worker pool that never reclaims memory between
  files. Naming the pool explicitly drops peak memory from 4.3 GB to 0.9 GB. A second,
  hidden cause is fixed too: a debounced draft save could fire after the thing that asked
  for it had gone away, failing a run in which every test passed. Developer-facing only —
  nothing in the app behaves differently.

- **Submenus no longer cover the menu they came from.** Opening **Show accounts** from the
  account menu drew the account list on top of that menu, hiding it — and the per-room
  **Notifications** submenu had the same flaw, just less visibly. Both now open alongside
  their menu, so you can see where you came from. On a phone, where there is no room beside
  a menu for anything to open into, **Show accounts** now opens a dialog instead.

- **`pnpm electron:install` now actually installs Electron.** Electron stopped shipping a
  postinstall script in v42, so the command only installed the desktop shell's dependencies —
  the binary it is named for was never fetched, and `node_modules/electron/dist` stayed empty
  however many times you ran it. The shell shipped on 42.5.0, the first release without that
  postinstall, so the command has never once done what it is named for. The package downloads lazily instead, the first time
  something asks it for a path, which is too late on macOS: `electron:build` code-signs the
  app before anything asks, so a fresh clone's first `pnpm electron:start` died on a missing
  `Electron.app`. The command now fetches the binary itself, says so, skips the download when
  the matching version is already unpacked, and fails with an explanation rather than an empty
  directory. Developer-facing only — nothing in the app behaves differently.

- **Unit tests are now type-checked, and so is the end-to-end suite.** Test code sat outside every
  static-analysis path in the repo — excluded from each project's TypeScript config, ignored by the
  type-aware lint rules, and run through a transpiler that does not type-check — so mistakes in it
  were invisible to `test`, `lint` and `build` alike. Thirty-three real type errors had already
  accumulated, most of them stand-in Matrix clients that had drifted away from the interface they
  claim to implement, which is exactly the drift that lets a test go on passing after the code it
  covers has changed. Every project gains a `typecheck` target, CI runs them, and the existing
  errors are fixed. The Playwright suite gains the same treatment plus lint coverage, including
  the rule that catches a dropped `await` on an assertion — the way an end-to-end test silently
  stops testing anything. Developer-facing only.

- **Android and iOS dependencies are covered by dependency automation again.** Both native trees
  were excluded wholesale, which also put them beyond the reach of security advisories — including
  the WebView library that renders the whole app. The exclusion now covers only generated build
  output. Developer-facing only.

### Security

- **Android: your encryption keys are no longer swept into device backup.** The app was still
  using the platform default that copies its data directory to Google Drive, and that directory is
  where the encryption store lives — the device's identity and the keys to every message it has
  decrypted, unencrypted at rest. Your access token was already held in the Android keystore, but
  the keys that actually read your messages were not covered by it. They are now excluded from
  backup, as other Matrix clients do.

- **Desktop: packaged builds refuse to run app code from outside the bundle.** The build already
  disabled the switches that let someone turn Electron into a general-purpose Node runtime — the
  point being that the desktop process can reach your keychain. Two related protections were
  missing, so code placed beside the bundle on disk could be loaded in preference to the real
  thing, reaching the same keychain access the other switches were there to deny.

### Added

- **Formatting buttons, shortcuts and a preview in the composer.** Writing a formatted message
  meant typing markdown from memory and hoping. There is now a small toolbar above the message
  box — bold, italic, link and code, with strikethrough, code blocks, quotes, bulleted lists and
  task lists behind an overflow button. Each one wraps whatever you have selected, or drops you between the markers
  when you have selected nothing, and pressing it again takes the formatting back off.
  The same actions have keyboard shortcuts, and every one of them can be changed in
  Settings → Keyboard shortcuts — which now groups its list under headings instead of running
  everything together. Shift+Enter inside a list carries the bullet, number or task box onto
  the next line — a new task box always starts unticked — and a second one on an empty item
  ends the list. The eye button swaps the box for a
  preview of the message exactly as it will arrive, slash commands included, so a spoiler
  previews concealed the way the person reading it will first see it. Your draft survives all
  of it untouched.

- **Hide the formatting toolbar if you don't want it.** Settings → Appearance gains **Show
  the formatting toolbar**, which takes the row of bold/italic/link buttons off the top of
  every message box once you know the markdown by heart — useful on a phone, where it
  competes with the on-screen keyboard for space. Only the buttons go: Ctrl/Cmd+B and the
  rest of the shortcuts still work, and Shift+Enter still continues a list. Shown by
  default, and the setting is kept per device.

- **Code blocks are syntax-highlighted, and say what language they are.** A fenced block
  tagged with a language — ` ```ts `, ` ```py `, ` ```sh ` and ten others — is now coloured,
  in both light and dark and in whichever palette you use. Trinity was already sending and
  accepting the language tag; nothing had ever drawn it. Pointing at any tagged block also
  shows its language in the corner, so you can tell Rust from Go at a glance even where the
  colours look alike — and for a language Trinity cannot colour, the label is still there.
  Tables and collapsible `<details>` sections also pick up proper styling, having previously
  rendered unstyled.

- **Order a space's rooms the way you want.** Rooms inside a space were always listed in the
  order the space's admins arranged them — in practice alphabetically, since almost no space
  sets an order — while every other list in Trinity puts the most recent conversation at the
  top. Opening a space therefore buried whichever room was actually busy. Spaces now use
  **Recent activity** by default, and the new sort button in the space header offers **Space
  order** and **Alphabetical** as well, per space. Settings → Appearance sets the default for
  spaces you have not chosen individually; that default is kept per account on the device, so
  two accounts on one machine can differ. Lists re-order as messages arrive, without
  reopening the space. Favourites keep their own group at the top, as they do everywhere else.

- **Write dates and times your way.** Settings → Appearance gains **Time format** and **Date
  format** pickers: a 12- or 24-hour clock, and day-first, month-first or ISO dates — each
  option previewing exactly how it will look. Both default to **Match system**, which now
  genuinely means your device's language rather than US formatting, so most people get the
  right thing without touching anything. The choice applies everywhere at once and takes
  effect immediately: message timestamps, the hover time on a grouped message, day
  separators, pinned messages, threads, edit history and search results all move together.
  Previously every timestamp rendered as `7/24/26, 3:45 PM` for everyone on the planet, while
  search results and day separators followed your browser — so the same screen could show two
  or three different conventions at once. It is saved on the device.

- **See where the days begin.** The timeline now draws a labelled divider wherever the
  calendar day changes, reading **Today**, **Yesterday**, or the date further back — so
  scrolling through a room tells you _when_ something was said without reading the small
  timestamp on every message and working it out. Dates follow your browser's language, and
  a room left open overnight relabels itself at midnight rather than going on calling
  yesterday "Today".

- **Quieten the timeline.** Settings → Appearance gains three switches for the system lines
  that appear between messages: **joins and leaves** (including invites, knocks, kicks and
  bans), **display name and avatar changes**, and **room changes** (name, topic, avatar,
  address, access, encryption and room creation). In busy or bridged rooms that churn can drown out the conversation —
  turning a category off removes those lines completely, with no gap left behind, and
  messages that were separated by them group together again. Everything is shown by default,
  so nothing changes until you say so, and hiding lines never affects your unread counts.
- **Mix the accounts you choose into one view.** With more than one account signed in, the
  account menu gains a **Show accounts** picker: tick whichever accounts you want to see
  together and every view mixes just those — Recent activity, your direct messages, the Rooms
  list, and the left rail's spaces. So you can blend work and personal while leaving a third
  account out of it. Each item is marked with a small badge showing its account's own profile
  picture, so you can tell apart the same person reached through two of your accounts, and the
  user panel shows the mixed accounts' avatars stacked so you always know what you're looking
  at. Opening a conversation from another account switches to it automatically, so everything
  you do there (sending, receipts, reactions) happens as the right account — including the
  room menu's Leave, Favourite, Mute and Mark-as-read, which act on the account that owns the
  room rather than whichever one you happen to be using. The account you're acting as is
  always shown, your picks are remembered between launches (and survive an account being
  temporarily signed out), and with one account signed in nothing changes. A room both of your
  accounts have joined is listed once, not twice.
- **Customise your keyboard shortcuts.** Settings now has a **Keyboard shortcuts** section
  listing every shortcut and its keys — so you can finally see what's available — and you can
  rebind any of them: click one, press the new combination, done. If the combination is
  already used elsewhere it's taken over (the old shortcut is left unset, with a note), and a
  chord your browser reserves is flagged as desktop-app only. A **Reset all to defaults**
  button (and a per-shortcut reset) puts things back. Your choices are saved on the device.
- **Keyboard shortcuts to hop between rooms.** Press **Ctrl/Cmd+'** to jump to the room you
  were just in, and again to keep stepping further back through the rooms you've visited —
  alt-tab style; **Shift** with it steps forward again. **Alt+↑/↓** walks up and down the
  room list, and **Alt+Shift+↑/↓** jumps to the previous/next room with unread messages. In
  the desktop app you also get **Ctrl/Cmd+1–9** to jump straight to one of your recent rooms
  and **Ctrl+Tab** to hop; those particular keys are reserved by browsers, so they're
  desktop-only.
- **A Recent activity view that answers "what happened?" in one place.** A new first entry
  in the left rail, above Home and Rooms, shows every conversation — direct messages and
  rooms together, including rooms inside your spaces — in one list, favourites at the top
  and the most recently active first. It's where the app opens now, so the latest activity
  is in front of you on launch; Home (direct messages) and Rooms are still a click away and
  scoped exactly as before.
- **See who reacted, not just how many.** Pointing at a reaction says who is behind it —
  "👍 reacted by You, Alice and 4 others" — and the small people button at the end of the
  reactions opens the full list, with a tab per emoji and everyone who picked it. Tapping
  a reaction still adds or removes your own, as before.
- **See what a message used to say.** An edited message has always been marked "(edited)",
  but the earlier wording was out of reach. That marker is now a button: click it (or tab to
  it and press Enter) to see every version of the message, oldest first, with the time each
  was sent. It works for anyone's messages, not just your own — the versions are kept by the
  homeserver and any Matrix client can read them, so this shows what is already there rather
  than anything new. Each version highlights what that edit changed — added words marked,
  replaced words struck through beside them — so you can see the change at a glance
  instead of comparing two paragraphs by eye; **Highlight changes** turns that off if you
  came to read an old version rather than compare. Formatting is kept either way. A message
  you deleted offers no history: its edits do survive on the server, but Trinity won't put
  them back in front of you. You can also **remove** any version of your own message from
  the list — that really deletes it from the server, and the message falls back to the
  version before it.
- **Set your own mobile push gateway.** Settings → Notifications now has a **Push gateway**
  section where you can point mobile notifications at a gateway you run or trust, instead
  of relying on one built into the app. Paste its URL — a bare address is completed for you
  and an obviously wrong one is caught before saving — and Trinity explains, before you
  commit, exactly what the gateway's operator can and cannot see. The setting is specific
  to the device you set it on. After saving, the screen tells you whether your homeserver
  accepted the registration (it can't promise a notification will actually arrive — only
  your gateway and Apple/Google can). Advanced users can also set a custom app ID. This
  applies on iOS and Android; on desktop and web, Trinity notifies you over its live
  connection instead.
- **Sign in with next-generation Matrix auth (OIDC).** On homeservers that delegate
  authentication to an OpenID provider (MSC3861 / Matrix Authentication Service — as
  matrix.org now does), the login screen offers a **Continue** button that signs you in
  through your provider using OAuth 2.0 + PKCE, plus a **Create account** button where the
  provider supports it. Sessions refresh silently in the background, so the short-lived
  tokens these providers issue don't sign you out, and the flow works on web, iOS, Android,
  and desktop (the provider opens in your system browser and returns to the app, even after
  a cold start). For these accounts, password and session management live at the provider —
  the account settings page links out to it instead of showing an in-app password form —
  and signing out revokes the session there.
- **Jump back to the latest message.** When you scroll up through a conversation, a button
  now appears at the bottom to jump straight back to the newest message, instead of having
  to scroll all the way down by hand.
- **Show or hide what you type in password fields.** The sign-in password field and all
  three change-password fields now have an eye toggle to reveal the characters, so you can
  catch a typo before submitting.
- **Retry a failed GIF search.** When the GIF picker can't reach its provider, a **Try
  again** button now re-runs the search instead of leaving you stuck on the error.
- **Pinning a message now confirms.** Pinning or unpinning from a message's menu shows a
  brief confirmation — and tells you if it didn't go through (for example when you no longer
  have permission) instead of failing silently.
- **The room header adapts to small screens.** On a phone, the room's Invite, Room settings
  and Pinned actions collapse into a single **⋮** overflow menu so the room name is no
  longer squeezed out — Search and Threads stay one tap away, and the pinned count still
  shows on the menu button. The desktop layout is unchanged.
- **Bigger touch targets.** On phones and tablets, buttons, reaction chips and list rows now
  meet the ~44px minimum tap size, so they're easier to hit accurately. Desktop (mouse)
  sizing is unchanged.
- **The room list is its own page on phones.** Instead of sliding the channel list over your
  conversation, phones now show the room list as a full screen; tapping a room opens the
  chat, and a back button returns to the list. The desktop two-column layout is unchanged.
- **Choose a colour palette.** Appearance settings now has a **Palette** picker alongside the
  light/dark control, with an **Amethyst** violet theme in addition to the default. The two
  are independent — any palette works in light or dark — and your choice is remembered.

- **Desktop installers are built for every platform on a version tag.** Pushing a `vX.X.X`
  tag now packages the desktop app on Linux (AppImage + deb), macOS (dmg + zip), and Windows
  (installer), and attaches all of them to a **draft** GitHub release for review before
  anything is published. The Linux `.deb` had never actually been buildable — the packaging
  metadata it requires was missing, so that target failed the build; it works now. Installers
  are unsigned until signing credentials are configured.

### Changed

- **Messages you send are now filtered the same way messages you receive are.** Outgoing
  formatted text was checked against a different, more permissive list than the one Trinity
  applies to incoming messages, so it was possible to send markup that Trinity itself would
  refuse to display. Both directions now use the same rule. Two visible consequences, both of
  them things that only ever _looked_ like they worked: a markdown image pointing at a web
  address is sent as a link to that address instead, because Matrix only permits images
  already uploaded to a homeserver and the picture would otherwise arrive as an empty box
  with the address nowhere to be seen; and a link to a relative path or a page anchor keeps
  its text but drops the target, because Matrix requires a full address. Both have always
  been treated that way on arrival — the change is that Trinity no longer sends them.

- **The supported browser list now matches Angular's own.** The build targets Chrome and Edge
  111+, Firefox 112+, and Safari and iOS 16.4+ — Angular 22's published support policy. The
  project had been asking for older browsers than the framework supports (Chrome 107, Firefox
  106, Safari 16.1), which the build warned about on every single run, and which meant CSS and
  JavaScript were being down-levelled for browsers Angular itself makes no promises about.
  Android is now listed explicitly too; it had been missing entirely, so the Android WebView was
  not considered when deciding what to compile down. If you are on a browser older than the
  above, update it — those versions are all from early 2023 or before.

- **The iOS app now requires iOS 16.4 or later.** It previously declared support for iOS 15
  while the web build it wraps was already being compiled for newer browsers — so an iPhone on
  iOS 15 could install Trinity and then be handed JavaScript and CSS its WebView could not
  parse. On iOS the WebView is tied to the OS and cannot be updated separately, so the only
  honest fix is to stop claiming support. In practice this affects devices that cannot go past
  iOS 15 at all — the iPhone 6s, 7 and 1st-generation SE. Anything that can run iOS 16 can run
  16.4, which is a free update.

- **Continuous integration moved to GitHub Actions, and now checks more.** Every pull
  request, and every push to `develop` or `master`, runs the existing gates (lint, stylelint, formatting, unit tests, production
  build) plus two things nothing checked before: the Electron desktop main process is
  unit-tested rather than only compiled, and the Playwright end-to-end journeys run against a
  disposable Matrix homeserver. The end-to-end job deliberately **fails** if that homeserver
  cannot start, because the alternative — the behaviour it had locally — is a green run that
  quietly tested almost nothing. This replaces the previous Crow CI pipeline.
- **The authenticity shield now sits at the edge of the message, and explains itself.** The
  warning icon on a message whose sender couldn't be fully authenticated used to trail the
  timestamp on one kind of row and the message text on another, so it moved around and read
  as part of the text. It now sits at the far right of the row, level with the message's
  first line, in the same place for every message. Pointing at it (or tabbing to it) now
  opens a tooltip that names what was found — say, that the message came from a device its
  owner hasn't verified — and, below that, explains what it means for you and who can clear
  it. Previously it relied on the browser's own tooltip, which said only the first half,
  never appeared on a touchscreen, and couldn't be reached from the keyboard.
- **Two serious warnings are no longer described in vague terms.** A message from someone
  whose verified identity has since changed, or one whose sender doesn't match the device
  that encrypted it, used to fall back to a generic "authenticity couldn't be verified".
  Each now says plainly what happened and what to do about it.
- **Device verification says when it's waiting on the other device.** After you answer
  "They match", verification isn't finished — the other device still has to answer too.
  The emoji screen used to sit there unchanged, as if the tap hadn't registered, inviting
  you to press it again. It now replaces the answer buttons with a spinner and "Waiting for
  the other device to confirm", while the emoji stay on screen so you can still read them
  off. Cancel remains available, and if sending your answer fails the buttons come back so
  you can try again.
- **Room for the message box.** Seven buttons used to crowd the message field, leaving
  almost nothing to type in on a narrow window and overflowing the row entirely on a small
  phone. Attach, GIF, poll, location and voice message now gather behind the **+** button as
  a single **Add to message** menu at every window size, leaving the field flanked by just
  **+**, emoji and send. On a phone the typing area goes from unusable to about ten times its
  old width, and the composer looks the same whatever the screen.
- **The send button is always there.** It used to appear only on touchscreens, on the
  assumption that Enter sends everywhere else. Enter isn't always unambiguous — a draft with
  line breaks, or typing through an input method editor — so the send button now sits beside
  the message box at every size, on every device. (While you are recording a voice message
  the recording bar's own send button takes over, so there is never a pair of them.)
- **Desktop tray icon now matches the app icon.** The system tray / menu-bar icon uses the
  Trinity mark (three connected nodes) instead of the old "T" glyph, so it matches the app
  icon everywhere. On macOS it stays a monochrome template image that follows the light/dark
  menu bar.
- **Upgraded the build toolchain to Angular 22, Nx 23.1, and TypeScript 6.** A maintenance
  upgrade with no change to how the app behaves; it keeps the project on supported framework
  versions and current security patches.
- **Adopted Angular's zoneless change detection.** Trinity no longer ships `zone.js` (~30 kB),
  so it loads a little leaner and drives UI updates straight from signals. Behaviour is
  unchanged.
- **Dark mode looks more cohesive.** Dialogs, menus and pop-ups were rendering near-black —
  darker than the app itself — so overlays stood out as a different, blacker surface. They
  now use the app's grey palette, matching the window behind them.
- **A more consistent, tidier UI.** Corner radii were consolidated into one scale (dropdown
  menus and reaction/badge chips in particular look more consistent), and muted secondary
  text — timestamps, captions, descriptions, empty states — now follows one size scale
  instead of a mix of five, so the same kind of text is the same size everywhere.
- **Reworked the design tokens so themes are easy to add.** All colours and radii now live in
  one place, split into a colour palette and an independent light/dark mode, so a new theme is
  a single self-contained block. No visible change to the default look. See docs/THEMING.md.

### Fixed

- **"Jump to…" and in-room search open ready to type.** Both dialogs put the cursor in
  their search field on open, instead of quietly parking it on the Cancel/Close button
  and swallowing whatever you typed until you clicked into the field. Open-and-type is
  the point of a quick switcher, so Ctrl/Cmd+K now works in one flow again.
- **Replies in a thread you start off your newest message no longer vanish.** Opening
  "Reply in thread" on a message that was still being sent rooted the thread on a
  placeholder id the homeserver never had: the thread opened normally, but every reply
  typed into it was silently dropped. Threading — and pinning, which had the same flaw and
  would have written that placeholder into the room's pinned list — now wait the moment it
  takes for the message to land, so both always act on the real message.
- **Voting in a poll right after you create it works.** Clicking an answer while the poll
  itself was still on its way to the server failed outright with "Could not cast your
  vote", because the vote pointed at a poll the server hadn't seen yet. Answers (and "End
  poll") are held for those few hundred milliseconds instead of failing.
- **"View source" is readable again.** The message-source window had no background of its
  own, so its JSON was drawn straight over the conversation behind it — two sets of text on
  top of each other. It now sits on a card like every other dialog.
- **Consecutive messages line up again.** When you sent several messages in a row, the
  first sat a few pixels to the left of the rest, so a group of your own messages looked
  subtly ragged instead of forming one clean column. The follow-on rows now start exactly
  where the first one does. (The gap varied with the time of day, which is why it looked
  inconsistent.)
- **Mobile push is registered for every account on the same server.** With two or more
  accounts signed in on one homeserver, registering each account's push cancelled the one
  before it, so only the most recently registered account kept a pusher the server could
  route notifications to. Each account now registers without disturbing the others. (Push
  still needs a configured gateway to deliver anything — see docs/PUSH.md.)
- **Warnings and alerts are readable in dark mode again.** Danger indicators were painted in
  a very dark maroon that all but disappeared against the dark chat background — the
  "not verified" encryption shield, the retry prompt on a message that failed to send, and
  kick/ban labels were effectively invisible, and unread mention badges were a near-black
  dot rather than a red one. Alert text and filled mention badges now use separate, measured
  reds, so both stay clearly legible in light and dark and on every palette.
- **Error messages are readable in dark mode again.** The same dark maroon was used for error
  text throughout the app — a failed sign-in, encryption setup and unlock errors, device
  verification failures, the room directory's search error, and the profile, presence and
  account settings warnings — leaving those messages nearly invisible against a dark
  background at the moment they mattered most. They now use the measured alert red. Colours
  were also re-checked against _hovered_ rows, not just resting ones, since a row you are
  pointing at is usually the one you are reading.
- **Destructive buttons and menu items are legible again.** "Delete", "Leave room", "Kick"
  and similar destructive controls — along with invalid form fields — drew their label in a
  maroon so dark it disappeared against the tinted background behind it, worst of all in dark
  mode. Their labels now use the measured alert red, while the button's own background tint
  is unchanged, so the controls look the same but can actually be read.
- **Components follow the colour palette consistently.** Several hand-authored components
  used fixed colours or undefined tokens: the link-preview and location cards rendered a
  near-invisible border and background in light mode, and the mention badge and various
  "danger" reds didn't change with light/dark or the palette. They now use themed tokens, so
  everything re-colours together. The jump-to-latest pill and accent banner also use the
  on-accent text colour, keeping their labels legible on light-accent palettes. Attachment
  cards follow the palette too — image placeholders, file cards and the "couldn't load"
  card were painted a fixed near-white and glared out of a dark timeline.
- **More readable icons and initials.** The server rail's Home/Rooms buttons, the voice-note
  play button and unread badges now use the on-accent text colour so their glyphs stay legible
  on light-accent palettes; and default avatars now pick a dark or light initial by measuring
  it against the circle behind it, so the green, red, pink and amber avatars are all readable
  (previously every initial was white, which only suited half of them). The Explore rooms/spaces toggle and
  the mention picker's search field also announce their state/label correctly to screen readers.
- **The member list is reachable on phones and tablets.** Below 1100px the room's member
  list was hidden with no way to open it. It now slides in as a drawer — from the **Members**
  button on tablets, or the room's **⋮** overflow menu on a phone — and closes by tapping
  outside it. The wide-screen layout, where it stays a side column, is unchanged.
- **Confirmation messages (toasts) appear again.** Actions that report success or failure
  with a small pop-up notification — changing your password, exporting/importing encryption
  keys, reporting a message, renaming a room, updating a room photo, unbanning a member, and
  more — silently showed nothing. The pop-ups now appear as intended.
- **Signing out no longer risks another account's encrypted history.** With more than one
  account signed in, signing out could delete a second account's saved session — and the
  encryption keys that went with it — if that account had been signed out by its server or
  had failed to start up. Its message history could then be permanently unreadable. Signing
  out now only clears everything when it really is the last account.
- **Switching accounts no longer shows the previous account's messages.** With a room open,
  switching accounts left that room on screen still showing the previous account's view of
  it, and reopening the room didn't help — only restarting the app did. The room now closes
  cleanly on a switch.
- **A verification request from another person now says so.** Requests from other users were
  labelled as coming from one of your own sessions, and never named who was asking — while
  the emoji comparison only protects you if you know who you're comparing with. Both screens
  now name the other user and distinguish them from your own devices.
- **Busy rooms are faster to open and scroll.** Loading older messages and opening an
  encrypted room re-processed the whole loaded timeline once per message; a burst of
  activity is now handled in a single pass.
- **A reopened poll updates again.** If a moderator removed a poll's closing event, the poll
  kept showing as closed with stale results until something else in the room changed.
- **Pinned messages keep updating after the app catches up on a room.** Pins added or
  removed by someone else — and gaining or losing permission to pin — could silently stop
  appearing in a room you had open, leaving the pinned panel frozen until you switched
  rooms and back. This happened once the app resynced a room's history, such as after a
  spell offline.
- **Message authenticity shields are readable without colour.** The caution and warning
  shields on encrypted messages used the same icon and differed only by colour; they now
  have distinct shapes, so colourblind users can tell a caution from a warning.
- **Screen readers now announce the offline and encryption banners.** The "You're offline"
  and encryption-setup banners are now read out when they appear, instead of being added to
  the page silently.

## [0.1.0] - 2026-07-13

### Added

- **Room activity in the timeline.** Membership and room changes now appear inline as compact
  system lines — who joined, left, was invited, removed, banned or unbanned; and when someone
  sets or changes the room name, topic, avatar, main address, join rules, history visibility,
  guest access, or turns on end-to-end encryption. No-op changes are omitted to keep it quiet.
- **Voice messages.** A microphone button in the composer records a voice message and sends
  it (MSC3245 `m.audio` with a waveform); recordings are encrypted in E2EE rooms like any
  other attachment. Received voice messages render as a compact player with a play control,
  the waveform, and a running time.
- **Browse public spaces.** The Explore directory now has a **Rooms / Spaces** toggle, so
  you can discover and join public Spaces (not just rooms) from your homeserver's directory;
  a joined space appears in the rail and is selected, a joined room opens in the Rooms view.
- **Share your location.** A location button in the composer sends your position as an
  `m.location` message, rendered as a card with the coordinates and an "Open in maps" link
  (no embedded map tiles, so the strict content-security policy stays intact). On the
  desktop app — where the browser can't read a device position without a bundled Google API
  key — you pick the point in a small dialog by pasting an OpenStreetMap/Google Maps link or
  typing `lat, lng`, with an optional one-tap approximate (IP-based) estimate.
- **Mark rooms as read.** A room's ⋮ menu now has **Mark as read** (when it has unread),
  and the channel-list header gains a **Mark all as read** action — both clear unread badges
  without opening the rooms.
- **See who read a message.** Clicking the read-receipt avatars on a message now expands
  a "Seen by …" list of who has read up to it (also available as a hover tooltip).
- **Message context actions.** A message's ⋯ menu now has **Copy link** (a `matrix.to`
  permalink to the message) and **View source** (the event's raw JSON, in a dialog).
- **Room-upgrade banner.** When a room has been upgraded to a new version, the old room
  now shows a banner with **Go to the new room** — which joins and opens the successor.
- **Slash commands.** The composer now understands IRC-style commands: **/me** (send an
  emote), **/shrug** (append ¯\\_(ツ)_/¯), **/plain** (send without markdown), and **/spoiler**
  (hide text behind a spoiler). Anything else starting with `/` is sent as-is.
- **Link previews.** Messages with a link now show an Open-Graph preview card (title,
  site, description, thumbnail), fetched through your homeserver. They're suppressed in
  encrypted rooms by default — so a link in an E2EE message is never disclosed to the
  server — but you can opt in per device via **Settings → Privacy → Show link previews in
  encrypted rooms** (with a clear warning), and turn previews off entirely from the same
  section. If your homeserver doesn't provide previews (Synapse ships them off), that same
  section now says so instead of leaving you guessing.
- **Verify another user.** A member's info panel now has a **Verify** action that starts
  emoji-SAS verification with them over a direct message — establishing cross-user trust
  (previously you could only verify your own other sessions).
- **Per-message authenticity shields.** Encrypted messages now show a shield when their
  authenticity is in question — sent from an unverified or unknown device, by an unverified
  user, or with a key whose origin can't be guaranteed — with a tooltip explaining why. The
  shields update live as device/user trust changes.
- **Export / import room keys.** The Security section can now save your message keys to a
  passphrase-protected file (the interoperable Matrix megolm `.txt` format that Element
  reads/writes) and import them back — a key backup independent of the server.
- **Security settings.** A new **Security** section in Settings surfaces your end-to-end
  encryption posture — whether encryption/secure backup is set up, whether this session is
  verified, and whether key backup is on — and launches the recovery-setup, recovery-key
  unlock, and device-verification flows to fix each.
- **Notification settings.** A new **Notifications** section in Settings has account-level
  toggles for what notifies you — a master switch plus per-category rules (mentions, @room,
  invitations, calls, direct chats, rooms, and their encrypted variants). They map to your
  homeserver's push rules and sync across every device on your account.
- **Explore public rooms.** The Home **+** menu now has **Explore public rooms** — a
  directory browser that searches your homeserver's public rooms, paginates with **Load
  more**, and lets you **Join** one straight from the results (it then opens in your list).
- **Manage a room's addresses.** The room settings dialog now has an **Addresses** section
  (for anyone whose power level lets them) to publish or remove local aliases
  (`#address:server`) in the homeserver directory and choose which one is the room's main
  (canonical) address.
- **View and lift room bans.** The room settings dialog now shows a **Banned members** list
  (with each ban's reason) for anyone whose power level lets them ban, each with an **Unban**
  action that lets the member be re-invited or rejoin.
- **Control who can join and read history.** The room settings dialog now has **Who can
  join** (invite-only or public) and **Who can read history** (from all history down to
  world-readable) controls, gated by your power level. They write `m.room.join_rules` and
  `m.room.history_visibility` and sync across clients.
- **Stop sending read receipts.** A new **Privacy** section in Settings has a **Send read
  receipts** toggle. Turn it off and reading a message still clears your own unread badge,
  but privately (`m.read.private`) — other people no longer see when you've read their
  messages. It's a per-device choice and applies to both the main timeline and threads.
- **Change your account password.** Settings now has an **Account** section to change your
  password: enter your current password, a new one (confirmed), and the change is applied
  server-side. Your other signed-in sessions stay logged in, and a wrong current password
  is reported clearly rather than as a raw error.
- **Report a message.** The message ⋯ menu now has **Report message** — flag a message to
  the room's server administrators, with an optional reason (`reportEvent`), from the main
  timeline or a thread.
- **Block (ignore) a member.** A member's info panel now has a **Block** / **Unblock**
  action that ignores them account-wide (`m.ignored_user_list`) — hiding their messages
  everywhere and syncing across your devices. It needs no room-admin rights, so it works
  even where you can't moderate.
- **Promote or demote members.** A member's info panel now lets you change their role —
  Member, Moderator, or Admin — for any role at or below your own power level (you can't
  raise someone above yourself, or act on a peer/superior). Written to the room's
  `m.room.power_levels`.
- **Kick and ban members.** From a member's info panel, a moderator or admin can now
  **Remove from room** (kick) or **Ban** them, with an optional reason. The actions show
  only when your power level out-ranks the member and meets the room's kick/ban
  requirement, so you can't act on someone at or above your own rank.
- **Member info panel.** Clicking a member in the member list now opens a panel showing
  their name, ID, live online status, and role (Admin / Moderator / Member), with
  **Message** (start or reuse a direct message) and **Copy user ID** actions — the launch
  surface for further per-member actions.
- **Edit a room's name, topic, and photo.** A new ⚙ button in the room header opens a
  **Room settings** dialog to change the room's name, topic, and avatar. Fields you don't
  have permission to change (by power level) are read-only. Changes save to `m.room.name`
  / `m.room.topic` / `m.room.avatar` and sync across clients.
- **Moderators can delete others' messages.** If your power level in a room meets its
  redaction requirement (a moderator or admin), the message ⋯ menu now offers **Delete
  message** on other people's messages too, not just your own — redacting them for
  everyone. Regular members still only see it on their own messages.
- **Leave a room.** Each room's ⋮ menu in the channel list now has a **Leave room**
  action: confirm, and you leave the room and it drops out of your list. Previously you
  could unlink a room from a space or decline an invite, but there was no way to exit a
  joined room. If the room you leave is the one open, the timeline pane clears.
- **App version and commit in Settings.** The Settings screen now shows the running
  build's version and git commit in a small footer (e.g. `Trinity v0.0.1 · a1b2c3d`),
  regenerated from `package.json` + git at build time — handy for bug reports.
- **Polls.** Create a poll from the composer (a question with two to eight answers),
  and it renders in the timeline with a share bar per option and a live vote tally.
  Tap an answer to vote (or change your vote); the poll's creator can end it, after
  which the results are final. Built on the Matrix poll events (MSC3381), so it
  interoperates with other clients.
- **Forward messages to another conversation.** The message overflow menu now has a
  **Forward** action: pick a room or direct message from the switcher and the message
  is re-sent there as a standalone message. Works for text and media (including in
  encrypted rooms, since an attachment carries its own key), from rooms and threads.
- **"Seen by" read receipts.** Messages now show small avatars of the members who have
  read up to them, updating live as people catch up — so you can tell who's seen what.
- **In-app navigation for Matrix links.** Clicking a `matrix.to` link in a message now
  stays in Trinity: a room link opens that room (resolving an alias and jumping to a
  linked message), and a person link (including a mention) opens a small profile card —
  avatar, name, online status, and a **Message** button to start a direct message.
  Ordinary web links open in a new tab instead of navigating away from the app.
- **Per-room notification level.** Each room's ⋮ menu in the channel list has a
  **Notifications** submenu to set how a room notifies you — **All messages**, **Mentions &
  keywords only**, or **Mute** — persisted as Matrix push rules so it follows you across
  devices. Muting suppresses even mentions; mentions-only keeps highlight pings while
  silencing everything else.
- **"New messages" divider and jump-to-unread.** Trinity now persists a fully-read
  marker (`m.fully_read`) alongside the read receipt, so returning to a busy room shows a
  "New messages" divider at exactly where you left off — and, when that divider is
  scrolled out of view, a "↑ New messages" pill that jumps you straight to it. The
  divider stays put for the visit even as new messages are marked read, and the marker
  now survives reloads and syncs across your devices.
- **Set your own presence and status.** A new **Settings → Presence** section lets you
  publish your online state — Online, Away, or Offline — and an optional status message,
  the counterpart to the presence dots already shown for other people. Homeservers that
  disable or rate-limit presence are handled gracefully.
- **Spoilers are now hidden until you reveal them.** Messages containing spoiler
  content (`data-mx-spoiler`) previously showed it in the clear; it now renders as a
  black bar that you click — or focus and press Enter/Space — to uncover. A first click
  that lands on a link inside a spoiler only reveals it rather than following the link.
- **React with any emoji.** The message reaction popover kept only six quick emoji;
  a new "+" button now opens the full emoji picker (search included), so you can react
  with anything — in rooms and threads alike. The six one-tap reactions stay as a fast path.
- **Typing indicators.** The composer now tells the room when you're typing, and an
  "X is typing…" row appears under the timeline when other members type — naming up to
  three of them and summarising beyond that. It clears the moment they send or stop, and
  Trinity stops advertising your own typing as soon as you send or leave the room.
- **@-mention people from the composer.** Type `@` and a name to pick a room member
  from an autocomplete menu; the sent message links them and, crucially, carries
  `m.mentions` so they're actually notified — including replies, which now ping the
  message's author. Works in rooms and threads, for new messages, replies, and edits.
- **Message drafts are kept per conversation.** A half-typed message now stays with
  its room (or thread) when you switch away and comes back when you return, and it
  survives a reload or app restart. Previously the composer was shared across rooms,
  so an unsent message bled into the next room you opened and was lost on reload.
- **Settings, reorganised into a browsable submenu.** The settings screen is now a
  menu of sections — **Profile**, **Appearance**, **Devices**, **GIFs**, and
  **Experimental** — each on its own page. On desktop the menu and the selected
  section sit side by side (two-pane); on mobile the menu is the entry point and
  tapping a section opens it, with a back button returning to the list. Deep links and
  reloads land on the exact section, and back leaves settings in one press rather than
  retracing the sections you visited. The profile picture is now changed from a camera
  badge tucked into the corner of the avatar rather than a separate button.
- **Multiple accounts, signed in at once.** Sign into several Matrix accounts and keep
  them all syncing concurrently. Switch the active account from the user panel in the
  channel sidebar (which lists each account with its own unread count and marks the
  active one), add another via **Add account**, and sign accounts out individually. The
  app-icon badge now sums unread across every account, and desktop/web notifications
  fire for background accounts too — tapping one switches to the owning account before
  opening the room. On mobile, each account registers its own push pusher tagged with
  its user id (full per-account push delivery also needs a push-gateway change — see
  `docs/PUSH.md`). Each account gets an isolated encryption (crypto) store, so accounts
  never share keys.
- **Graceful handling of a revoked session, with re-authentication.** If a homeserver
  signs one account out (its access token is revoked server-side), the other accounts
  keep running: a soft logout keeps that account's data, and it appears in the account
  switcher as "Signed out — Sign in" so you can re-authenticate it in place (reusing its
  existing device, so no re-verification), while a hard logout wipes it. Losing your last
  account returns you to the login screen instead of a broken shell.
- **Persistent local storage.** Trinity now asks the browser to keep its on-device
  data (each account's message-sync and encryption stores) persistent so it isn't
  evicted under storage pressure — which matters more as accounts add up, since an
  evicted encryption store would force that account to re-verify.
- **Send GIFs from the composer.** A new GIF button (beside the emoji picker) opens a
  searchable GIF grid — trending on open, live search as you type — and sends the chosen
  GIF as an image message in rooms and threads (encrypted rooms included). Search is
  powered by **Tenor** or **GIPHY**: pick a provider and paste a free API key in
  Settings → GIFs. The GIF button stays hidden until a key is configured.
- **Online status for members and direct messages.** The room member list now
  reflects each member's Matrix presence: a coloured dot on their avatar (green
  online, amber away, grey offline), with online members ordered first and offline
  members dimmed. Each direct-message row in the sidebar also shows the other
  person's status on their avatar. All updating live. The presence dot is built
  into the shared avatar component.
- **Role sections in the member list.** The room member list now groups members
  under **Admin**, **Moderator**, and **Member** headers (derived from each member's
  power level, the same 100/50 convention Element uses), each header showing that
  role's count. The panel leads straight into these sections. Empty roles are hidden,
  online-first ordering and the offline dimming are kept within every section, and a
  promotion or demotion re-sorts the list live.

### Changed

- **Restructured the Nx workspace into typed, per-domain libraries.** The monolithic
  `@trinity/core` lib was dissolved into `@trinity/util-matrix` (pure DI-free models/
  helpers), `@trinity/platform-native` (Capacitor/native capabilities), and per-domain
  `@trinity/data-access-*` libs over the shared `@trinity/data-access-matrix-client`
  foundation. The app shell moved to `@trinity/feature-shell`, leaving `apps/trinity` as
  bootstrap + routing only. `@nx/enforce-module-boundaries` now enforces a typed
  dependency ladder (`app → feature → {data-access, ui} → {util, platform}`, features
  never depend on features) plus a `scope:shared` / `scope:matrix` split so the kernel
  stays domain-agnostic. Consumers import the specific lib instead of `@trinity/core`.
- Migrated the unit test suite to `@testing-library/angular` (`render`) + `ng-mocks`
  (`MockProvider`/`MockComponent`).
- Slimmed oversized component input/output surfaces (channel-sidebar, message-row +
  message-toolbar, media-bubble, server-rail) — grouping related inputs into view-model
  objects, reading core signals directly, and collapsing the message-action outputs into
  one typed event.
- Moved all inline component templates into sibling `.html` `templateUrl` files.

### Fixed

- **Mention notification toggles now work on every homeserver.** The "When someone mentions
  my name" and "When someone posts @room" switches were bound to the legacy push-rule ids
  (`.m.rule.contains_display_name` / `.m.rule.roomnotif`); on homeservers that use the newer
  intentional-mention rules (`.m.rule.is_user_mention` / `.m.rule.is_room_mention`) the switch
  couldn't be turned on. Each toggle now reads and writes whichever of those rules the server
  actually defines (both, where a server ships both), so it always reflects and controls your
  real setting.
- **"Mark as read" now respects your read-receipt privacy.** Marking a room (or all rooms)
  read sent a public read receipt even when you'd turned read receipts off — leaking your
  read position to other members. It now acks privately when the setting is off, like the
  automatic on-view path.
- **Authenticity shields and link previews now show on grouped messages.** A shield (or an
  Open-Graph preview) only rendered on the first message of a Discord-style group, so a
  suspicious — or link-bearing — continuation message showed neither. Both now render on
  every message.
- **Polls and shared locations can no longer be "edited".** They offered a text-edit
  affordance that would have corrupted the poll/location; only text messages are editable.
- **Voice recording is more robust.** A recording is now cancelled when you switch rooms
  (so the mic doesn't stay open and a later send can't post to the wrong room), a double-tap
  can't open two microphone streams, and a torn-down composer no longer leaves the mic on.
- **Link previews recover from a hiccup.** A one-off homeserver error while fetching a
  preview was cached for the whole session, permanently hiding that link's card; a transient
  failure now retries on the next view.
- **Copied message links are resolvable.** A copied `matrix.to` permalink to a room-by-ID now
  includes a `?via=` server hint, so recipients not already in the room can open it.
- **Thread replies understand slash commands** (`/me`, `/shrug`, `/plain`, `/spoiler`), and
  the thread composer no longer shows poll/location/voice buttons that would have
  posted to the main room instead of the thread. `/me` now also carries @-mentions.
- **Searching the public directory no longer reloads the app.** The Explore directory's
  search form performed a native browser submit (it had no Angular form binding), which
  navigated away and closed the dialog instead of running the search. It now searches in
  place.
- **Links in messages are now clickable.** A bare URL in a message rendered as plain
  text — because a plain-text message (no HTML formatting) wasn't linkified. URLs are
  now turned into links when a message is displayed, so they're clickable regardless of
  whether the sender's client included formatted HTML, and they open in a new tab.
- New sessions now register with the device name **Trinity** instead of the stale
  **Trinity (Ionic)** — the app no longer runs on Ionic, so the label shown in
  Settings → Devices (and to other Matrix clients) shouldn't advertise it.
- Hardened the room and thread send paths (messages, attachments, edits, replies,
  reactions, redactions): each now resolves the active account and the open room at the
  moment the send runs, rather than when it is created. Nothing in the app could trigger
  the old behaviour today, but it closed a latent path for a send to land on an account
  you had just switched away from — or to upload unencrypted bytes into a room that had
  become encrypted in the meantime.
- Clearing your GIF API key no longer forgets which GIF provider you had chosen. Settings
  → GIFs stored the provider and the key together, so **Clear** discarded both and the next
  time you opened the app the provider had silently reverted to Tenor. GIPHY users now stay
  on GIPHY after clearing their key.
- Signing an account out and then logging back in failed with a crypto error ("the account
  in the store doesn't match the account in the constructor"), leaving that account unable to
  sign back in. Sign-out wiped the account's message cache but deleted the wrong encryption
  store, so its real one was left behind; because the store was keyed only by user, the next
  login (which gets a fresh device from the server) reopened that stale store and refused to
  start. Two fixes: sign-out now deletes the correct encryption store, and each login's
  encryption store is now scoped to its device, so a fresh login always starts clean instead
  of reopening an old device's store. This also recovers accounts that were already stuck.
  Re-logging in on a new device without signing out first now also cleans up the previous
  device's leftover encryption store instead of leaving it on disk, and on startup any
  encryption stores orphaned by earlier versions are swept away to reclaim disk space.
- OnPush re-render regression on the message timeline: per-row caps are now memoized so
  scrolling/typing no longer re-renders every visible row and its toolbar.

### Removed

- Leftover Ionic `--ion-*` CSS custom properties (dead since the UI moved to spartan-ng);
  the dark-mode class `.ion-palette-dark` was renamed to `.dark`.
