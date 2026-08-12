import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const kitRoot = join(workspaceRoot, 'libs/kit');

/**
 * Keeps `.prettierignore`'s kit exclusion honest.
 *
 * The generated kit is deliberately unformatted — `@spartan-ng/cli` emits its own class
 * order and prettier-plugin-tailwindcss would fight it on every re-sync. Before #150 the
 * generator's own file prefix was the discriminator: generated code carried it,
 * hand-authored code did not. The rebrand made both `trn-*`, so the hand-authored libs have
 * to be listed by name instead — and that list is now the only thing standing between them
 * and silence.
 *
 * Silence is the operative word: a lib missing from the negations does not fail
 * `pnpm format:check`. There is simply less to check, and it drifts unnoticed. So the list
 * is anchored to something structural rather than to whoever remembers — a generated lib has
 * an `ng-package.json` (it is published by ng-packagr); a Trinity-authored one does not.
 */
describe('kit formatting', () => {
  const libs = readdirSync(kitRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const handAuthored = libs
    .filter((lib) => !existsSync(join(kitRoot, lib, 'ng-package.json')))
    .sort();

  const negated = [
    ...readFileSync(join(workspaceRoot, '.prettierignore'), 'utf8').matchAll(
      /^!libs\/kit\/([\w-]+)\//gm,
    ),
  ]
    .map((match) => match[1])
    .sort();

  it('finds the kit libraries at all, so an empty comparison cannot pass', () => {
    expect(libs.length).toBeGreaterThan(10);
    expect(handAuthored.length).toBeGreaterThan(0);
  });

  it('exempts exactly the hand-authored libraries from the ignore', () => {
    // Add a Trinity-authored kit lib without a matching negation and this fails, instead of
    // that lib quietly leaving the formatting gate.
    expect(negated).toEqual(handAuthored);
  });

  it('still ignores the generated libraries', () => {
    const generated = libs.filter((lib) => !handAuthored.includes(lib));
    expect(generated.length).toBeGreaterThan(0);
    expect(generated.some((lib) => negated.includes(lib))).toBe(false);
  });
});
