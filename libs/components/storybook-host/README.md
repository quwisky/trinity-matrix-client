# components-storybook-host

Config only — this project owns no source. It exists so that **one** Storybook covers the whole
`libs/components/*` tier instead of twenty-one separate ones: the `@nx/storybook/plugin` infers
its targets from the presence of `.storybook/`, and `.storybook/main.ts` globs the stories out of
the sibling libraries, where they live beside the components they document.

```
pnpm exec nx storybook components-storybook-host        # serve
pnpm exec nx build-storybook components-storybook-host  # static build
```

The static build lands in `dist/storybook/components-storybook-host`, not in the Storybook
default of `storybook-static` beside this file — an artifact inside `libs/` breaks three
workspace globs at once. `project.json` explains which.

Why it is here rather than generated as a normal library: a host needs a `project.json`, a
`tsconfig` and the `.storybook` folder. `@nx/angular:library` would additionally scaffold a
component, a template, a stylesheet, an `index.ts` and a **deprecated** `@nx/eslint:lint`
executor target that the rest of the workspace has already moved off (siblings infer lint), all
of which would have to be deleted again.
