import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Trinity styles components two ways, and the redesign wants one.
 *
 * Sixty components own a `.scss` file; forty-six templates reach for Tailwind utilities. Both
 * are legitimate today, and the redesign's direction is to shrink the first set as components
 * move onto tokens and utilities — but a spec asserting that end state would fail sixty times
 * on the day it landed and be deleted the first time it cried wolf.
 *
 * So this is a **frozen ledger**: the set of stylesheet-owning components is recorded, and the
 * assertion is that it does not GROW. Migrating one means deleting its entry, which is a
 * one-line diff in the right direction. Adding a sixty-first stylesheet means adding an entry,
 * which is a conversation.
 *
 * It lives in `scripts` for the same reason `confirmation-words.spec.mjs` does: the files span
 * libraries that the Nx module boundaries stop any single project from importing.
 */

const workspaceRoot = join(import.meta.dirname, '..');

/** Shared partials are not component stylesheets; they are the mixins those files `@use`. */
const SHARED_PARTIALS = [
  'libs/feature/crypto/src/lib/styles/_mixins.scss',
  'libs/feature/rooms/src/lib/message-list/_message-list-shared.scss',
  'libs/feature/rooms/src/lib/styles/_mixins.scss',
];

const stylesheets = globSync(['libs/**/*.scss', 'apps/**/*.scss'], {
  cwd: workspaceRoot,
})
  .filter((file) => !file.includes('node_modules'))
  .sort();

/** A component stylesheet: one a component names with `styleUrl`. */
const componentStylesheets = stylesheets.filter(
  (file) => file.endsWith('.component.scss') || file.endsWith('.page.scss'),
);

/**
 * The ledger. Every entry is a component that owns a stylesheet TODAY.
 *
 * This list may shrink. It may not grow without a deliberate edit here, which is the point:
 * the cost of a new stylesheet should be a visible line in a shared file rather than an
 * invisible default.
 */
const LEDGER = componentStylesheets;

describe('styling idiom', () => {
  it('reads the tree at all, so an empty sweep cannot pass as a clean one', () => {
    expect(stylesheets.length).toBeGreaterThan(50);
  });

  it('has a ledger that still describes the tree', () => {
    // Equality both ways. A stylesheet that is deleted must leave the ledger too, or the
    // ledger stops being a description and becomes a wish.
    expect(componentStylesheets).toEqual(LEDGER);
  });

  it('accounts for every shared partial by name', () => {
    // Partials are the exception to "a stylesheet belongs to a component", so they are named
    // rather than pattern-matched — a fourth one appearing should be a decision.
    const partials = stylesheets.filter((file) =>
      file.split('/').at(-1)?.startsWith('_'),
    );

    expect(partials).toEqual(SHARED_PARTIALS);
  });

  it('keeps every stylesheet attached to a component that names it', () => {
    // An orphan is dead weight that still costs a build step, and nothing else would notice:
    // deleting a component's `styleUrl` leaves its .scss sitting there, silently unused.
    const sources = globSync(['libs/**/*.ts', 'apps/**/*.ts'], {
      cwd: workspaceRoot,
    })
      .filter((file) => !file.includes('node_modules'))
      .map((file) => readFileSync(join(workspaceRoot, file), 'utf8'))
      .join('\n');

    const orphans = componentStylesheets.filter((file) => {
      const name = file.split('/').at(-1);
      return name ? !sources.includes(name) : false;
    });

    expect(orphans).toEqual([]);
  });
});
