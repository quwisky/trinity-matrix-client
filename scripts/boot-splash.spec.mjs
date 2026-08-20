import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The first paint is not a blank page, and it stays cheap.
 *
 * `index.html` carries a splash so something is on screen before Angular has run. Three
 * properties make that work, and each of them is quiet when broken:
 *
 * 1. It must sit INSIDE `<trn-root>`. Angular clears the host element's children when the
 *    root component renders, which is what removes the splash. Moved outside, it would
 *    never be removed and would sit on top of the app forever.
 * 2. It must need no script. The CSP allows `'unsafe-inline'` for style but NOT for script,
 *    so a splash torn down by an inline script would silently never appear.
 * 3. Its colours are copied from the theme tokens rather than imported, because waiting for
 *    a stylesheet defeats the point of painting early — so they can drift.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const html = readFileSync(
  join(workspaceRoot, 'apps/trinity/src/index.html'),
  'utf8',
);
const tokens = readFileSync(
  join(workspaceRoot, 'apps/trinity/src/theme/variables.scss'),
  'utf8',
);

/**
 * The document with its comments removed.
 *
 * The splash's own comment explains the mechanism and therefore contains the literal text
 * `<trn-root>`. `indexOf` matched THAT, so the slice below started in the middle of a
 * comment and the "inside the root element" assertion was reading a region that had nothing
 * to do with the real tag — it passed with the splash moved outside. Found by mutating the
 * file and noticing the test did not care.
 */
const markup = html.replace(/<!--[\s\S]*?-->/g, '');

/** The markup between `<trn-root>` and its closing tag. */
const insideRoot = markup.slice(
  markup.indexOf('<trn-root>') + '<trn-root>'.length,
  markup.indexOf('</trn-root>'),
);

describe('boot splash', () => {
  it('exists at all', () => {
    // Without this every assertion below could pass by finding nothing.
    expect(markup).toContain('class="trn-boot"');
    expect(markup).toContain('</trn-root>');
  });

  it('lives inside the root element, so Angular removes it', () => {
    expect(insideRoot).toContain('class="trn-boot"');
  });

  it('needs no script to appear or to go away', () => {
    // The CSP has no 'unsafe-inline' for script-src. An inline <script> here would be
    // blocked, and a splash that depended on one would never be torn down.
    expect(/<script(?![^>]*\bsrc=)/.test(markup)).toBe(false);
  });

  it('announces itself rather than being a silent blank', () => {
    expect(insideRoot).toContain('role="status"');
  });

  it('opts IN to motion instead of relying on the app stylesheet to opt out', () => {
    // `global.scss`'s reduced-motion reset belongs to a stylesheet that has not necessarily
    // arrived yet, so the splash cannot lean on it: it animates only under an explicit
    // `no-preference`.
    expect(html).toContain('@media (prefers-reduced-motion: no-preference)');
  });

  it('paints the same colours the app is about to', () => {
    // The one duplication this splash cannot avoid. If the light or dark background is
    // retuned in variables.scss and not here, the app visibly changes colour one frame
    // after it starts — which looks like a flash of the wrong theme.
    // Anchored at a line start, because the file's header comment discusses `:root.dark`
    // several times and `indexOf` happily matched the prose — which then read the LIGHT
    // block's values and reported a mismatch that was not there.
    const blockOf = (selector) => {
      const start = new RegExp(`^${selector} \\{$`, 'm').exec(tokens)?.index;
      if (start === undefined) {
        return null;
      }
      return tokens.slice(start, tokens.indexOf('\n}', start));
    };

    /** The LAST declaration wins, as it would in the browser. */
    const declaration = (block, name) => {
      const all = [...block.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))];
      return all.at(-1)?.[1].trim();
    };

    const lightBlock = blockOf(':root');
    const darkBlock = blockOf(':root\\.dark');
    expect(lightBlock).not.toBeNull();
    expect(darkBlock).not.toBeNull();

    const resolve = (block, name) => {
      const value = declaration(block, name);
      const indirect = /^var\((--[\w-]+)\)$/.exec(value ?? '');
      return indirect ? declaration(block, indirect[1]) : value;
    };

    const light = resolve(lightBlock, '--background');
    const dark = resolve(darkBlock, '--background');
    expect(light).toBeDefined();
    expect(dark).toBeDefined();

    expect(html).toContain(`background: ${light}`);
    expect(html).toContain(`background: ${dark}`);
  });
});
