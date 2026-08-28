import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');

/**
 * The public icon-button contract is deliberately mechanical.
 *
 * A `trnBtn` whose size starts with `icon` receives its shared geometry and interaction
 * marker from `TrnButton`; its icon chooses one explicit semantic gesture. These assertions
 * stop a new call site quietly returning to a one-off hover treatment or an inert glyph.
 *
 * Some controls are intentionally not square public buttons: navigation rows, the server
 * rail, reaction chips, media playback, attachment previews, formatting toggles, composer
 * actions and the unusually compact floating message toolbar. Their component styles own
 * geometry because shape or target size communicates a different interaction model. The
 * allowlist makes those exceptions reviewable instead of accidental.
 */

const htmlFiles = globSync(['apps/**/*.html', 'libs/**/*.html'], {
  cwd: workspaceRoot,
});

const buttonBlocks = htmlFiles.flatMap((file) => {
  const source = read(file);
  return [...source.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(
    (match) => ({
      file,
      line: source.slice(0, match.index).split('\n').length,
      source: match[0],
    }),
  );
});

const publicIconButtons = buttonBlocks.filter(
  ({ source }) =>
    /\btrnBtn\b/.test(source) && /\bsize="icon(?:-[^"]+)?"/.test(source),
);

const specializedIconControlFiles = new Set([
  'libs/components/message-toolbar/src/lib/message-toolbar.component.html',
  'libs/feature/rooms/src/lib/channel-sidebar/channel-sidebar.component.html',
  'libs/feature/rooms/src/lib/channel-sidebar/sidebar-room-list/sidebar-room-list.component.html',
  'libs/feature/rooms/src/lib/channel-sidebar/sidebar-user-panel/sidebar-user-panel.component.html',
  'libs/feature/rooms/src/lib/message-composer/composer-attachment-strip/composer-attachment-strip.component.html',
  'libs/feature/rooms/src/lib/message-composer/composer-insert-menu/composer-insert-menu.component.html',
  'libs/feature/rooms/src/lib/message-composer/composer-toolbar/composer-toolbar.component.html',
  'libs/feature/rooms/src/lib/message-composer/message-composer.component.html',
  'libs/feature/rooms/src/lib/message-reactions/message-reactions.component.html',
  'libs/feature/rooms/src/lib/message-row/message-row.component.html',
  'libs/feature/rooms/src/lib/quick-switcher/quick-switcher.component.html',
  'libs/feature/rooms/src/lib/rooms/rooms.page.html',
  'libs/feature/rooms/src/lib/server-rail/server-rail.component.html',
  'libs/feature/rooms/src/lib/voice-message/voice-message.component.html',
  'libs/feature/settings/src/lib/account/account-section.component.html',
  'libs/feature/settings/src/lib/profile/profile-settings.component.html',
]);

describe('icon-button contract', () => {
  it('finds the public controls so an empty sweep cannot pass', () => {
    expect(publicIconButtons.length).toBeGreaterThan(20);
  });

  it('gives every public icon button an explicit semantic motion', () => {
    const inert = publicIconButtons
      .filter(({ source }) => !/<trn-icon\b[^>]*\bmotion=/.test(source))
      .map(({ file, line }) => `${file}:${line}`);

    expect(inert).toEqual([]);
  });

  it('keeps the common ghost treatment except for named contextual contrast', () => {
    const contextualVariants = new Set([
      'libs/feature/rooms/src/lib/media-attachment/lightbox/lightbox.component.html',
    ]);
    const inconsistent = publicIconButtons
      .filter(
        ({ file, source }) =>
          !contextualVariants.has(file) && !/\bvariant="ghost"/.test(source),
      )
      .map(({ file, line }) => `${file}:${line}`);

    expect(inconsistent).toEqual([]);
  });

  it('keeps the bespoke interaction-surface inventory exact', () => {
    const specialized = new Set(
      buttonBlocks
        .filter(
          ({ source }) =>
            !/\btrnBtn\b/.test(source) && /<trn-icon(?:\s|>)/.test(source),
        )
        .map(({ file }) => file),
    );

    expect([...specialized].sort()).toEqual(
      [...specializedIconControlFiles].sort(),
    );
  });
});
