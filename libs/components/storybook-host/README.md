# components-storybook-host

Config only — this project owns no source. It exists so that **one** Storybook covers the five
public design-system categories plus the retained capability presentation stories. The
`@nx/storybook/plugin` infers its targets from the presence of `.storybook/`, and
`.storybook/main.ts` globs each story from beside the component it documents.

```
pnpm nx storybook components-storybook-host        # serve
pnpm nx build-storybook components-storybook-host  # static build
pnpm nx run trinity-e2e-components:storybook       # Theme × Mode canvas check
```

The static build lands in `dist/storybook/components-storybook-host`, not in the Storybook
default of `storybook-static` beside this file — an artifact inside `libs/` breaks three
workspace globs at once. `project.json` explains which.

Why it is here rather than generated as a normal library: a host needs a `project.json`, a
`tsconfig` and the `.storybook` folder. `@nx/angular:library` would additionally scaffold a
component, a template, a stylesheet, an `index.ts` and a **deprecated** `@nx/eslint:lint`
executor target that the rest of the workspace has already moved off (siblings infer lint), all
of which would have to be deleted again.

The browser check has its own Playwright config and static server. It intentionally does not use
the app E2E target, because Storybook needs neither the application build nor its disposable
Synapse stack.
