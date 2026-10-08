import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every dialog, sheet and fullscreen overlay is built on `<trn-dialog-shell>`, so a hand-rolled
 * `trnOverlaySurface` dialog cannot return. Only the shell itself and the R4
 * header panels may pick those layouts directly.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const allowed = new Set([
  'trn-dialog-shell.component.html',
  // The R4 header panels.
  'pinned-messages-panel.component.html',
  'thread-view.component.html',
  'threads-list.component.html',
]);
const calmLayouts = new Set(['popover', 'panel']);

/** The text of the array that follows `hostDirectives:`, bracket-balanced, or `''`. */
function hostDirectivesArray(source) {
  const start = source.search(/\bhostDirectives\s*:\s*\[/u);
  if (start < 0) return '';
  const open = source.indexOf('[', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '[') depth++;
    if (source[i] === ']' && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

/**
 * Whether `source` builds a dialog-like surface by hand: a `trnOverlaySurface` element whose
 * layout is not a literal popover or panel (a missing layout defaults to `dialog`, and a bound
 * one cannot be proven safe), or the surface directive applied as a host directive.
 */
function buildsDialogSurface(source) {
  if (/\bTrnOverlaySurfaceDirective\b/u.test(hostDirectivesArray(source))) {
    return true;
  }
  return [
    ...source.matchAll(/<[a-zA-Z][^>]*\btrnOverlaySurface\b[^>]*>/gu),
  ].some(([tag]) => {
    const layout = /(?<![\w[-])layout\s*=\s*(["'])(.*?)\1/u.exec(tag)?.[2];
    return !calmLayouts.has(layout);
  });
}

describe('dialog shell usage', () => {
  it('keeps hand-rolled dialog surfaces out of libs', () => {
    const files = globSync(['libs/**/*.html', 'libs/**/*.ts'], {
      cwd: workspaceRoot,
    });
    // An empty scan would pass vacuously.
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter(
        (file) =>
          !file.endsWith('.spec.ts') &&
          !file.endsWith('.stories.ts') &&
          !file.includes('/stories/') &&
          !allowed.has(file.split('/').at(-1)),
      )
      .filter((file) =>
        buildsDialogSurface(readFileSync(join(workspaceRoot, file), 'utf8')),
      )
      .sort();

    expect(offenders).toEqual([]);
  });

  describe('detector', () => {
    it.each([
      [
        'a double-quoted dialog layout',
        '<div trnOverlaySurface layout="dialog">',
      ],
      [
        'a single-quoted dialog layout',
        "<div trnOverlaySurface layout='dialog'>",
      ],
      ['a bound layout', '<div trnOverlaySurface [layout]="mode()">'],
      [
        'no layout, which defaults to dialog',
        '<div trnOverlaySurface variant="neutral">',
      ],
      [
        'a multi-line tag with a sheet layout',
        '<section\n  trnOverlaySurface\n  variant="neutral"\n  layout="sheet"\n>',
      ],
      [
        'a host directive',
        "hostDirectives: [{ directive: TrnOverlaySurfaceDirective, inputs: ['layout: surfaceLayout'] }],",
      ],
      ['a bare host directive', 'hostDirectives: [TrnOverlaySurfaceDirective]'],
    ])('flags %s', (_name, source) => {
      expect(buildsDialogSurface(source)).toBe(true);
    });

    it.each([
      ['a popover', '<div trnOverlaySurface layout="popover">'],
      ['a single-quoted panel', "<div trnOverlaySurface layout='panel'>"],
      ['an import of the directive', 'imports: [TrnOverlaySurfaceDirective],'],
      [
        'host directives that are not the surface',
        "hostDirectives: [{ directive: Other, inputs: ['a: b'] }], imports: [TrnOverlaySurfaceDirective]",
      ],
      [
        'another element using the name layout',
        '<div [size]="x" data-layout="dialog">',
      ],
    ])('accepts %s', (_name, source) => {
      expect(buildsDialogSurface(source)).toBe(false);
    });
  });
});
