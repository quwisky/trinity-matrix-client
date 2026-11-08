import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Each safe-area inset is padded once, by the one surface that reaches that screen edge, in a
 * single declaration (`padding-bottom: env(safe-area-inset-bottom)`), so there is no second
 * rule for it to lose a cascade fight to. jsdom applies no CSS and the inset is 0 off a notched
 * device, so a doubled or missing inset renders identically everywhere a test runs: it is
 * decided from the source here.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');

describe('bottom safe-area ownership', () => {
  it('pins the action list sheet padding and safe area to the sheet frame', () => {
    // Emulator families are allowed to report a zero bottom inset. A rendered equality on
    // those devices is therefore vacuous: deleting env() would still pass. Keep the exact
    // composition source-guarded, while the installed-WebView journey owns real geometry.
    const frame = read(
      'libs/components/overlay/src/lib/sheet-frame/trn-sheet-frame.component.scss',
    );
    expect(frame).toMatch(
      /:host\s*\{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom\);/,
    );
    expect(frame.match(/env\(safe-area-inset-bottom\)/g)).toHaveLength(1);
    // The 0.375rem the sheet used to compose with the inset now sits on the list's scroller.
    expect(
      read(
        'libs/components/overlay/src/lib/action-sheet/trn-action-list.component.html',
      ),
    ).toMatch(/min-h-0 flex-1 overflow-y-auto pb-1\.5/);
  });

  it("clears the room panels' bottom inset once, in the slot that hosts them", () => {
    const rooms = read('libs/feature/rooms/src/lib/rooms/rooms.page.scss');
    const slot = rooms.slice(rooms.indexOf('.chat-members,\n  .chat-panel {'));
    expect(slot.split('}')[0]).toContain(
      'padding-bottom: env(safe-area-inset-bottom)',
    );
    // The thread's composer would pad it again under the same edge.
    expect(
      read('libs/feature/rooms/src/lib/thread/thread-view.component.scss'),
    ).toContain('--composer-safe-bottom: 0px');
    expect(
      read(
        'libs/feature/rooms/src/lib/message-composer/message-composer.component.scss',
      ),
    ).toMatch(
      /var\(\s*--composer-safe-bottom,\s*env\(safe-area-inset-bottom\)\s*\)/u,
    );
  });
});

/**
 * The application frame pads the top safe area once, above every routed page, or hands it to
 * the first banner or the Rooms shell columns as `--trinity-top-inset`, so an in-flow
 * surface that pads it again doubles the gap on a notched device. Only out-of-flow surfaces
 * (overlays, fixed layers, the top-layer lock cover) may apply it themselves.
 */
const TOP_INSET_OWNERS = new Map([
  [
    'apps/trinity/src/global.scss',
    'the application frame, which hands the inset to its top bar',
  ],
  [
    'libs/application/appearance/src/lib/appearance-status-area.source.ts',
    'a fixed, hidden probe measuring whether the page reaches under the status bar',
  ],
  [
    'libs/application/runtime/src/lib/application-root/app-lock-cover/app-lock-cover.component.html',
    'top-layer dialog moved to <body>',
  ],
  [
    'libs/components/overlay/src/lib/dialog-shell/trn-dialog-shell.component.scss',
    'CDK overlay',
  ],
  [
    'libs/components/overlay/src/lib/sheet-frame/sheet-detent.ts',
    'CDK overlay sizing',
  ],
  [
    'libs/components/overlay/src/lib/settings-layout/trn-settings-layout.compact.scss',
    'CDK overlay',
  ],
  [
    'libs/components/overlay/src/lib/sheet-frame/trn-sheet-keyboard.directive.ts',
    'CDK overlay sizing',
  ],
  [
    'libs/components/overlay/src/lib/surface/trn-overlay-surface-recipe.ts',
    'CDK overlay sizing',
  ],
  [
    'libs/feature/rooms/src/lib/media-attachment/lightbox/lightbox.component.scss',
    'CDK overlay',
  ],
  [
    'libs/feature/rooms/src/lib/rooms/rooms.page.scss',
    'the fixed phone drawers, below the members breakpoint',
  ],
]);

describe('top safe-area ownership', () => {
  it('pads the top safe area only in the frame and out-of-flow surfaces', () => {
    const users = globSync(
      ['libs/**/*.{html,ts,scss}', 'apps/trinity/src/**/*.{html,ts,scss}'],
      { cwd: workspaceRoot },
    ).filter(
      (file) =>
        !file.includes('node_modules') &&
        !/\.(spec|stories)\.ts$/.test(file) &&
        /\bsafe-top\b|safe-area-inset-top/.test(read(file)),
    );

    expect(users.filter((file) => !TOP_INSET_OWNERS.has(file))).toEqual([]);
    expect(
      [...TOP_INSET_OWNERS.keys()].filter((file) => !users.includes(file)),
    ).toEqual([]);
  });

  it('insets the side panels only as fixed phone drawers, never in their header', () => {
    // The header also heads in-flow columns and the member card embedded in settings.
    const header = read(
      'libs/feature/rooms/src/lib/side-panel/side-panel-header.component.scss',
    );
    const rooms = read('libs/feature/rooms/src/lib/rooms/rooms.page.scss');
    const drawers = rooms.indexOf('@media #{$below-members}');

    expect(header).not.toContain('safe-area-inset-top');
    expect(drawers).toBeGreaterThan(-1);
    expect(rooms.indexOf('safe-area-inset-top')).toBeGreaterThan(drawers);
  });
});
