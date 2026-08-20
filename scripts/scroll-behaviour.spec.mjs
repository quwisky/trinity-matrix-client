import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No programmatic scroll may hard-code its behaviour.
 *
 * `global.scss` has the usual `prefers-reduced-motion` reset, including
 * `scroll-behavior: auto !important`. That covers scrolling the user starts — an anchor, a
 * `scroll-behavior: smooth` container — and it CANNOT cover a scroll the app starts itself:
 * `scrollTo({ behavior: 'smooth' })` passes the behaviour as an argument, and an argument
 * beats a stylesheet however many `!important`s it carries.
 *
 * So five timeline scrolls animated for a reader who had asked the operating system for less
 * motion, and nothing in the CSS could have stopped them. They go through `scrollBehavior()`
 * from `@trinity/util/ui` now, and this stops a sixth site being written the old way — which
 * is easy, because `behavior: 'smooth'` does not look wrong when you read it.
 *
 * It lives in `scripts` for the same reason the other sweeps do: the files span libraries
 * that the Nx module boundaries stop any single project from importing.
 */

const workspaceRoot = join(import.meta.dirname, '..');

const sources = globSync(['libs/**/*.ts', 'apps/**/*.ts'], {
  cwd: workspaceRoot,
})
  .filter((file) => !file.includes('node_modules'))
  .filter((file) => !file.endsWith('.spec.ts'))
  .sort();

const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');

/**
 * The file with its comments removed.
 *
 * Prose is not code: this guard's own explanation quotes `behavior: 'smooth'` to say why it
 * must not be written, and the first version of the sweep reported that sentence as a
 * violation. Stripping is deliberately naive — it does not understand a `//` inside a string
 * literal — which is safe here because the worst case is that a little more text is removed
 * before a search for something that must not appear at all.
 */
const code = (file) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('programmatic scrolling', () => {
  it('finds the scroll call sites at all, so an empty sweep cannot pass', () => {
    // Without this the whole file would go green the day someone renamed the APIs, or the
    // glob stopped matching, and nothing would say the guard had stopped guarding.
    const scrollers = sources.filter((file) =>
      /\.(scrollIntoView|scrollTo)\(/.test(read(file)),
    );

    expect(scrollers.length).toBeGreaterThanOrEqual(3);
  });

  it('never hard-codes a scroll behaviour', () => {
    // Matches any literal in the `behavior` option, not just `smooth`: a hard-coded `auto`
    // is the same mistake pointing the other way — it would remove the animation for
    // everyone, including people who never asked for that.
    const offenders = sources
      .map((file) => ({ file, source: code(file) }))
      .filter(({ source }) =>
        /behavior:\s*['"](smooth|auto|instant)['"]/.test(source),
      )
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });
});
