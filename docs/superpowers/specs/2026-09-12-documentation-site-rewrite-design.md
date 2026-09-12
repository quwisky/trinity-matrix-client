# Trinity Documentation Site Rewrite Design

**Status:** Approved for implementation

**Date:** 2026-09-12

**Target:** `develop`

## Purpose

Replace Trinity's current public documentation with two independent, English-only
Starlight sites: one for product users and one for developers. Publish both sites as
one atomic GitHub Pages deployment at
`https://quwisky.github.io/trinity-matrix-client/`.

The rewrite starts from a new information architecture. Existing documents are
evidence and source material, not a structure to preserve. Old URLs and temporary
compatibility pages are not required.

## Reader and content boundaries

The public documentation has two audiences:

- **Users** need instructions for the latest published Trinity release.
- **Developers** need instructions and architecture guidance for the current
  `develop` branch.

Maintainer-only procedures, agent instructions, credentials, publication internals,
temporary plans, and historical validation evidence are not public-site content.
Required agent discovery files such as `AGENTS.md`, `.agents/`, and `.claude/` remain
at the repository paths their tools expect, but neither Starlight build may ingest or
link to them.

## Selected platform

Use Astro Starlight for both sites. Starlight supplies static output, Markdown and
MDX content, typed content metadata, accessible documentation navigation, Pagefind
search, and configurable sidebars. Keep authoring portable by using ordinary
Markdown for prose and reserving Astro or MDX components for shared presentation
that plain Markdown cannot express.

The initial sites are English-only. Routes and explicit heading identifiers must be
stable enough to support future localization without changing English URLs.

Older release documentation is not retained. Publishing a new release replaces the
user site at its existing stable routes.

## Repository structure

Create two separate Starlight applications and shared, non-content tooling:

```text
apps/
├── docs-users/
│   ├── public/
│   ├── src/
│   │   ├── assets/
│   │   └── content/docs/
│   ├── astro.config.mjs
│   ├── project.json
│   └── tsconfig.json
└── docs-developers/
    ├── public/
    ├── src/
    │   ├── assets/
    │   └── content/docs/
    ├── astro.config.mjs
    ├── project.json
    └── tsconfig.json

tools/docs/
├── portal/
├── shared-assets/
├── shared-components/
├── shared-theme/
├── validation/
├── assemble-pages.mjs
└── project.json

docs-internal/
├── decisions/
├── maintenance/
└── README.md
```

The applications may share theme code, icons, accessible components, validation,
and build utilities from `tools/docs/`. They must not share prose or content
collections. This prevents a developer document or an unreleased product claim from
entering the user site through a shared import.

`docs-internal/` contains durable repository records that are useful to maintainers
or developers working inside the checkout but are not suitable for the public site.
Tool-discovered instruction files remain in their required root or hidden paths.

## Public URL structure

GitHub Pages serves the assembled artifact beneath the repository path:

```text
https://quwisky.github.io/trinity-matrix-client/
├── users/
└── developers/
```

The Pages root is a small, accessible audience chooser. It links to the user and
developer sites and does not create a third documentation navigation hierarchy.

Configure Astro with:

```text
site: https://quwisky.github.io
```

The user application uses base
`/trinity-matrix-client/users`; the developer application uses base
`/trinity-matrix-client/developers`. Each build must produce links and assets for its
final base directly. The assembly step must not rewrite compiled HTML URLs.

Each site owns its sidebar, Pagefind index, sitemap scope, 404 behavior, and channel
banner. Search results never cross between the two sites.

## User-site information architecture

After the first published release, the user site uses these routes:

```text
/users/
├── start/
│   ├── choose-a-platform
│   ├── install
│   ├── sign-in
│   ├── secure-your-account
│   └── quick-tour
├── accounts/
│   ├── add-and-switch
│   ├── manage-devices
│   └── sign-out-and-remove
├── conversations/
│   ├── find-and-join-rooms
│   ├── organize-rooms-and-spaces
│   ├── send-and-manage-messages
│   ├── share-media-and-files
│   ├── threads-replies-and-reactions
│   └── search
├── notifications/
│   ├── notification-settings
│   ├── room-notifications
│   └── platform-behavior
├── security/
│   ├── encryption-overview
│   ├── verify-devices
│   ├── recovery-and-backup
│   └── privacy-and-local-data
├── personalize/
│   ├── appearance
│   ├── accessibility
│   └── application-settings
├── platforms/
│   ├── web-and-pwa
│   ├── desktop
│   ├── android
│   └── ios
└── help/
    ├── troubleshooting
    ├── known-limitations
    ├── frequently-asked-questions
    ├── whats-new
    └── report-a-problem
```

User pages use visible product language and task-focused procedures. They do not
expose repository layout, SDK details, CI behavior, architecture ownership, or
unreleased capabilities.

### Before the first release

The repository currently has no Git tag or published GitHub release. Until the first
release is published, `/users/` contains one WIP page explaining that Trinity has no
published release and directing contributors to `/developers/`. The unreleased user
site must not publish empty category pages or draft feature instructions.

Represent this state with a validated release manifest equivalent to:

```json
{
  "status": "unreleased",
  "version": null
}
```

After the first release is published, a documentation follow-up changes `status` to
`published`, records the exact GitHub release version, and adds content verified against
the released artifacts. The published site header displays `Latest release · vX.Y.Z`.

Editorial corrections may be published between releases, but behavior claims must
continue to describe the recorded published version.

## Developer-site information architecture

The developer site uses these routes:

```text
/developers/
├── start/
│   ├── prerequisites
│   ├── clone-and-install
│   ├── run-trinity
│   ├── repository-tour
│   └── make-your-first-change
├── architecture/
│   ├── system-overview
│   ├── capability-ownership
│   ├── dependency-boundaries
│   ├── state-and-reactivity
│   ├── matrix-integration
│   ├── encryption-and-trust
│   ├── workspace-and-navigation
│   ├── host-capabilities
│   └── ui-and-theming
├── development/
│   ├── angular-components
│   ├── signals-and-rxjs
│   ├── forms-and-validation
│   ├── data-access-services
│   ├── public-ui-components
│   ├── styling-and-responsive-ui
│   ├── matrix-features
│   └── platform-integrations
├── testing/
│   ├── testing-strategy
│   ├── unit-tests
│   ├── component-and-browser-tests
│   ├── matrix-e2e-tests
│   ├── desktop-and-native-tests
│   └── diagnose-failures
├── platforms/
│   ├── web-and-pwa
│   ├── electron
│   ├── android
│   └── ios
├── contributing/
│   ├── choose-the-change-owner
│   ├── coding-conventions
│   ├── branches-and-commits
│   ├── validate-a-change
│   ├── prepare-a-pull-request
│   └── write-documentation
└── reference/
    ├── technology-stack
    ├── commands
    ├── project-and-library-catalog
    ├── import-aliases
    ├── configuration
    ├── diagnostics
    └── security-invariants
```

The developer site header displays `Develop branch`. Build metadata records the full
source commit; the visible footer may use its short form. Developer content must link
to exact source owners where that helps a contributor act.

A new developer succeeds when they can install the workspace, run Trinity, understand
the ownership boundaries, choose the right location for a change, run meaningful
validation, and prepare a reviewable pull request without private knowledge.

## Content model

Every public page uses schema-validated frontmatter. A user page follows this shape:

```yaml
---
title: Verify another device
description: Confirm that a device belongs to you and can access encrypted messages.
audience: user
contentChannel: release
pageType: how-to
platforms: [web, desktop, android, ios]
productVersion: 0.1.0
---
```

Developer pages use `audience: developer` and `contentChannel: develop`. Their build
identity comes from the checked-out commit, not a manually copied version string.

Allowed page types are:

- `tutorial`: guided learning with a defined outcome;
- `how-to`: instructions for one concrete task;
- `explanation`: conceptual or architectural understanding;
- `reference`: precise commands, contracts, configuration, or compatibility data.

The schemas reject unknown audiences, channels, page types, and platforms. User-page
versions must equal the published release manifest when its status is `published`.
The unreleased WIP page is the only user page allowed when status is `unreleased`.

## Authoring rules

- Verify claims against the correct channel: a release artifact for users and
  `develop` for developers.
- Use one canonical page for each procedure or fact. Link rather than copy.
- Keep navigation at no more than three levels below a site root.
- Give durable headings explicit identifiers.
- Use visible labels exactly as Trinity renders them.
- Declare platform applicability in metadata and show it in the page.
- Separate prerequisites, actions, expected results, failure recovery, and next steps.
- Do not describe planned behavior as implemented.
- Keep prose in Markdown. Use shared components only for behavior such as platform
  selectors or channel warnings that plain Markdown cannot express consistently.
- Do not publish internal paths, credentials, agent orchestration, maintainer release
  mechanics, temporary plans, or historical execution evidence.
- Do not commit screenshots or proof media under the current repository policy. Use
  text, accessible diagrams, icons, and callouts.

## Source-derived content

Generate only facts that are both mechanical and prone to drift:

- installed technology versions from the relevant manifests and lockfile;
- current Nx project names, roots, tags, targets, and public aliases;
- root package commands and their short descriptions;
- the source commit used for a developer build.

Generation produces reference-page input or checked fragments, not entire explanatory
guides. A failed source extraction blocks the build rather than retaining stale output.
Generated content must be deterministic and reviewable.

## Rewrite and disposition process

Build the new structure without preserving the current navigation. Existing files are
examined only to recover verified facts, procedures, constraints, and historical records
that still have an owner.

During the rewrite, maintain a temporary inventory outside the public content roots. It
assigns every existing first-party document exactly one disposition:

- rewritten into a named new page;
- absorbed into another canonical page;
- retained as repository-internal guidance;
- removed because it is obsolete or redundant;
- excluded because it is generated, vendored, or installer-managed.

The inventory must name the replacement page or internal owner when applicable. Remove
the inventory after all dispositions are complete and validated so it cannot become a
second stale documentation map.

The old public documentation may disappear during development. No compatibility pages,
redirect map, or legacy navigation are required. Merge and publish only the complete
replacement.

## Internal documentation disposition

Retain current, durable architecture decisions under `docs-internal/decisions/` when
their reasoning still matters. Current developer-facing architecture belongs in the
developer site, not in decision records. Preserve required contributor and agent rules at
the paths used by repository tooling, shortening them to private entry points when their
substance moves elsewhere.

Delete completed implementation plans, dated validation reports, one-time rewrite
inventories, redundant routing pages, superseded procedures, and prose that only describes
removed tools or branches. Generated, vendored, and installer-managed documentation stays
under its owning tool unless that dependency is deliberately removed through its supported
workflow.

## Nx integration

Both applications are Nx projects with consistent targets:

```text
docs-users:serve
docs-users:build
docs-users:check

docs-developers:serve
docs-developers:build
docs-developers:check

docs-site:assemble
docs-site:check
```

Use the root pnpm installation and pinned dependencies. The application build targets call
Astro through the repository's Nx execution conventions. Output paths are distinct so the
sites can build independently without deleting each other's files.

`docs-site:assemble` creates one clean Pages directory containing the portal, user site,
and developer site. It refuses unknown top-level output, symlinks, source maps, internal
documents, and files outside the expected route roots.

## GitHub Pages deployment

Pull-request validation performs this sequence:

```text
validate metadata and content boundaries
→ build user site
→ build developer site
→ assemble Pages artifact
→ validate assembled routes, assets, labels, and search separation
→ run browser and accessibility smoke coverage
→ do not deploy
```

A push to `develop`, or an authorized manual dispatch for that revision, repeats the same
checks and then uploads the assembled directory as one GitHub Pages artifact. A separate
deployment job uses the `github-pages` environment with `pages: write` and
`id-token: write`. Build jobs keep read-only repository permissions.

Both sites deploy together or neither deploys. Failed validation leaves the previously
published Pages deployment unchanged. Only a protected `develop` deployment may update the
public site.

## Validation

Blocking static checks cover:

- frontmatter schema and channel-specific metadata;
- duplicate routes and duplicate canonical-topic identifiers;
- internal links and explicit heading anchors;
- missing assets and invalid GitHub Pages base paths;
- imports or links from public content into internal documentation;
- cross-site content or search-index leakage;
- user release-manifest consistency;
- deterministic stack, command, project, alias, and commit reference generation;
- forbidden symlinks, source maps, evidence, secrets, and internal files in output;
- successful production builds for both Starlight applications;
- formatting and applicable repository source-contract tests.

Browser smoke coverage exercises:

- the root audience chooser;
- the user WIP page before the first release, and the release landing page afterward;
- developer landing and onboarding navigation;
- each site's sidebar and previous/next navigation;
- independent Pagefind search results;
- correct cross-site links beneath the repository base path;
- a missing route and its recovery navigation;
- keyboard access, landmarks, focus visibility, contrast, and automated accessibility
  checks for shared layouts and navigation.

External HTTP links run in a scheduled reporting workflow rather than blocking pull requests.
Third-party downtime must not make a content change nondeterministically fail.

## Failure handling

- Invalid content fails its owning site's `check` target with the page and field or link.
- Source-derived reference generation fails closed when a manifest or Nx query cannot be
  interpreted.
- Either site build failing prevents assembly.
- Assembly starts from an empty controlled output directory and rejects unexpected files.
- Browser smoke failures retain normal ignored diagnostics but do not publish them.
- Upload or deployment failure reports the failed revision and does not mutate source files.
- A release-manifest mismatch blocks the user build; it never falls back to develop content.

## Delivery sequence

1. Create shared site infrastructure, both Starlight shells, Nx targets, and final base paths.
2. Add schemas, content-boundary checks, link and anchor validation, and source-derived
   reference tooling.
3. Implement the root portal and the unreleased user WIP site.
4. Rewrite and validate the complete developer site against `develop`.
5. Classify every old first-party document, retain necessary private material, and remove
   obsolete public content.
6. Add production build, assembly, browser smoke, accessibility, and artifact-safety checks.
7. Add pull-request validation and protected GitHub Pages deployment.
8. After the first GitHub release is published, author and verify the full user
   information architecture against its released artifacts, switch the manifest to
   `published`, and replace the WIP page.

Steps 1–7 deliver a complete documentation platform and public developer site without making
unsupported product-release claims. Step 8 is release work and cannot be completed before a
published release artifact exists.

## Completion criteria

Before the first release, the rewrite is complete when:

- the root portal, user WIP site, and full developer site build and deploy atomically;
- a new developer can install, run, understand, change, validate, and prepare Trinity for
  review using the developer site;
- every old first-party document has an explicit completed disposition;
- no public output contains internal or cross-channel material;
- all static, production-build, browser, accessibility, and artifact checks pass.

After the first release, the user documentation is complete when a new user can install,
sign in, secure an account, communicate, configure Trinity, understand platform differences,
and recover from common problems using pages verified against that release.
