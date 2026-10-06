import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every dialog, sheet and fullscreen overlay is built on `<trn-dialog-shell>`, so a hand-rolled
 * `trnOverlaySurface` dialog cannot return. Only the shell itself, the settings workspace, the
 * action sheet and the R4 header panels may pick those layouts directly.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const allowed = new Set([
  'trn-dialog-shell.component.html',
  'trn-settings-layout.component.html',
  'trn-action-sheet.component.ts',
  // The R4 header panels.
  'pinned-messages-panel.component.html',
  'thread-view.component.html',
  'threads-list.component.html',
]);
const dialogLayout =
  /<[^>]*\btrnOverlaySurface\b[^>]*(?:\blayout="(?:dialog|sheet|workspace|fullscreen)"|\[layout\])[^>]*>/u;

describe('dialog shell usage', () => {
  it('keeps hand-rolled dialog surfaces out of libs', () => {
    const offenders = globSync(['libs/**/*.html', 'libs/**/*.ts'], {
      cwd: workspaceRoot,
    })
      .filter(
        (file) =>
          !file.endsWith('.spec.ts') &&
          !file.endsWith('.stories.ts') &&
          !file.includes('/stories/') &&
          !allowed.has(file.split('/').at(-1)),
      )
      .filter((file) =>
        dialogLayout.test(readFileSync(join(workspaceRoot, file), 'utf8')),
      )
      .sort();

    expect(offenders).toEqual([]);
  });
});
