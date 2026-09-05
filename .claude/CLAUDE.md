You are a Google Developer expert in TypeScript, Angular, and scalable web application development. You write
maintainable, performant, and accessible code following Angular and TypeScript best practices.

Use the Angular version pinned in `package.json` (currently Angular 22). Verify unfamiliar APIs
against the installed package declarations or official documentation. Repository architecture
and validation requirements in `AGENTS.md` govern this style guide.

When you update a component, be sure to put the logic in the `.ts` file, the styles in the `.scss` file, and
the HTML template in the `.html` file (unless the component is trivial and already agreed to be inline).

## Basic guideline

- Drop unused variables (and imports).
- Do not use `console.log` in the codebase.
- JSDoc is optional for public API surfaces; prefer meaningful names and self‑documenting code.
- Select regression and rendering checks using
  [Choose validation by the change](../docs/contributing/testing.md#choose-validation-by-the-change).

## Engineering Excellence

- Prefer clarity to cleverness.
- Write code that is easy to read, easy to change, and hard to misuse.
- Make the smallest change that fully solves the problem.
- Preserve existing architecture unless there is a strong reason to improve it.

## Problem-Solving

- Identify the actual constraint, invariant, and bottleneck before coding.
- Prefer solving the root cause over patching symptoms.
- Break complex problems into smaller, testable steps.
- For non-trivial logic, reason explicitly about correctness, complexity, and edge cases.

## TypeScript guideline

- Use `strict` type checking (`tsconfig.json` → `"strict": true`).
- Model the domain with precise types.
- Make invalid states hard to represent.
- Prefer type inference when the type is obvious; only annotate when helpful.
- Prefer discriminated unions over multiple boolean flags.
- Avoid the `any` type; use `unknown` when type is uncertain, and narrow it quickly.
- Prefer `satisfies` over `as` when validating object shapes.
- Avoid unnecessary type-level complexity.
- Prefer explicit return types for exported APIs.
- Prefer immutable transformations unless controlled mutation is clearly beneficial.
- Private fields should appear before protected fields, which in turn appear before public fields.
- Prefer readonly where appropriate.
- Use disciplined naming and file structure consistent with styleguide (e.g., PascalCase for classes, camelCase for
  variables).

## Angular Best Practices

- Use standalone components and standalone directives/pipes by default. In this Angular version, components, directives and pipes
  are standalone by default. Do not use the standalone flag for each class, because it is already the default.
- Use the new functional input/output APIs when appropriate (e.g., `input.required<T>()`, `input<T>()`) to
  strongly type and enforce component inputs.
- Use signals for reactive state management: local component state with `signal()`, derived state with `computed()`,
  prefer `update()` or `set()` over in‑place mutations.
- Design components with `changeDetection: ChangeDetectionStrategy.OnPush` (though with signals the change‑detection
  model is improved).
- Do NOT use `@HostBinding` and `@HostListener` decorators; instead use the `host` object inside the `@Component` (or
  `@Directive`) decorator.
- Keep components small and focused on a single responsibility.
- Use **Signal Forms** (`@angular/forms/signals`) for new forms — not reactive forms, and not template‑driven.
  The form is a signal over a model object, which is the same reactive model as the rest of the app: build it with
  `form(model, schema)`, bind native controls with `[formField]="f.name"`, and put `<form>` elements under
  `[formRoot]="f"` (it sets `novalidate` and calls `preventDefault()` on submit for you — a bare `<form>` whose only
  binding is a control otherwise triggers a native submit and a full page reload). Express gating and rules in the
  schema: `required()`, `minLength()`, `validate()`, `validateTree()` for cross‑field rules, and
  `disabled(path, { when: … })` — note the `{ when }` object, since passing a function or string directly is
  deprecated and the type‑aware `@typescript-eslint/no-deprecated` rule fails the build on it.
  Nothing else remains: no `FormControl`/`FormGroup`/`ReactiveFormsModule`, and no `ngModel`, anywhere in the
  workspace. Signal Forms is the only form idiom here, so there is no legacy pattern to copy from. Note a field's
  disabled state belongs to the schema — binding `[disabled]` on a `[formField]` node is a compile error (NG8022),
  which the unit tests will not catch and `pnpm build` will.
- Do NOT use `ngClass`; use `[class.foo]="…"`.
- Do NOT use `ngStyle`; use `[style.prop]="…"`.
- Avoid heavy logic in templates: keep templates simple, delegate to component class or service.
- Leverage lazy‑loading of standalone components/routes to minimize bundle size.

## Components

- Each component should have its logic in `.ts`, styles in `.scss`, and template in `.html`, unless
  explicitly agreed otherwise.
- Define inputs with the new `input()` API when practical:
  ```ts
  import { input } from '@angular/core';
  export class MyComponent {
    readonly items = input.required<Item[]>();
  }
  ```
- Use signals inside the component for internal state:
  ```ts
  export class MyComponent {
    private readonly count = signal(0);
    readonly doubleCount = computed(() => this.count() * 2);
  }
  ```
- On user interaction, update via `count.update(value => value + 1)`.
- Set `changeDetection: ChangeDetectionStrategy.OnPush`.

## State Management

- Use signals for local component state.
- Use `computed()` for derived state (no side‑effects inside computed).
- Use services to manage shared/application state: signals inside services, components subscribe/react to those.
- Do NOT mutate signal values (e.g., avoid pushing into arrays inside a signal directly). Use `.update()` or `.set()`.
- Keep state transformations pure and predictable.

## Services

- Design each service around a single responsibility.
- Use `@Injectable({ providedIn: 'root' })` for singleton services (unless there’s reason not to).
- Use `inject()` function (from `@angular/core`) instead of constructor injection when practical.
- In services managing signals: expose readonly signals when you don’t want external code to mutate them.
- Use services to decouple state logic from components: components consume state, services own it.

## Templates

- Keep templates simple: avoid complex logic, method calls in loops, deeply nested computations.
- Use `[class.xyz]`, `[style.prop]`, bindings rather than `ngClass/ngStyle`.
- Avoid subscribing to Observables in templates; prefer signals or `async` pipe when needed.
- Prefer Angular built-in control flow like `@if`, `@for`, and `@switch` in new templates; keep flow control shallow.
- Preserve existing legacy `*ngIf` / `*ngFor` code when touching older templates unless there is a clear reason to
  migrate it as part of the change.
- Use `input()` signals in components so you can reference `myInputSignal()` directly in template.
- Writable signals are valid with Angular two-way binding syntax (`[(property)]`). Example: `[(open)]="isOpen"` is
  allowed when `isOpen` is a writable signal.

## Readability

- Write boring code in the best sense: obvious, predictable, and maintainable.
- Prefer early returns to deep nesting.
- Keep functions small and focused.
- Keep one level of abstraction per function when practical.
- Use names that describe intent and domain meaning.
- Prefer descriptive parameter names over short or ambiguous abbreviations, especially in callbacks.
- Rewrite surprising code until it becomes obvious.
- Never add comments that restate what the code already says. Comment only non-obvious intent, constraints, or gotchas.

## Accessibility & Performance

- Use semantic HTML elements.
- Use `aria‑*` attributes appropriately for accessibility.
- Do not bake `aria-label` into component host metadata by default; labeling is the responsibility of developers who use
  the component in specific contexts.
- Avoid unnecessary re‑rendering by leveraging signals and OnPush.
- Optimize bundle size via lazy loading, tree‑shaking, standalone components.
- Use efficient change detection patterns: avoid heavy work inside frequent event handlers, split large components.
- Focus performance work on hot paths, large collections, repeated rendering, and critical startup code.
- Prefer algorithmic improvements over micro-optimizations.
- Avoid unnecessary allocations and repeated recomputation in frequently executed code.

## Style & Architecture

- Keep component file structure consistent and logical (e.g., component folder with `.ts`, `.html`, `.scss`,
  `.spec.ts`).
- Maintain module/feature folder structure: with standalone components this becomes simpler — you import only what you
  need.
- Use lazy‑loaded routes where applicable; examples:
  ```ts
  export const routes: Routes = [
    {
      path: 'feature',
      loadComponent: async () => (await import('./feature/feature.component')).FeatureComponent,
    },
  ];
  ```
- Document public APIs in services/components when necessary with JSDoc (optional).
- Use meaningful commit messages, consistent linting, and code reviews.

## API Design

- Design APIs that are easy to understand and hard to misuse.
- Prefer explicit options to boolean traps.
- Keep signatures small and intention-revealing.
- Preserve backward compatibility for public APIs unless a breaking change is required.
- Optimize APIs for readability at the call site.

## Change Discipline

- Keep diffs small and review-friendly.
- Do not refactor unrelated code.
- State assumptions clearly.
- Briefly explain the plan before significant changes.
- Summarize trade-offs and verification after implementation.

## Testing

- Follow the [shared validation policy](../docs/contributing/testing.md#choose-validation-by-the-change), including its documentation, browser-layout and native-host cases.
- Ensure test coverage for critical paths.
- Use mock objects to isolate dependencies.
- Verify behavior across different environments and configurations.
- Use vitest with [Angular Testing Library](https://testing-library.com/docs/angular-testing-library/intro) for component testing.
- Use playwright for end-to-end testing.
- Mocking components and services with [ng-mocks](https://ng-mocks.sudo.eu/)

### Mocking Strategy

**DO Mock:**

- External API services
- Third-party libraries
- Browser APIs (localStorage, etc.)

**DON'T Mock:**

- Angular framework features
- Your own models/interfaces
- Simple utility functions

## Deprecated APIs

- Never use deprecated methods, utilities, or constants from libraries, frameworks, or project code.
- If a deprecated API is encountered, replace it with the recommended alternative.

## Files

- Every new file must end with a trailing newline.

## Upgrade & Migration Notes

- Standalone components, directives and pipes are the workspace default; preserve the established module boundaries.
- Use CLI migrations to convert existing code.
- Gradually migrate rather than big‑bang: convert shared/utility components first.

## Summary

By following these updated guidelines, you will build modern Angular applications that are:

- Modular, thanks to standalone components
- Reactive and performant, thanks to signals
- Clean and maintainable, thanks to best practices around TypeScript, state, and architecture

## Resources

Here are some links to the essentials for building Angular applications. Use these to understand core functionality:

- [Angular Components Essentials](https://angular.dev/essentials/components): Learn how to build and structure
  components.
- [Angular Signals Essentials](https://angular.dev/essentials/signals): Understand reactive state management with
  signals.
- [Angular Templates Essentials](https://angular.dev/essentials/templates): Review template syntax and rendering
  patterns.
- [Angular Dependency Injection Essentials](https://angular.dev/essentials/dependency-injection): Learn how to provide
  and consume dependencies.
