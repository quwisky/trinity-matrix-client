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
const CHILD = join('sidebar-room-list', 'sidebar-room-list.component');

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
  // `&--muted` under `.channel__badge` styles `.channel__badge--muted`.
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

describe('channel sidebar stylesheet ownership', () => {
  const parentHtml = renderedClasses(read(PARENT, 'html'));
  const childHtml = renderedClasses(read(CHILD, 'html'));
  const parentScss = styledClasses(read(PARENT, 'scss'));
  const childScss = styledClasses(read(CHILD, 'scss'));

  it('does not leave the parent depending on the child’s stylesheet', () => {
    const orphaned = [...parentHtml].filter(
      (name) => childScss.has(name) && !parentScss.has(name),
    );
    expect(
      orphaned,
      `channel-sidebar.component.html renders ${orphaned.join(', ')}, styled only in ` +
        `sidebar-room-list.component.scss — emulated encapsulation means those rules ` +
        `cannot match. Copy them into channel-sidebar.component.scss.`,
    ).toEqual([]);
  });

  it('does not leave the child depending on the parent’s stylesheet', () => {
    const orphaned = [...childHtml].filter(
      (name) => parentScss.has(name) && !childScss.has(name),
    );
    expect(
      orphaned,
      `sidebar-room-list.component.html renders ${orphaned.join(', ')}, styled only in ` +
        `channel-sidebar.component.scss — emulated encapsulation means those rules ` +
        `cannot match. Copy them into sidebar-room-list.component.scss.`,
    ).toEqual([]);
  });

  it('keeps the touch affordances with the markup they target', () => {
    // The specific rules the extraction stranded. The menu reveal remains a local media
    // query; the target floor now comes from a shared responsive token, but it still has
    // to be consumed by the child rules because parent styles cannot cross encapsulation.
    const childScssText = read(CHILD, 'scss');
    expect(childScssText).toMatch(
      /@media \(hover: none\)[\s\S]*?\.channel__menu/,
    );
    expect(childScssText).toMatch(
      /\.channel__menu\s*\{[\s\S]*?var\(--trinity-interaction-target-min-size\)/,
    );
    expect(childScssText).toMatch(
      /\.invite__btn\s*\{[\s\S]*?var\(--trinity-interaction-target-min-size\)/,
    );
  });
});
