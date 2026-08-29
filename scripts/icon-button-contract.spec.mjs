import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');

/**
 * Mechanical coverage for Trinity's two icon-button entry points.
 *
 * `trnBtn size="icon*"` owns standard square geometry. `trnIconButton` is the explicit
 * opt-in for a purpose-built control whose shape communicates context (for example a reaction
 * chip or server-rail pill). Both receive the same cursor, state feedback and inner-glyph
 * motion. Exact per-file counts make additions and removals reviewable even in an already
 * inventoried file.
 */

const htmlFiles = globSync(['apps/**/*.html', 'libs/**/*.html'], {
  cwd: workspaceRoot,
});
const inlineTemplateFiles = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
  cwd: workspaceRoot,
  exclude: ['**/*.spec.ts'],
});

const sources = [
  ...htmlFiles.map((file) => ({ file, source: read(file) })),
  ...inlineTemplateFiles.flatMap((file) => {
    const fileSource = read(file);
    return [...fileSource.matchAll(/\btemplate:\s*`([\s\S]*?)`/g)].map(
      (match, index) => ({
        file: `${file}#template-${index + 1}`,
        source: match[1],
      }),
    );
  }),
];

const controlBlocks = sources.flatMap(({ file, source }) =>
  [...source.matchAll(/<(button|a)\b[^>]*>[\s\S]*?<\/\1>/g)].map((match) => ({
    file,
    line: source.slice(0, match.index).split('\n').length,
    source: match[0],
    openingTag: match[0].slice(0, match[0].indexOf('>') + 1),
  })),
);

const publicIconButtons = controlBlocks.filter(
  ({ openingTag }) =>
    /\btrnBtn\b/.test(openingTag) &&
    (/\bsize="icon(?:-[^"]+)?"/.test(openingTag) ||
      /\[size\]=/.test(openingTag)),
);

const bespokeIconButtons = controlBlocks.filter(({ openingTag }) =>
  /\btrnIconButton\b/.test(openingTag),
);

const expectedBespokeCounts = {
  'libs/components/message-toolbar/src/lib/message-toolbar.component.html': 5,
  'libs/feature/rooms/src/lib/channel-sidebar/channel-sidebar.component.html': 6,
  'libs/feature/rooms/src/lib/channel-sidebar/sidebar-room-list/sidebar-room-list.component.html': 3,
  'libs/feature/rooms/src/lib/channel-sidebar/sidebar-user-panel/sidebar-user-panel.component.html': 1,
  'libs/feature/rooms/src/lib/message-composer/composer-attachment-strip/composer-attachment-strip.component.html': 2,
  'libs/feature/rooms/src/lib/message-composer/composer-insert-menu/composer-insert-menu.component.html': 3,
  'libs/feature/rooms/src/lib/message-composer/composer-toolbar/composer-toolbar.component.html': 2,
  'libs/feature/rooms/src/lib/message-composer/message-composer.component.html': 6,
  'libs/feature/rooms/src/lib/message-reactions/message-reactions.component.html': 1,
  'libs/feature/rooms/src/lib/server-rail/server-rail.component.html': 4,
  'libs/feature/rooms/src/lib/voice-message/voice-message.component.html': 1,
  'libs/feature/settings/src/lib/account/account-section.component.html': 3,
  'libs/feature/settings/src/lib/profile/profile-settings.component.html': 1,
  'libs/components/icon/src/lib/trn-icon/trn-icon.component.stories.ts#template-3': 1,
};

const expectedCompositeCounts = {
  'libs/components/message-toolbar/src/lib/message-toolbar.component.html': 9,
  'libs/components/overlay/src/lib/action-sheet/trn-action-sheet.component.ts#template-1': 1,
  'libs/components/toggle-group/src/lib/trn-toggle-group.component.stories.ts#template-1': 7,
  'libs/components/toggle-group/src/lib/trn-toggle-group.component.stories.ts#template-4': 3,
  'libs/components/toggle-group/src/lib/trn-toggle-group.component.stories.ts#template-5': 2,
  'libs/feature/rooms/src/lib/channel-sidebar/channel-sidebar.component.html': 9,
  'libs/feature/rooms/src/lib/channel-sidebar/sidebar-room-list/sidebar-room-list.component.html': 8,
  'libs/feature/rooms/src/lib/channel-sidebar/sidebar-user-panel/sidebar-user-panel.component.html': 5,
  'libs/feature/rooms/src/lib/location-share/location.component.html': 1,
  'libs/feature/rooms/src/lib/message-composer/composer-insert-menu/composer-insert-menu.component.html': 1,
  'libs/feature/rooms/src/lib/message-row/message-row.component.html': 1,
  'libs/feature/rooms/src/lib/quick-switcher/quick-switcher.component.html': 1,
  'libs/feature/rooms/src/lib/rooms/rooms.page.html': 5,
  'libs/feature/settings/src/lib/settings/settings.page.html': 1,
};

const countsByFile = (controls) =>
  Object.fromEntries(
    [...Map.groupBy(controls, ({ file }) => file)]
      .map(([file, entries]) => [file, entries.length])
      .sort(([left], [right]) => left.localeCompare(right)),
  );

describe('icon-button contract', () => {
  it('finds public controls across buttons, links and inline templates', () => {
    expect(publicIconButtons.length).toBeGreaterThan(20);
    expect(
      publicIconButtons.some(({ openingTag }) => /^<a\b/.test(openingTag)),
    ).toBe(true);
    expect(
      publicIconButtons.some(({ file }) => file.includes('#template-')),
    ).toBe(true);
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
      .filter(({ file }) => file.endsWith('.html'))
      .filter(
        ({ file, openingTag }) =>
          !contextualVariants.has(file) &&
          !/\bvariant="ghost"/.test(openingTag),
      )
      .map(({ file, line }) => `${file}:${line}`);

    expect(inconsistent).toEqual([]);
  });

  it('gives each purpose-built icon control a labelled semantic motion', () => {
    const incomplete = bespokeIconButtons
      .filter(
        ({ source, openingTag }) =>
          !/(?:aria-label|\[attr\.aria-label\]|\[aria-label\])=/.test(
            openingTag,
          ) || !/<trn-icon\b[^>]*\bmotion=/.test(source),
      )
      .map(({ file, line }) => `${file}:${line}`);

    expect(incomplete).toEqual([]);
  });

  it('never delegates interactive labels to native title tooltips', () => {
    const incomplete = controlBlocks
      .filter(({ openingTag }) =>
        /(?:\[attr\.title\]|\[title\]|\btitle)=/.test(openingTag),
      )
      .map(({ file, line }) => `${file}:${line}`);

    expect(incomplete).toEqual([]);
  });

  it('keeps the purpose-built icon-control inventory exact', () => {
    expect(countsByFile(bespokeIconButtons)).toEqual(expectedBespokeCounts);
  });

  it('keeps composite icon-and-text controls out of the icon-only contract', () => {
    const composites = controlBlocks.filter(
      ({ source, openingTag }) =>
        !/(?:\btrnBtn\b|\btrnIconButton\b)/.test(openingTag) &&
        /<trn-icon(?:\s|>)/.test(source),
    );

    expect(countsByFile(composites)).toEqual(expectedCompositeCounts);
  });
});
