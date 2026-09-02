import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNLAYERED_RULESET_LEDGER } from './cascade-layer-exceptions.mjs';
import {
  stripMarkupComments,
  stripSourceComments,
  topLevelStyleBlocks,
} from './source-style-blocks.mjs';

/**
 * Freeze the completed application-consumer migrations from #397 through #401.
 *
 * Public components still accept a few expansion aliases while the remaining slices move.
 * This guard makes authentication, Trust, Settings, every Rooms consumer, startup, routing and
 * host-shell consumers a closed set: comments cannot satisfy it, vendor imports cannot bypass the
 * public tier, and aliases or unlayered component rules cannot quietly return after these slices
 * leave the migration ledgers.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const migratedRoomsRoot = 'libs/feature/rooms/src/lib';
const migratedRoomNavigationRoots = [
  'libs/feature/rooms/src/lib/account-picker',
  'libs/feature/rooms/src/lib/channel-sidebar',
  'libs/feature/rooms/src/lib/server-rail',
];
const migratedConversationRoots = [
  'libs/feature/rooms/src/lib/encryption-banner',
  'libs/feature/rooms/src/lib/message-actions',
  'libs/feature/rooms/src/lib/message-composer',
  'libs/feature/rooms/src/lib/message-list',
  'libs/feature/rooms/src/lib/message-reactions',
  'libs/feature/rooms/src/lib/message-reply-preview',
  'libs/feature/rooms/src/lib/message-row',
  'libs/feature/rooms/src/lib/message-thread-summary',
  'libs/feature/rooms/src/lib/message-toolbar',
  'libs/feature/rooms/src/lib/media-attachment',
  'libs/feature/rooms/src/lib/media-bubble',
  'libs/feature/rooms/src/lib/pinned',
  'libs/feature/rooms/src/lib/reaction-picker',
  'libs/feature/rooms/src/lib/reactions-dialog',
  'libs/feature/rooms/src/lib/thread',
  'libs/feature/rooms/src/lib/voice-message',
];
const migratedRoots = [
  'apps/trinity/src/app',
  'libs/application/runtime/src/lib',
  'libs/feature/auth/src/lib',
  'libs/feature/crypto/src/lib',
  migratedRoomsRoot,
  'libs/feature/settings/src/lib',
  'libs/feature/shell/src/lib',
];
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');
const productionSources = [
  ...globSync(
    migratedRoots.flatMap((root) => [
      `${root}/**/*.ts`,
      `${root}/**/*.html`,
      `${root}/**/*.scss`,
    ]),
    { cwd: workspaceRoot },
  ),
]
  .filter(
    (file) =>
      !file.endsWith('.spec.ts') &&
      !file.endsWith('.stories.ts') &&
      !file.endsWith('test-setup.ts'),
  )
  .sort();
const templates = productionSources.filter((file) => file.endsWith('.html'));
const roomTemplates = templates.filter((file) =>
  file.startsWith(`${migratedRoomsRoot}/`),
);
const settingsTemplates = templates.filter((file) =>
  file.startsWith('libs/feature/settings/src/lib/'),
);
const roomNavigationTemplates = templates.filter(
  (file) =>
    migratedRoomNavigationRoots.some((root) => file.startsWith(`${root}/`)) ||
    file === 'libs/feature/rooms/src/lib/rooms/rooms.page.html',
);
const conversationTemplates = templates.filter((file) =>
  migratedConversationRoots.some((root) => file.startsWith(`${root}/`)),
);
const typescript = productionSources.filter((file) => file.endsWith('.ts'));
const componentStyles = productionSources.filter(
  (file) => file.endsWith('.component.scss') || file.endsWith('.page.scss'),
);

const markup = (file) => stripMarkupComments(read(file));
const source = (file) => stripSourceComments(read(file));
const tagsFrom = (files, selector) =>
  files.flatMap((file) =>
    [...markup(file).matchAll(selector)].map(([tag]) => [file, tag]),
  );
const tags = (selector) => tagsFrom(templates, selector);

describe('migrated application design-system consumers', () => {
  it('is a non-vacuous public-tier-only production slice', () => {
    expect(productionSources.length).toBeGreaterThan(40);
    expect(templates.length).toBeGreaterThan(10);

    const imports = typescript.flatMap((file) =>
      [...source(file).matchAll(/from\s+['"]([^'"]+)['"]/gu)].map(
        ([, specifier]) => [file, specifier],
      ),
    );
    expect(imports.length).toBeGreaterThan(40);
    expect(
      imports.filter(([, specifier]) =>
        /^(?:@angular\/cdk|@ctrl\/ngx-emoji-mart|@ng-icons|@spartan-ng|@trinity\/helm)/u.test(
          specifier,
        ),
      ),
    ).toEqual([]);
  });

  it('uses only canonical Trinity button, card and overlay vocabulary', () => {
    const buttons = tags(/<(?:button|a)\b[^>]*\btrnBtn\b[^>]*>/gu);
    expect(buttons.length).toBeGreaterThan(90);

    for (const [file, tag] of buttons) {
      expect(tag, file).not.toMatch(
        /\bvariant\s*=\s*['"](?:default|destructive|outline|ghost|link)['"]/u,
      );
      expect(tag, file).not.toMatch(
        /\bsize\s*=\s*['"](?:default|icon(?:-(?:xs|sm|lg))?)['"]/u,
      );
      expect(tag, file).not.toMatch(
        /\bclass\s*=\s*['"][^'"]*(?:bg-|border-|font-|h-|leading-|p[trblxy]?-|ring-|rounded-|shadow-|text-|tracking-|hover:|focus:)[^'"]*['"]/u,
      );
    }

    const settingsButtons = tagsFrom(settingsTemplates, /<button\b[^>]*>/gu);
    expect(settingsButtons.length).toBeGreaterThan(25);
    for (const [file, tag] of settingsButtons) {
      expect(tag, file).toMatch(/\b(?:trnBtn|trnIconButton)\b/u);
    }

    const settingsAvatars = tagsFrom(
      settingsTemplates,
      /<trn-avatar\b[^>]*>/gu,
    );
    for (const [file, tag] of settingsAvatars) {
      expect(tag, file).not.toMatch(
        /(?:\[size\]|\bsize)\s*=\s*['"](?:\d+(?:\.\d+)?|\d+(?:\.\d+)?(?:px|rem|em))['"]/u,
      );
    }

    const settingsIcons = tagsFrom(settingsTemplates, /<trn-icon\b[^>]*>/gu);
    for (const [file, tag] of settingsIcons) {
      expect(tag, file).not.toMatch(
        /\bsize\s*=\s*['"]\d+(?:\.\d+)?(?:px|rem|em)['"]/u,
      );
    }

    expect(roomNavigationTemplates).toHaveLength(6);
    const roomNavigationAvatars = tagsFrom(
      roomNavigationTemplates,
      /<trn-avatar\b[^>]*>/gu,
    );
    expect(roomNavigationAvatars.length).toBeGreaterThan(10);
    for (const [file, tag] of roomNavigationAvatars) {
      expect(tag, file).not.toMatch(
        /(?:\[size\]|\bsize)\s*=\s*['"](?:\d+(?:\.\d+)?|\d+(?:\.\d+)?(?:px|rem|em))['"]/u,
      );
    }

    const roomNavigationIcons = tagsFrom(
      roomNavigationTemplates,
      /<trn-icon\b[^>]*>/gu,
    );
    expect(roomNavigationIcons.length).toBeGreaterThan(25);
    for (const [file, tag] of roomNavigationIcons) {
      expect(tag, file).not.toMatch(
        /\bsize\s*=\s*['"]\d+(?:\.\d+)?(?:px|rem|em)['"]/u,
      );
    }

    const roomAvatars = tagsFrom(roomTemplates, /<trn-avatar\b[^>]*>/gu);
    expect(roomAvatars.length).toBeGreaterThan(15);
    for (const [file, tag] of roomAvatars) {
      expect(tag, file).not.toMatch(
        /(?:\[size\]|\bsize)\s*=\s*['"](?:\d+(?:\.\d+)?|\d+(?:\.\d+)?(?:px|rem|em))['"]/u,
      );
    }

    const roomIcons = tagsFrom(roomTemplates, /<trn-icon\b[^>]*>/gu);
    expect(roomIcons.length).toBeGreaterThan(50);
    for (const [file, tag] of roomIcons) {
      expect(tag, file).not.toMatch(
        /\bsize\s*=\s*['"]\d+(?:\.\d+)?(?:px|rem|em)['"]/u,
      );
    }

    for (const [file, tag] of tagsFrom(
      roomTemplates,
      /<trn-banner\b[^>]*>/gu,
    )) {
      expect(tag, file).not.toMatch(/\btone\s*=/u);
    }

    for (const [file, tag] of tagsFrom(
      roomTemplates,
      /<trn-spinner\b[^>]*>/gu,
    )) {
      expect(tag, file).not.toMatch(
        /\bclass\s*=\s*['"][^'"]*\btext-(?:base|\[[^\]]+\])\b/u,
      );
    }

    for (const [file, tag] of tagsFrom(
      roomTemplates,
      /<trn-empty-state\b[^>]*>/gu,
    )) {
      expect(tag, file).not.toMatch(/\bsize\s*=/u);
      expect(tag, file).not.toMatch(/\btone\s*=/u);
    }

    // The chat composer is a single-line input that grows, while the public textarea recipe is
    // deliberately multi-line. Reapplying it makes its utility-layer minimum override the
    // feature-owned geometry and leaves the recording replacement 21px shorter.
    const composerInputs = tagsFrom(
      roomTemplates,
      /<textarea\b[^>]*\bclass\s*=\s*['"][^'"]*\bcomposer__input\b[^'"]*['"][^>]*>/gu,
    );
    expect(composerInputs).toHaveLength(1);
    expect(composerInputs[0]?.[1]).not.toMatch(/\btrnTextarea\b/u);

    for (const [file, tag] of tagsFrom(
      roomNavigationTemplates,
      /<trn-empty-state\b[^>]*>/gu,
    )) {
      expect(tag, file).not.toMatch(/\bsize\s*=/u);
    }
    for (const [file, tag] of tagsFrom(
      roomNavigationTemplates,
      /<trn-page-header\b[^>]*>/gu,
    )) {
      expect(tag, file).not.toMatch(/\bvariant\s*=\s*['"](?:page|chat)['"]/u);
    }
    for (const [file, tag] of tagsFrom(
      roomNavigationTemplates,
      /<[^>]*\btrnDropdownMenuItem\b[^>]*>/gu,
    )) {
      expect(tag, file).not.toMatch(
        /\bvariant\s*=\s*['"](?:default|destructive)['"]/u,
      );
    }
    for (const [file, tag] of tagsFrom(
      roomTemplates,
      /<trn-page-header\b[^>]*>/gu,
    )) {
      expect(tag, file).not.toMatch(/\bvariant\s*=\s*['"](?:page|chat)['"]/u);
    }
    for (const [file, tag] of tagsFrom(
      conversationTemplates,
      /<[^>]*\btrnDropdownMenuItem\b[^>]*>/gu,
    )) {
      expect(tag, file).not.toMatch(
        /\bvariant\s*=\s*['"](?:default|destructive)['"]/u,
      );
    }
    for (const [file, tag] of tagsFrom(
      roomTemplates,
      /<[^>]*\btrnDropdownMenuItem\b[^>]*>/gu,
    )) {
      expect(tag, file).not.toMatch(
        /\bvariant\s*=\s*['"](?:default|destructive)['"]/u,
      );
    }

    const roomNavigationSurfaces = tagsFrom(
      roomNavigationTemplates,
      /<[^>]*\btrnOverlaySurface\b[^>]*>/gu,
    );
    expect(roomNavigationSurfaces).toHaveLength(1);
    expect(roomNavigationSurfaces[0]?.[1]).toMatch(/\bvariant="neutral"/u);
    expect(roomNavigationSurfaces[0]?.[1]).toMatch(/\bsize="sm"/u);
    expect(roomNavigationSurfaces[0]?.[1]).toMatch(/\blayout="dialog"/u);
    expect(roomNavigationSurfaces[0]?.[1]).toMatch(
      /\bclass="[^"]*\bflex\b[^"]*\bflex-col\b/u,
    );

    const accountCheckboxes = tagsFrom(
      roomNavigationTemplates,
      /<[^>]*\btrnDropdownMenuCheckbox\b[^>]*>/gu,
    );
    expect(accountCheckboxes).toHaveLength(1);
    expect(accountCheckboxes[0]?.[1]).toMatch(
      /\[lockedSelection\]\s*=\s*"isActive"/u,
    );
    expect(
      markup(
        'libs/feature/rooms/src/lib/account-picker/account-picker.component.html',
      ),
    ).toMatch(/\[trnLockedSelection\]\s*=\s*"locked"/u);

    const cards = tags(/<[^>]*\btrnCard\b[^>]*>/gu);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.any(String),
          expect.stringMatching(/\bvariant="muted"/u),
        ]),
      ]),
    );

    const surfaces = tags(/<[^>]*\btrnOverlaySurface\b[^>]*>/gu);
    expect(surfaces).toHaveLength(29);
    for (const [file, tag] of surfaces) {
      expect(tag, file).toMatch(/\bvariant="neutral"/u);
    }
    expect(
      surfaces
        .map(([, tag]) => tag.match(/\bsize="([^"]+)"/u)?.[1] ?? 'dynamic')
        .sort(),
    ).toEqual([
      '2xl',
      '2xl',
      ...Array(5).fill('lg'),
      ...Array(15).fill('md'),
      ...Array(6).fill('sm'),
      'xl',
    ]);
    expect(
      surfaces
        .map(([, tag]) => tag.match(/\blayout="([^"]+)"/u)?.[1] ?? 'dynamic')
        .sort(),
    ).toEqual([
      ...Array(17).fill('dialog'),
      'dynamic',
      ...Array(4).fill('fullscreen'),
      ...Array(6).fill('popover'),
      'workspace',
    ]);

    expect(
      surfaces.find(([file]) =>
        file.endsWith('room-link-preview.component.html'),
      )?.[1],
    ).toMatch(/\[layout\]="sheet\(\) \? 'sheet' : 'dialog'"/u);

    // Member info is the one overlay whose public surface directive belongs on the component
    // host: in panel mode that host is the actual in-flow pane measured beside the timeline.
    const memberInfo = source(
      'libs/feature/rooms/src/lib/member-info/member-info.component.ts',
    );
    expect(memberInfo).toMatch(
      /hostDirectives:[\s\S]{0,180}TrnOverlaySurfaceDirective[\s\S]{0,180}size: surfaceSize[\s\S]{0,80}layout: surfaceLayout/u,
    );
    const memberInfoPanel = tagsFrom(
      ['libs/feature/rooms/src/lib/rooms/rooms.page.html'],
      /<trn-member-info\b[^>]*>/gu,
    );
    expect(memberInfoPanel).toHaveLength(1);
    expect(memberInfoPanel[0]?.[1]).toMatch(/\bsurfaceSize="lg"/u);
    expect(memberInfoPanel[0]?.[1]).toMatch(/\bsurfaceLayout="panel"/u);
    const memberInfoService = source(
      'libs/feature/rooms/src/lib/member-info/member-info.service.ts',
    );
    expect(memberInfoService).toMatch(
      /surfaceSize:\s*['"]sm['"][\s\S]{0,80}surfaceLayout:\s*['"]dialog['"]/u,
    );

    // Message source uses a deliberately small inline template, so it is not part of the
    // external-markup collection above. Pin its complete public surface vocabulary here rather
    // than letting that one remaining Room overlay fall outside the migration guard.
    const messageSource = source(
      'libs/feature/rooms/src/lib/message-source/message-source.component.ts',
    );
    expect(messageSource).toMatch(
      /trnOverlaySurface[\s\S]{0,160}\bvariant="neutral"[\s\S]{0,80}\bsize="xl"[\s\S]{0,80}\blayout="dialog"/u,
    );
    expect(messageSource).not.toMatch(
      /\bvariant="(?:default|destructive|outline|ghost|link)"|\bsize="(?:default|icon(?:-(?:xs|sm|lg))?)"/u,
    );

    const conversationSurfaces = tagsFrom(
      conversationTemplates,
      /<[^>]*\btrnOverlaySurface\b[^>]*>/gu,
    );
    expect(conversationSurfaces).toHaveLength(7);
    for (const [file, tag] of conversationSurfaces) {
      expect(tag, file).toMatch(/\bvariant="neutral"/u);
      expect(tag, file).toMatch(/\bsize="md"/u);
    }
    expect(
      conversationSurfaces
        .map(([, tag]) => tag.match(/\blayout="([^"]+)"/u)?.[1])
        .sort(),
    ).toEqual([
      'dialog',
      'fullscreen',
      'fullscreen',
      'fullscreen',
      'popover',
      'popover',
      'popover',
    ]);
    for (const [file, tag] of conversationSurfaces.filter(([, tag]) =>
      /\blayout="fullscreen"/u.test(tag),
    )) {
      expect(tag, file).toMatch(/\bclass="[^"]*\bflex\b[^"]*\bflex-col\b/u);
    }
  });

  it('uses cold finite alert commands and canonical danger variants', () => {
    const authored = typescript.map(source).join('\n');
    expect(authored).toContain('.confirm$(');
    expect(authored).toContain('.prompt$(');
    expect(authored).toContain('.openAndWait$');
    expect(authored).not.toMatch(/\.(?:confirm|prompt)\s*\(/u);
    expect(authored).not.toMatch(/\.openAndWait\s*\(/u);
    expect(authored).not.toMatch(/\bdestructive\s*:\s*true\b/u);
    expect(authored).not.toMatch(/\bvariant\s*:\s*['"]destructive['"]/u);
    expect(authored).not.toMatch(/\brole\s*:\s*['"]destructive['"]/u);
    expect(authored).not.toMatch(/\bside\s*:/u);
  });

  it('keeps every component stylesheet in the named components layer', () => {
    expect(componentStyles.length).toBeGreaterThanOrEqual(40);
    for (const file of componentStyles) {
      const blocks = topLevelStyleBlocks(read(file));
      expect(
        blocks.length,
        `${file} must contain authored rules`,
      ).toBeGreaterThan(0);
      expect(
        blocks.map(({ prelude }) => prelude),
        `${file} must emit only named component rules`,
      ).toEqual(Array(blocks.length).fill('@layer components'));
    }

    const migratedExceptions = UNLAYERED_RULESET_LEDGER.filter(([file]) => {
      const sourceFile = file.replace(/#inline-styles$/u, '');
      return productionSources.includes(sourceFile);
    });
    expect(migratedExceptions).toEqual([]);

    const roomStyles = productionSources
      .filter(
        (file) =>
          file.startsWith(`${migratedRoomsRoot}/`) && file.endsWith('.scss'),
      )
      .map(source)
      .join('\n');
    expect(roomStyles).not.toMatch(
      /var\(--(?:background|foreground|card|popover|primary|secondary|muted|accent|destructive|success|warning|border|input|ring)\b/u,
    );
    expect(roomStyles).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(/iu);
  });
});
