# Trinity Documentation Site Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Trinity's public Markdown tree with separate Starlight user and developer sites, publish them atomically through GitHub Pages, and retain only necessary private documentation outside the public builds.

**Architecture:** Two independent Astro Starlight applications own separate content collections, navigation, and search indexes. Shared code under `tools/docs/` owns presentation, validation, source-derived reference data, assembly, and local serving but never public prose. One GitHub Pages workflow builds both sites, assembles them with a root audience portal, validates the final artifact, and deploys only protected `develop` revisions.

**Tech Stack:** Node `^24.15.0`, pnpm `11.19.0`, Nx `23.2.1`, Astro `7.3.2`, Starlight `0.42.0`, Astro Check `0.9.10`, Vitest `4.1.11`, Playwright `1.62.1`, GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-09-12-documentation-site-rewrite-design.md`

## Global Constraints

- Public URL: `https://quwisky.github.io/trinity-matrix-client/`.
- User base path: `/trinity-matrix-client/users`.
- Developer base path: `/trinity-matrix-client/developers`.
- User content describes only the latest published release; before the first release it contains one WIP page.
- Developer content describes `develop`.
- English only; use stable slugs and explicit heading IDs.
- Public builds must not contain maintainer, agent, credential, temporary-plan, or historical-validation content.
- User and developer prose, sidebars, and Pagefind indexes remain separate.
- Do not retain old public URLs or compatibility pages.
- Do not commit screenshots, GIFs, proof media, source maps, or browser diagnostics.
- Keep generated, vendored, and installer-managed documentation under its owning tool.
- Commit each completed logical task with the Conventional Commit named in its review checkpoint.
- Push the completed branch and open a pull request targeting `develop`; do not merge it.

---

### Task 1: Register the two Starlight applications

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/docs-users/project.json`
- Create: `apps/docs-users/astro.config.mjs`
- Create: `apps/docs-users/tsconfig.json`
- Create: `apps/docs-users/src/content.config.ts`
- Create: `apps/docs-developers/project.json`
- Create: `apps/docs-developers/astro.config.mjs`
- Create: `apps/docs-developers/tsconfig.json`
- Create: `apps/docs-developers/src/content.config.ts`
- Create: `tools/docs/project.json`
- Test: `scripts/documentation-site.spec.mjs`

**Interfaces:**

- Produces Nx projects `docs-users`, `docs-developers`, and `docs-site`.
- Produces distinct outputs `dist/docs/users`, `dist/docs/developers`, and `dist/docs-site`.
- Adds exact root dev dependencies `astro@7.3.2`, `@astrojs/starlight@0.42.0`, and `@astrojs/check@0.9.10`.

- [ ] **Step 1: Write the failing project-registration test**

Add a Vitest suite that reads each new `project.json` and asserts its name, application/tool type, `type:tool` and `scope:shared` tags, target commands, and distinct outputs. Assert the exact dependency versions in `package.json`.

```js
it('registers independent user and developer documentation builds', () => {
  const users = json('apps/docs-users/project.json');
  const developers = json('apps/docs-developers/project.json');
  expect(users.name).toBe('docs-users');
  expect(developers.name).toBe('docs-developers');
  expect(users.targets.build.outputs).toEqual(['{workspaceRoot}/dist/docs/users']);
  expect(developers.targets.build.outputs).toEqual(['{workspaceRoot}/dist/docs/developers']);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm nx test scripts -- documentation-site`

Expected: FAIL because `apps/docs-users/project.json` does not exist.

- [ ] **Step 3: Inspect Nx generation support before scaffolding**

Use the repository `nx-generate` workflow to inspect available generators and schemas. Do not install an unrelated Nx plugin. If no installed generator owns Astro/Starlight applications, create the reviewed files directly as declared by this plan.

- [ ] **Step 4: Install the pinned site dependencies**

Run:

```bash
pnpm add --save-dev --save-exact astro@7.3.2 @astrojs/starlight@0.42.0 @astrojs/check@0.9.10
```

Inspect `package.json`, `pnpm-lock.yaml`, install scripts, licenses, and the resolved dependency tree. Update `pnpm-workspace.yaml` only if pnpm reports a blocked build script required by these packages; name that package explicitly rather than broadening script permissions.

- [ ] **Step 5: Add the Nx projects and minimal Astro configuration**

Each app uses `nx:run-commands` with `cwd` set to its project root:

```json
{
  "serve": { "executor": "nx:run-commands", "options": { "command": "astro dev" } },
  "build": { "executor": "nx:run-commands", "options": { "command": "astro build" } },
  "check": { "executor": "nx:run-commands", "options": { "command": "astro check" } }
}
```

Configure `site`, the channel-specific `base`, and a URL-derived `outDir`. Use `astro/tsconfigs/strict` for each application. Configure the Starlight `docs` collection with `docsLoader()` and `docsSchema()`.

- [ ] **Step 6: Verify project discovery and focused checks**

Run:

```bash
pnpm nx show project docs-users --json
pnpm nx show project docs-developers --json
pnpm nx show project docs-site --json
pnpm nx test scripts -- documentation-site
```

Expected: all three projects resolve and the registration test passes.

- [ ] **Step 7: Review checkpoint**

Review only the manifests, lockfile, project registrations, and minimal configs. Commit with `build(docs): add Starlight documentation projects`.

### Task 2: Enforce channel metadata and the unreleased user state

**Files:**

- Create: `tools/docs/validation/frontmatter.ts`
- Create: `tools/docs/validation/release-manifest.mjs`
- Create: `tools/docs/validation/release-manifest.spec.mjs`
- Create: `apps/docs-users/release.json`
- Modify: `apps/docs-users/src/content.config.ts`
- Modify: `apps/docs-developers/src/content.config.ts`
- Create: `apps/docs-users/src/content/docs/index.md`
- Create: `apps/docs-developers/src/content/docs/index.md`

**Interfaces:**

- Produces `publicPageSchema('user' | 'developer')` for Starlight schema extension.
- Produces `readReleaseManifest(path)` returning `{ status: 'unreleased'; version: null } | { status: 'published'; version: string }`.
- Enforces that unreleased user content contains only `index.md`.

- [ ] **Step 1: Write failing manifest and schema tests**

Cover valid unreleased/published manifests, malformed versions, unknown fields, wrong audience/channel pairs, invalid page types/platforms, and a second user page during unreleased status.

```js
expect(readReleaseManifest(validUnreleased)).toEqual({
  status: 'unreleased',
  version: null,
});
expect(() => readReleaseManifest(invalidPublished)).toThrow(/published release requires a semantic version/);
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm nx test docs-site -- release-manifest`

Expected: FAIL because the parser and schema do not exist.

- [ ] **Step 3: Implement the discriminated release manifest**

Reject unknown keys. Accept only `unreleased/null` or `published/<major.minor.patch>`. Add:

```json
{
  "status": "unreleased",
  "version": null
}
```

- [ ] **Step 4: Extend both Starlight schemas**

Require `description`, `audience`, `contentChannel`, `pageType`, and `platforms`. User pages require `audience: user`, `contentChannel: release`, and a version compatible with the release manifest. Developer pages require `audience: developer` and `contentChannel: develop` and reject `productVersion`.

- [ ] **Step 5: Add initial landing content**

The user page states that Trinity has no published release and links to the developer site. The developer page identifies itself as `develop` documentation and routes readers to setup, architecture, testing, and contribution entry points.

- [ ] **Step 6: Run channel checks**

Run:

```bash
pnpm nx test docs-site -- release-manifest
pnpm nx run docs-users:check
pnpm nx run docs-developers:check
```

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Verify the user build cannot admit a second content page before a release. Commit with `feat(docs): enforce public content channels`.

### Task 3: Build shared presentation and the Pages portal

**Files:**

- Create: `tools/docs/shared-theme/trinity.css`
- Create: `tools/docs/shared-components/ChannelBanner.astro`
- Create: `tools/docs/shared-components/SiteFooter.astro`
- Create: `tools/docs/shared-assets/trinity-mark.svg`
- Create: `tools/docs/portal/index.html`
- Create: `tools/docs/portal/404.html`
- Modify: `apps/docs-users/astro.config.mjs`
- Modify: `apps/docs-developers/astro.config.mjs`
- Modify: both landing pages
- Test: `scripts/documentation-site.spec.mjs`

**Interfaces:**

- Produces visible channel labels `Work in progress` and `Develop branch`.
- Produces an accessible root chooser with links beneath `/trinity-matrix-client/`.
- Shares presentation only; it exports no content collection or prose.

- [ ] **Step 1: Add failing static contract assertions**

Assert that both Astro configs load the same custom CSS and component overrides, use different titles/base paths, and never import another app's content root. Assert the portal contains exactly the user and developer destinations.

- [ ] **Step 2: Run the focused contract and verify it fails**

Run: `pnpm nx test scripts -- documentation-site`

Expected: FAIL on absent shared presentation and portal files.

- [ ] **Step 3: Implement restrained shared branding**

Use the Trinity mark, readable system typography, light/dark Starlight variables, visible focus, and WCAG-compliant contrast. Do not import Angular product CSS or Spartan components into Astro.

- [ ] **Step 4: Add channel banners and footer metadata**

The user banner derives WIP or release text from `release.json`. The developer banner always says `Develop branch`; its footer exposes the build commit when available.

- [ ] **Step 5: Add the root portal and static 404 recovery**

The portal heading is `Trinity documentation`, explains the audience split, and provides two ordinary links. The 404 page returns to the portal and both site roots without JavaScript.

- [ ] **Step 6: Build both sites**

Run:

```bash
pnpm nx run docs-users:build
pnpm nx run docs-developers:build
```

Expected: both builds pass and use their final base paths.

- [ ] **Step 7: Review checkpoint**

Inspect built HTML for channel labels and base-prefixed links. Commit with `feat(docs): add shared site presentation`.

### Task 4: Add deterministic documentation validation and assembly

**Files:**

- Create: `tools/docs/validation/markdown-links.mjs`
- Create: `tools/docs/validation/content-boundaries.mjs`
- Create: `tools/docs/validation/source-reference.mjs`
- Create: `tools/docs/validation/artifact.mjs`
- Create: matching `*.spec.mjs` files
- Create: `tools/docs/assemble-pages.mjs`
- Modify: `tools/docs/project.json`
- Modify: `scripts/project.json`
- Modify: `scripts/documentation-site.spec.mjs`

**Interfaces:**

- Produces `docs-site:check` and `docs-site:assemble`.
- Validates source links/anchors before build and artifact paths after build.
- Assembles only `index.html`, `404.html`, `users/`, and `developers/` into `dist/docs-site`.

- [ ] **Step 1: Write failing validation tests**

Fixtures must prove rejection of a missing page, missing explicit heading ID, duplicate route, user-to-internal link, user-to-developer content import, invalid base, symlink, source map, secret-shaped filename, and unexpected top-level artifact.

```js
expect(() => validateArtifact(unsafeRoot)).toThrow(/symbolic link/);
expect(() => validateContent(publicRoot)).toThrow(/internal documentation/);
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm nx test docs-site -- validation`

Expected: FAIL because validators are missing.

- [ ] **Step 3: Implement source validation**

Parse Markdown links without network access, resolve source paths, validate explicit heading IDs, reject duplicate route IDs, and prohibit links/imports into `.agents/`, `.claude/`, `AGENTS.md`, `docs-internal/`, `dist/`, and `docs/superpowers/`.

- [ ] **Step 4: Implement deterministic source-reference generation**

Read `package.json`, `electron/package.json`, `pnpm-lock.yaml`, Nx JSON output, and `tsconfig.base.json`. Emit stable JSON for stack versions, scripts, projects, targets, tags, aliases, and the build commit. Sort every map before serialization.

- [ ] **Step 5: Implement clean assembly**

Create a fresh controlled output under `dist/docs-site`, copy the portal and both built sites, and refuse symlinks, source maps, unexpected roots, and files outside the source directories. Never follow links during copying.

- [ ] **Step 6: Wire the Nx targets and inputs**

`docs-site:check` depends on both application checks and runs validators. `docs-site:assemble` depends on both builds, declares all three output trees as inputs, and outputs only `dist/docs-site`.

- [ ] **Step 7: Prove the validators and assembled artifact**

Run:

```bash
pnpm nx test docs-site
pnpm nx run docs-site:check
pnpm nx run docs-site:assemble
```

Expected: PASS, with a complete safe artifact under `dist/docs-site`.

- [ ] **Step 8: Review checkpoint**

Mutation-check one source link and one symlink fixture to prove the guards fail. Commit with `test(docs): validate public documentation artifacts`.

### Task 5: Rewrite developer onboarding and architecture

**Files:**

- Create all `apps/docs-developers/src/content/docs/start/*.md` pages from the specification.
- Create all `apps/docs-developers/src/content/docs/architecture/*.md` pages from the specification.
- Modify: `apps/docs-developers/astro.config.mjs`
- Test: `tools/docs/validation/content-coverage.spec.mjs`

**Interfaces:**

- Produces onboarding routes for prerequisites, install, running, repository orientation, and a first change.
- Produces current architecture routes for ownership, state, Matrix, encryption, navigation, hosts, and UI.

- [ ] **Step 1: Add failing route-coverage assertions**

Declare the exact route list from the design and assert every page exists with `audience: developer`, `contentChannel: develop`, a unique canonical-topic ID, and an explicit top-level heading ID.

- [ ] **Step 2: Run coverage and verify it fails**

Run: `pnpm nx test docs-site -- content-coverage`

Expected: FAIL listing the missing onboarding and architecture routes.

- [ ] **Step 3: Write the five onboarding pages**

Use current Node/pnpm prerequisites, the repository wrapper commands, actual application URLs, Nx project discovery, and one small documentation-only first-change journey. Separate commands from evidence claims.

- [ ] **Step 4: Write the nine architecture pages**

Derive current facts from `architecture/contract.json`, the live Nx graph, public entrypoints, runtime source, host projects, and Matrix boundaries. Keep historical rationale out of current-state prose; link source owners rather than old docs.

- [ ] **Step 5: Configure the developer sidebar**

Order `Start` before `Architecture`; use curated labels and do not rely on alphabetical auto-navigation for these journeys.

- [ ] **Step 6: Validate content and build**

Run:

```bash
pnpm nx test docs-site -- content-coverage
pnpm nx run docs-developers:check
pnpm nx run docs-developers:build
```

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Trace at least one architecture statement per page to current source/configuration. Commit with `docs(developers): rewrite onboarding and architecture`.

### Task 6: Rewrite developer implementation and testing guides

**Files:**

- Create all `apps/docs-developers/src/content/docs/development/*.md` pages from the specification.
- Create all `apps/docs-developers/src/content/docs/testing/*.md` pages from the specification.
- Modify: `apps/docs-developers/astro.config.mjs`
- Modify: `tools/docs/validation/content-coverage.spec.mjs`

**Interfaces:**

- Produces eight implementation guides and six testing guides.
- Preserves Trinity's Angular, signal/RxJS, Matrix SDK, UI-tier, browser, Synapse, and native-host constraints.

- [ ] **Step 1: Extend the failing route-coverage test**

Add the exact development and testing routes and required topic identifiers. Require runnable command blocks on procedural testing pages.

- [ ] **Step 2: Run coverage and verify it fails**

Run: `pnpm nx test docs-site -- content-coverage`

Expected: FAIL listing the fourteen missing pages.

- [ ] **Step 3: Write the development guides**

Use current source conventions and inspected examples. Explain component ownership, read-only signals, cold finite Observables, Signal Forms, data-access SDK containment, public UI boundaries, responsive styling, Matrix events, and host operation adapters.

- [ ] **Step 4: Write the testing guides**

Explain which checks observe which claims; distinguish Vitest, typecheck, lint, browser, Synapse-backed E2E, Electron, Android, and iOS. Include failure-artifact handling and fixed-port sequencing.

- [ ] **Step 5: Configure the sidebar and cross-links**

Link concepts to procedures once; do not repeat the command catalog or architecture descriptions.

- [ ] **Step 6: Validate content and build**

Run the coverage suite, `docs-developers:check`, `docs-developers:build`, and the repository command/source guards affected by copied commands.

- [ ] **Step 7: Review checkpoint**

Verify every code example follows current Angular and repository conventions. Commit with `docs(developers): rewrite development and testing guides`.

### Task 7: Rewrite platform, contribution, and reference guides

**Files:**

- Create all `apps/docs-developers/src/content/docs/platforms/*.md` pages.
- Create all `apps/docs-developers/src/content/docs/contributing/*.md` pages.
- Create all `apps/docs-developers/src/content/docs/reference/*.md` pages.
- Modify: `apps/docs-developers/astro.config.mjs`
- Modify: source-reference generation and coverage tests.

**Interfaces:**

- Produces four platform guides, six contribution guides, and seven reference pages.
- Stack, command, project/library, alias, and build-commit facts are generated or checked against source.

- [ ] **Step 1: Extend coverage and source-reference tests**

Require all seventeen routes. Assert that generated reference data matches current manifests, Nx JSON, and TypeScript aliases and remains stable across two runs.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `pnpm nx test docs-site -- content-coverage source-reference`

Expected: FAIL listing missing routes/fragments.

- [ ] **Step 3: Write platform guides**

Document Web/PWA, Electron, Android, and iOS development from current project targets and host prerequisites. State static-check versus launched-host limits explicitly.

- [ ] **Step 4: Write contribution guides**

Cover ownership selection, coding rules, develop-based branch flow, Conventional Commits, validation selection, pull-request preparation, and this new documentation model. Keep publication credentials and release execution internal.

- [ ] **Step 5: Write reference pages**

Render or verify stack versions, commands, Nx project/library catalog, import aliases, public configuration, value-safe diagnostics, and security invariants. Explanatory introductions remain hand-authored.

- [ ] **Step 6: Complete sidebar and landing navigation**

Every developer route must be reachable from the sidebar or a landing-page task path. Avoid more than three levels beneath `/developers/`.

- [ ] **Step 7: Validate and build the complete developer site**

Run all docs-site unit tests, source checks, `docs-developers:check`, and `docs-developers:build`.

- [ ] **Step 8: Review checkpoint**

Have a new-contributor walkthrough reach clone, run, ownership, implementation rules, testing, and PR preparation without old documentation. Commit with `docs(developers): complete public contributor guides`.

### Task 8: Classify and replace the old documentation

**Files:**

- Create temporarily: `dist/documentation-rewrite-inventory.md`
- Create: `docs-internal/README.md`
- Move current durable ADRs to `docs-internal/decisions/`.
- Move current maintainer-only procedures to `docs-internal/maintenance/` after removing stale material.
- Modify: `AGENTS.md`, `.agents/README.md`, `.agents/skill-overrides.md`, `.claude/README.md`, `README.md`, `CHANGELOG.md`, and affected script inputs.
- Delete superseded first-party public Markdown under the old `docs/` tree only after disposition is complete.
- Preserve the active design and implementation plan until final handoff.
- Test: `scripts/documentation-site.spec.mjs`

**Interfaces:**

- Produces a new repository entry path that sends users/developers to GitHub Pages and private work to `docs-internal/` or required tool paths.
- Eliminates old public routing, completed plans, dated validation reports, stale inventories, and references to removed agent tools.

- [ ] **Step 1: Generate the temporary first-party inventory**

List every tracked Markdown file excluding generated Spartan READMEs, Capacitor-generated documentation, and installer-managed skill contents. Record one exact disposition and destination for each.

- [ ] **Step 2: Add failing stale-path assertions**

Assert public entry points no longer link into old `docs/users`, `docs/contributing`, `docs/architecture`, `docs/platforms`, or `docs/reference` paths and that no public build input includes `docs-internal` or instruction roots.

- [ ] **Step 3: Preserve necessary private records**

Move ADRs without rewriting their historical decisions. Rewrite maintainer procedures around current behavior and remove agent-role, Wayfinder, deleted-skill, obsolete-branch, completed-plan, and dated-validation material.

- [ ] **Step 4: Update repository entry points and script inputs**

README links to both public sites and local developer source. AGENTS points to new developer source or private rules. Source-shape guards that load moved documents use their new canonical paths. Add a changelog entry under Unreleased Changed/Removed.

- [ ] **Step 5: Delete superseded documentation**

Delete old public files only after every inventory row has a verified destination or removal rationale. Do not delete generated/vendor/imported documentation through this task.

- [ ] **Step 6: Remove the temporary inventory**

After coverage and link checks pass, delete `dist/documentation-rewrite-inventory.md`; confirm it was never tracked.

- [ ] **Step 7: Validate the replacement**

Run docs validation, both site checks/builds, scripts tests, formatting, and `git diff --check`. Search the complete tracked tree for deleted paths and stale role/skill references.

- [ ] **Step 8: Review checkpoint**

Inspect the full deletion list and retained private material. Commit with `docs: replace legacy documentation structure`.

### Task 9: Add assembled-site browser and accessibility proof

**Files:**

- Create: `e2e/docs/project.json`
- Create: `e2e/docs/playwright.config.ts`
- Create: `e2e/docs/documentation.spec.ts`
- Create: `tools/docs/serve-static.mjs`
- Modify: `tools/docs/project.json`
- Modify: `nx.json` only if project discovery requires an explicit plugin input.

**Interfaces:**

- Produces Nx target `docs-site:e2e` against the assembled static artifact.
- Uses one local static server owned by Playwright configuration and leaves no process behind.

- [ ] **Step 1: Write failing browser journeys**

Cover root audience selection, user WIP content, developer onboarding navigation, independent searches, base-prefixed cross-site links, 404 recovery, keyboard navigation, landmarks, focus visibility, and Axe checks for shared layouts.

- [ ] **Step 2: Run the focused journey and verify it fails**

Run: `pnpm nx run docs-site:e2e`

Expected: FAIL because the static server/configuration is absent.

- [ ] **Step 3: Implement a bounded static server**

Serve only a validated explicit root, map directory requests to `index.html`, use the assembled 404 page for misses, bind loopback, and close on termination. Reject path traversal after URL decoding.

- [ ] **Step 4: Configure Playwright ownership**

The configuration runs `docs-site:assemble` before serving, launches one web server, uses the repository Pages base URL, disables retries locally, and stores diagnostics beneath ignored `dist/.playwright/`.

- [ ] **Step 5: Make the journeys pass**

Use role and label locators. Search assertions must prove a user query cannot return a developer route and a developer query cannot return user content.

- [ ] **Step 6: Run browser and accessibility proof**

Run `pnpm nx run docs-site:e2e` and inspect retained diagnostics on any initial failure. Expected final result: PASS with zero retries.

- [ ] **Step 7: Review checkpoint**

Review server traversal handling and assertions against the final assembled artifact. Commit with `test(docs): cover the assembled documentation site`.

### Task 10: Publish through protected GitHub Pages workflow

**Files:**

- Create: `.github/workflows/docs-pages.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/ci-classify.mjs`
- Modify: `scripts/ci-classify.spec.mjs`
- Modify: `scripts/ci-required-result.spec.mjs`
- Modify: `docs-internal/maintenance/ci-and-releases.md`

**Interfaces:**

- Pull requests validate and upload no Pages deployment.
- Pushes to `develop` build, validate, upload one Pages artifact, and deploy through environment `github-pages`.
- The deploy job alone receives `pages: write` and `id-token: write`.

- [ ] **Step 1: Write failing workflow contract tests**

Assert push/manual triggers, protected deployment conditions, exact build/check/e2e targets, one artifact path `dist/docs-site`, separated build/deploy jobs, `needs`, least-privilege permissions, and absence of deployment on pull requests.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm nx test scripts -- ci-classify ci-required-result documentation-site`

Expected: FAIL because the Pages workflow is absent.

- [ ] **Step 3: Add pull-request documentation validation**

Ensure site source and tooling changes run the Starlight checks, assembly validation, browser proof, formatting, and scripts guards. Do not classify public-site code as lightweight Markdown-only changes.

- [ ] **Step 4: Add GitHub Pages build and deploy jobs**

Use immutable action pins inspected from official repositories. Build with the repository setup action and pnpm/Nx targets. Upload only `dist/docs-site`. Deploy with the official Pages action from a separate job using the protected environment.

- [ ] **Step 5: Document repository settings**

Record that Settings → Pages must use GitHub Actions and that the `github-pages` environment should allow only `develop`. Do not include credentials or mutate repository settings without separate authorization.

- [ ] **Step 6: Validate workflow and CI contracts**

Run focused scripts tests, the complete scripts target, both docs checks/builds, assembly, and docs E2E.

- [ ] **Step 7: Review checkpoint**

Verify permissions and that PR events cannot reach deployment. Commit with `ci(docs): publish Starlight sites to GitHub Pages`.

### Task 11: Complete repository-wide verification

**Files:**

- Modify only files required by failures attributable to this documentation rewrite.

**Interfaces:**

- Produces one reviewable task branch with validation evidence for every logical commit.

- [ ] **Step 1: Run formatting and diff integrity**

Run:

```bash
pnpm format:check
git diff --check
```

Expected: PASS.

- [ ] **Step 2: Run documentation project checks**

Run:

```bash
pnpm nx run docs-users:check
pnpm nx run docs-developers:check
pnpm nx test docs-site
pnpm nx run docs-site:check
```

Expected: PASS.

- [ ] **Step 3: Build and inspect the Pages artifact**

Run:

```bash
pnpm nx run docs-site:assemble
pnpm nx run docs-site:e2e
```

Expected: PASS; inspect `dist/docs-site` for exactly the portal, user, and developer roots.

- [ ] **Step 4: Run repository source contracts**

Run:

```bash
pnpm nx test scripts
pnpm architecture:check
```

Expected: PASS. Architecture checks are required because documentation source inputs and project registrations change.

- [ ] **Step 5: Verify deletion and channel boundaries**

Search tracked files for removed paths, deleted roles/skills, public-to-private links, `develop` behavior claims in user content, and release-only claims in developer metadata. Expected: no unexplained matches.

- [ ] **Step 6: Inspect final status and evidence**

List staged, unstaged, and untracked task-owned files. Record every command, exit status, revision, and unavailable external deployment check. GitHub Pages publication cannot be claimed until an authorized pushed revision completes the remote workflow.

- [ ] **Step 7: Obtain final review**

Review the complete branch against the design specification, fix material findings, and rerun affected checks. Commit any review fix as its own logical change, push the branch, and open a pull request targeting `develop`. Leave merging and enabling the GitHub Pages repository setting to the user.
