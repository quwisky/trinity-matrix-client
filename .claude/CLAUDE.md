# Angular and TypeScript style

Apply this guide to source changes, together with [repository instructions](../AGENTS.md)
and [contributor conventions](../apps/docs-developers/src/content/docs/contributing/coding-conventions.md). Use the versions
in `package.json`; verify unfamiliar APIs against installed declarations or official docs.

## TypeScript

- Keep strict types. Use `unknown` and narrowing for untrusted values, discriminated
  unions for distinct states, and `satisfies` for object-shape checks where appropriate.
- Infer obvious local types; give exported APIs clear return types. Use `readonly`
  where ownership requires it. Keep fields ordered private, protected, then public.
- Remove unused imports and variables. Keep debug `console.log` calls out of committed
  source. Use meaningful names; JSDoc is optional for public APIs and should explain
  constraints that the signature cannot express.
- Follow the [coding conventions](../apps/docs-developers/src/content/docs/contributing/coding-conventions.md), including their deprecated-API policy.

## Components and templates

- Use standalone components, directives, and pipes; standalone is the default, so omit
  the redundant flag. Components use `ChangeDetectionStrategy.OnPush`.
- Keep logic, template, styles, and tests in their [component files](../apps/docs-developers/src/content/docs/development/angular-components.md).
- Use functional inputs/outputs and `inject()` where appropriate. Express host bindings
  and listeners in decorator `host` metadata instead of `@HostBinding`/`@HostListener`.
- Use built-in `@if`, `@for`, and `@switch` for new templates. Keep existing legacy
  control flow unless migration belongs to the accepted change.
- Use `[class.name]` and `[style.property]` bindings; `ngClass` and `ngStyle` are
  prohibited. Keep template expressions simple. Writable signals can be the
  target of `[(property)]` bindings.
- Use Signal Forms for new forms. Put constraints in their schema and run the renderer
  build for changed form bindings; use the [diagnostics guide](../apps/docs-developers/src/content/docs/reference/diagnostics.md) when unit and build evidence disagree.
- Give controls semantic elements and accessible names in their usage context. Avoid a
  generic host `aria-label` that prevents the caller from expressing the actual action.

## State and services

- Use `signal()` for local state and pure `computed()` for derived state. Update values
  with `set()` or `update()` rather than mutating an array/object in place.
- Keep shared state and workflows in their capability owner. Expose read-only signals
  to consumers; scope providers to their actual lifetime rather than making every
  service a root singleton.
- Follow [state and reactivity](../apps/docs-developers/src/content/docs/architecture/state-and-reactivity.md) for source
  authority, cold finite actions, ongoing runtime lifetimes, and cleanup. Use signals or
  the `async` pipe for observable template state; bound component action subscriptions
  with `takeUntilDestroyed`.

## Validation

Use [Testing](../apps/docs-developers/src/content/docs/testing/testing-strategy.md) to select behavior checks and separate
build/typecheck/browser evidence. Component tests use the repository Angular Testing
Library setup and Vitest; browser journeys use Playwright. Mock external boundaries
needed to isolate the behavior, preserving real Angular behavior and the domain model.
Keep every new file newline-terminated.
