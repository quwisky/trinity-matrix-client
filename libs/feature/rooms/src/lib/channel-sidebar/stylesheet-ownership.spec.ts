import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Angular's emulated encapsulation attributes every rule to its own component's elements,
 * so a selector only ever matches markup in the SAME component's template. Splitting a
 * component in two therefore has to split its stylesheet along the same line — and getting
 * that wrong is silent: the build passes, stylelint passes (the selector is well-formed),
 * and the unit tests pass (they query classes, not computed styles).
 *
 * Extracting `SidebarRoomListComponent` out of `ChannelSidebarComponent` got it wrong four
 * times in one commit. The worst was `@media (hover: none) { .channel__menu { opacity: 1 } }`
 * left behind in the parent, which is the only thing that makes a room's ⋮ visible on a
 * phone — every room row shipped with an invisible menu button.
 *
 * This pins the invariant for the pair: a class one template renders must not be styled
 * ONLY in the other's stylesheet. Both may style it (they are separate scopes, so a shared
 * class genuinely needs a copy in each); neither may rely on the other's copy.
 */

const DIR = join(__dirname);
const PARENT = 'channel-sidebar.component';
const ROW = join(
  'sidebar-room-list',
  'sidebar-room-row',
  'sidebar-room-row.component',
);
const LIST = join('sidebar-room-list', 'sidebar-room-list.component');
const HEADER = join('sidebar-space-header', 'sidebar-space-header.component');
const KIDS = join('space-children-list', 'space-children-list.component');
const PAIRS = [
  [PARENT, HEADER],
  [PARENT, KIDS],
  [PARENT, LIST],
  [PARENT, ROW],
  [LIST, ROW],
] as const;

/**
 * Utility classes come from Tailwind's global sheet, which is not component-scoped and so
 * is exempt from the rule above. Matched by shape rather than listed, so adding a utility
 * to a template does not mean editing this spec.
 */
const UTILITY =
  /^(?:[a-z]+:)?(?:h|w|p|px|py|pr|pl|pt|pb|m|mx|my|gap|text|font|flex|grid|items|justify|self|min|max|rounded|border|bg|shadow|overflow|truncate|space)(?:-|$)/;

function read(base: string, ext: string): string {
  return readFileSync(join(DIR, `${base}.${ext}`), 'utf8');
}

/** Every class literal a template puts in a `class="…"` attribute. */
function renderedClasses(html: string): Set<string> {
  const found = new Set<string>();
  for (const match of html.matchAll(/class="([^"{}]+)"/g)) {
    for (const name of match[1].split(/\s+/)) {
      if (name && !UTILITY.test(name)) {
        found.add(name);
      }
    }
  }
  return found;
}

/**
 * Every class a stylesheet writes a rule for, including nested `&--modifier` / `&.state`
 * forms, which is how the BEM modifiers here are written.
 */
function styledClasses(scss: string): Set<string> {
  const found = new Set<string>();
  for (const match of scss.matchAll(/^\s*\.([a-zA-Z0-9_-]+)/gm)) {
    found.add(match[1]);
  }
  // `&--muted` under `.channel__badge` would style `.channel__badge--muted`.
  let current: string | null = null;
  for (const line of scss.split('\n')) {
    const top = /^\.([a-zA-Z0-9_-]+)/.exec(line);
    if (top) {
      current = top[1];
      continue;
    }
    const nested = /^\s*&(--|\.)?([a-zA-Z0-9_-]+)/.exec(line);
    if (nested && current) {
      found.add(nested[1] === '--' ? `${current}--${nested[2]}` : nested[2]);
    }
  }
  return found;
}

describe.each(PAIRS)('stylesheet ownership of %s and %s', (a, b) => {
  const aHtml = renderedClasses(read(a, 'html'));
  const bHtml = renderedClasses(read(b, 'html'));
  const aScss = styledClasses(read(a, 'scss'));
  const bScss = styledClasses(read(b, 'scss'));

  it.each([
    ['first', a, aHtml, aScss, b, bScss],
    ['second', b, bHtml, bScss, a, aScss],
  ] as const)(
    'does not leave the %s depending on the other’s stylesheet',
    (_label, own, html, ownScss, other, otherScss) => {
      const orphaned = [...html].filter(
        (name) => otherScss.has(name) && !ownScss.has(name),
      );
      expect(
        orphaned,
        `${own}.html renders ${orphaned.join(', ')}, styled only in ${other}.scss — ` +
          `emulated encapsulation means those rules cannot match. Copy them into ` +
          `${own}.scss.`,
      ).toEqual([]);
    },
  );
});

describe('channel sidebar touch affordances', () => {
  it('keeps the touch affordances with the markup they target', () => {
    // The specific rules the extraction stranded. The menu reveal remains a local media
    // query; the target floor now comes from a shared responsive token, but it still has
    // to be consumed by the child rules because parent styles cannot cross encapsulation.
    const childScssText = read(ROW, 'scss');
    expect(childScssText).toMatch(
      /@media \(hover: none\)[\s\S]*?\.channel__menu/,
    );
    expect(childScssText).toMatch(
      /\.channel__menu\s*\{[\s\S]*?var\(--trinity-interaction-target-min-size\)/,
    );
    expect(read(LIST, 'scss')).toMatch(
      /\.invite__btn\s*\{[\s\S]*?var\(--trinity-interaction-target-min-size\)/,
    );
  });
});
