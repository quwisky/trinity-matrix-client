import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every `--trinity-*` token a stylesheet consumes must be defined somewhere.
 *
 * This exists because the failure mode is SILENT. `var(--nope)` does not fall back and does
 * not warn — it makes the whole declaration invalid, and the browser drops it. What ships is
 * a component missing one property, which reads as a design decision.
 *
 * Two shipped instances, both found by eye rather than by tooling:
 *
 *   • `--trinity-radius-lg` is consumed by the mobile account-picker dialog and defined
 *     nowhere, so it ships square corners.
 *   • The composer's drag-and-drop overlay mixed toward `--trinity-background`, which no
 *     Theme defines, so `color-mix()` was invalid and the sheet rendered with no background
 *     at all — the whole point of the overlay (#159).
 *
 * The production renderer closes the other direction for the GLOBAL vocabulary too: a token declared in the
 * central variables file must have a real consumer somewhere in source. Theme blocks may
 * repeat those declarations, but they do not justify an otherwise dead API. Component-local
 * custom properties remain outside that check because template bindings and vendor contracts
 * can consume them dynamically.
 *
 * Lives in `scripts` for the same reason `confirmation-words.spec.mjs` does: it reads across
 * libs that the Nx module boundaries stop any single project from importing.
 */

const workspaceRoot = join(import.meta.dirname, '..');

/** Stylesheets and templates can both consume a token; both are scanned. */
const consumerGlobs = [
  'libs/**/*.scss',
  'libs/**/*.css',
  'apps/**/*.scss',
  'apps/**/*.css',
  'libs/**/*.html',
  'apps/**/*.html',
  'libs/**/*.ts',
];

/** A token is DEFINED by `--name:` anywhere — a Theme block, a media query, inline. */
const definitionPattern = /(--trinity-[a-zA-Z0-9-]+)\s*:/g;
/** A token is USED by `var(--name)`, optionally with a fallback we deliberately ignore. */
const usagePattern = /var\(\s*(--trinity-[a-zA-Z0-9-]+)/g;

const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');
const variablesFile = 'libs/theme-foundation/styles/internal/variables.scss';
const variables = read(variablesFile);

const files = consumerGlobs
  .flatMap((pattern) => globSync(pattern, { cwd: workspaceRoot }))
  .filter((file) => !file.includes('node_modules'));

const defined = new Set();
/** token -> the files that consume it, so a failure names where to look. */
const used = new Map();

for (const file of files) {
  const source = read(file);
  for (const [, token] of source.matchAll(definitionPattern)) {
    defined.add(token);
  }
  for (const [, token] of source.matchAll(usagePattern)) {
    const sites = used.get(token) ?? new Set();
    sites.add(file);
    used.set(token, sites);
  }
}

describe('trinity design tokens', () => {
  it('finds the tokens at all, so an empty sweep cannot pass as a clean one', () => {
    // Without this, a glob or regex change that matched nothing would report every token
    // resolved — the classic way a source-shape guard stops guarding in silence.
    expect(defined.size).toBeGreaterThan(30);
    expect(used.size).toBeGreaterThan(20);
  });

  it('defines every token that something consumes', () => {
    const unresolved = [...used.entries()]
      .filter(([token]) => !defined.has(token))
      .map(
        ([token, sites]) =>
          `${token} — used in ${[...sites].sort().join(', ')}`,
      )
      .sort();

    expect(unresolved).toEqual([]);
  });

  it('keeps no unused global token compatibility aliases', () => {
    const globalDefinitions = new Set(
      [...variables.matchAll(definitionPattern)].map(([, token]) => token),
    );
    const unused = [...globalDefinitions]
      .filter((token) => !used.has(token))
      .sort();

    expect(unused).toEqual([]);
  });

  it('keeps semantic foundation roles pointing inward to the established primitives', () => {
    const aliases = {
      '--trinity-shape-control-radius': '--trinity-radius-md',
      '--trinity-shape-container-radius': '--trinity-radius',
      '--trinity-shape-overlay-radius': '--trinity-radius-xl',
      '--trinity-surface-frame': '--trinity-rail',
      '--trinity-surface-navigation': '--trinity-sidebar',
      '--trinity-surface-navigation-header': '--trinity-sidebar-header',
      '--trinity-surface-workspace': '--trinity-chat',
      '--trinity-surface-raised': '--trinity-surface',
      '--trinity-surface-floating': '--trinity-sidebar',
      '--trinity-surface-panel': '--trinity-members',
      '--trinity-focus-ring': '--trinity-link',
      '--trinity-focus-ring-on-attention':
        '--trinity-state-attention-foreground',
    };

    const wrong = Object.entries(aliases)
      .filter(([role, primitive]) => {
        const escaped = role.replaceAll('-', '\\-');
        const declaration = new RegExp(
          `${escaped}\\s*:\\s*var\\(\\s*${primitive.replaceAll('-', '\\-')}\\s*\\)\\s*;`,
        );
        return !declaration.test(variables);
      })
      .map(([role, primitive]) => `${role} must alias ${primitive}`);

    expect(wrong).toEqual([]);
  });

  it('keeps shared density roles shared by multiple shipped component stylesheets', () => {
    const sharedDensityRoles = [
      '--trinity-density-item-gap',
      '--trinity-density-row-gap',
      '--trinity-density-row-padding-block',
      '--trinity-density-row-padding-inline',
    ];
    const underused = sharedDensityRoles
      .map((token) => ({
        token,
        sites: [...(used.get(token) ?? [])].filter(
          (file) =>
            file.startsWith('libs/') &&
            (file.endsWith('.component.scss') || file.endsWith('.page.scss')),
        ),
      }))
      .filter(({ sites }) => sites.length < 2)
      .map(({ token, sites }) => `${token} — ${sites.sort().join(', ')}`);

    expect(underused).toEqual([]);
  });
});
