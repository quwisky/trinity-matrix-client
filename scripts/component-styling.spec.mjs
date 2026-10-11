import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A component's rules must be able to reach the markup they target.
 *
 * Angular's emulated encapsulation rewrites every rule a component declares to carry that
 * component's content attribute, and stamps the matching attribute onto the elements that
 * component's own template creates. So a rule for `.day-divider` written in component A
 * cannot style a `.day-divider` that component B renders — not "should not", CANNOT. The
 * selector is `.day-divider[_ngcontent-A]` and the element carries `_ngcontent-B`.
 *
 * This has already happened here. Extracting the day and unread dividers into
 * `trn-timeline-divider` moved the markup and left the rules in the two message lists, and
 * both dividers rendered completely unstyled on the app's primary screen. Every test stayed
 * green, because jsdom applies no CSS and every assertion in reach was about `data-testid`
 * and text.
 *
 * That is the blind spot this closes: a whole class of styling bug that is invisible to unit
 * tests by construction and to end-to-end tests by convention. It is cheap to close, because
 * the mistake has a shape — a class styled in one component and used only in another — and
 * that shape is decidable from the source.
 *
 * Validated against the revision that shipped the bug: this reports the four divider classes
 * against both list stylesheets there, and nothing on a tree where they live together.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');
const exists = (file) => existsSync(join(workspaceRoot, file));

/** Comments are prose; a class named in one is not a rule and not a usage. */
const strip = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

/**
 * A component's stylesheet, with the local partials it `@use`s folded in.
 *
 * The partial's rules belong to every component that pulls it in — that is exactly how
 * `_message-list-shared.scss` gave both lists the divider rules, and why the extraction
 * orphaned them in two places at once rather than one.
 */
function sheetText(file, seen = new Set()) {
  if (!exists(file) || seen.has(file)) {
    return '';
  }
  seen.add(file);
  const source = strip(read(file));
  let combined = source;
  for (const [, spec] of source.matchAll(/@use\s+'([^']+)'/g)) {
    if (!spec.startsWith('.')) {
      continue; // a package, not a local partial
    }
    const parent = dirname(join(dirname(file), spec));
    const base = spec.split('/').pop();
    for (const candidate of [`${base}.scss`, `_${base}.scss`]) {
      const path = join(parent, candidate).replace(/\\/g, '/');
      if (exists(path)) {
        combined += `\n${sheetText(path, seen)}`;
      }
    }
  }
  return combined;
}

/** Every class name a template puts on an element, static or bound. */
function classesUsed(html) {
  const names = new Set();
  for (const [, attr] of html.matchAll(/class="([^"]*)"/g)) {
    for (const name of attr.split(/\s+/).filter(Boolean)) {
      names.add(name);
    }
  }
  for (const [, name] of html.matchAll(/\[class\.([\w-]+)\]/g)) {
    names.add(name);
  }
  return names;
}

/** Components that declare a template and/or a stylesheet, with both resolved. */
const components = globSync(['libs/**/*.ts', 'apps/**/*.ts'], {
  cwd: workspaceRoot,
})
  .filter(
    (file) => !file.includes('node_modules') && !file.endsWith('.spec.ts'),
  )
  .map((file) => {
    const source = read(file);
    const style = /styleUrls?\s*:\s*\[?\s*'([^']+\.scss)'/.exec(source)?.[1];
    const template = /templateUrl\s*:\s*'([^']+\.html)'/.exec(source)?.[1];
    if (!style && !template) {
      return null;
    }
    const dir = dirname(file);
    const templatePath = template
      ? join(dir, template.replace(/^\.\//, ''))
      : null;
    return {
      file,
      style: style ? join(dir, style.replace(/^\.\//, '')) : null,
      html:
        (templatePath && exists(templatePath) ? read(templatePath) : '') +
        (/template\s*:\s*`([\s\S]*?)`/.exec(source)?.[1] ?? ''),
    };
  })
  .filter(Boolean);

/** class name -> the components whose templates render it. */
const usedBy = new Map();
for (const component of components) {
  for (const name of classesUsed(component.html)) {
    if (!usedBy.has(name)) {
      usedBy.set(name, new Set());
    }
    usedBy.get(name).add(component.file);
  }
}

describe('component styling reach', () => {
  it('finds the components at all, so an empty sweep cannot pass', () => {
    expect(components.length).toBeGreaterThan(0);
    expect(components.filter((c) => c.style).length).toBeGreaterThan(0);
    expect(usedBy.size).toBeGreaterThan(0);
  });

  it('never styles a class that only another component renders', () => {
    const unreachable = [];

    for (const component of components) {
      if (!component.style) {
        continue;
      }
      const own = classesUsed(component.html);
      const defined = new Set(
        [
          ...sheetText(component.style).matchAll(
            /(?<![\w-])\.([a-zA-Z][\w-]*)/g,
          ),
        ].map((match) => match[1]),
      );

      for (const name of defined) {
        if (own.has(name)) {
          continue; // styled and rendered by the same component: the normal case
        }
        const renderers = usedBy.get(name);
        if (!renderers?.size) {
          continue; // rendered by nobody — dead or vendor-owned, a different question
        }
        unreachable.push(
          `.${name} is styled by ${component.style} but rendered only by ${[...renderers].join(', ')}`,
        );
      }
    }

    expect(unreachable).toEqual([]);
  });

  it('pads both ends of every surface that reaches the screen edge', () => {
    // `.safe-bottom` sat in global.scss with ZERO call sites while four full-height panels
    // padded only their top, so on a notched phone the thread composer and the member-info
    // action row sat under the home indicator. Nothing could catch that: the utility is inert
    // off a notched device, so it renders identically everywhere a test runs.
    const panels = [
      'libs/feature/rooms/src/lib/message-search/message-search.component.html',
      'libs/feature/rooms/src/lib/pinned/pinned-messages-panel.component.html',
      'libs/feature/rooms/src/lib/thread/thread-view.component.html',
      'libs/feature/rooms/src/lib/thread/threads-list.component.html',
      // Member info is no longer a screen-edge panel (#1041): as a sheet the sheet frame pads
      // the safe area, and embedded in settings the settings column does.
    ];

    const unpadded = panels.filter(
      (file) => !read(file).includes('safe-bottom'),
    );

    expect(unpadded).toEqual([]);
  });
});

describe('overlay surface and scrim', () => {
  const variables = read(
    'libs/theme-foundation/styles/internal/variables.scss',
  );
  const globalStyles = read('apps/trinity/src/global.scss');
  const blockOf = (selector) => {
    const start = variables.indexOf(`${selector} {`);
    return variables.slice(start, variables.indexOf('\n  }', start));
  };
  const roles = [
    '--trinity-surface-overlay',
    '--trinity-surface-overlay-footer',
    '--trinity-border-overlay',
  ];

  it('declares the overlay roles in :root and :root.dark and aliases card and popover to them', () => {
    for (const selector of [':root', ':root.dark']) {
      const block = blockOf(`  ${selector}`);
      for (const role of roles) expect(block).toContain(`${role}:`);
      expect(block).toMatch(
        /--trinity-surface-card:\s*var\(--trinity-surface-overlay\);/u,
      );
      expect(block).toMatch(
        /--trinity-surface-popover:\s*var\(--trinity-surface-overlay\);/u,
      );
    }
  });

  it('dims the dark scrim to 65% and paints the CDK backdrop with it', () => {
    expect(blockOf('  :root.dark')).toMatch(
      /--trinity-overlay-scrim:\s*oklch\(0% 0 0deg \/ 65%\);/u,
    );
    expect(globalStyles).toMatch(
      /\.cdk-overlay-dark-backdrop\s*\{[^}]*background:\s*var\(--trinity-overlay-scrim\)/u,
    );
  });

  it('defines the dialog and sheet enter animations and silences them for reduced motion', () => {
    expect(globalStyles).toMatch(
      /\.trn-overlay-enter-dialog\s*\{[^}]*trn-dialog-in var\(--trinity-duration-overlay\) ease-out/u,
    );
    expect(globalStyles).toMatch(
      /\.trn-overlay-enter-sheet\s*\{[^}]*trn-sheet-in var\(--trinity-duration-base\) ease-out/u,
    );
    expect(globalStyles).toMatch(
      /prefers-reduced-motion: reduce[\s\S]*animation-duration: 0\.01ms !important/u,
    );
  });
});
