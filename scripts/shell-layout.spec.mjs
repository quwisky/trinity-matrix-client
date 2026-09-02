import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  sourceStyleBlockAt,
  stripSourceComments,
} from './source-style-blocks.mjs';

/**
 * Source-shape invariants for the room shell redesign.
 *
 * The pane widths and virtual-list measurements are contracts, not styling preferences.
 * Layout tests prove the built app still honours them; this guard makes the source of those
 * measurements explicit so a later density pass cannot silently make the virtual scrollbar
 * drift or clip the shell's outward focus rings and negative-margin resize handles.
 */

const root = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(root, file), 'utf8');
const ruleBody = (source, selector) => {
  const css = stripSourceComments(source);
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`${escapedSelector}\\s*\\{`, 'u').exec(css);
  if (!match) return undefined;
  const openingBrace = match.index + match[0].lastIndexOf('{');
  return sourceStyleBlockAt(css, openingBrace).body;
};

const variables = read('libs/theme-foundation/styles/internal/variables.scss');
const roomsHtml = read('libs/feature/rooms/src/lib/rooms/rooms.page.html');
const roomsCss = read('libs/feature/rooms/src/lib/rooms/rooms.page.scss');
const roomMixins = read('libs/feature/rooms/src/lib/styles/_mixins.scss');
const globalCss = read('apps/trinity/src/global.scss');
const memberTs = read(
  'libs/feature/rooms/src/lib/member-list/member-list.component.ts',
);
const memberCss = read(
  'libs/feature/rooms/src/lib/member-list/member-list.component.scss',
);
const railCss = read(
  'libs/feature/rooms/src/lib/server-rail/server-rail.component.scss',
);
const sidebarCss = read(
  'libs/feature/rooms/src/lib/channel-sidebar/channel-sidebar.component.scss',
);
const roomListCss = read(
  'libs/feature/rooms/src/lib/channel-sidebar/sidebar-room-list/sidebar-room-list.component.scss',
);
const userPanelCss = read(
  'libs/feature/rooms/src/lib/channel-sidebar/sidebar-user-panel/sidebar-user-panel.component.scss',
);

describe('modern room shell layout contracts', () => {
  it('pins member virtualization constants to fixed CSS boxes', () => {
    expect(memberTs).toMatch(/const HEADER_PX = 34;/);
    expect(memberTs).toMatch(/const ROW_PX = 44;/);
    expect(memberCss).toMatch(
      /\.members__section-label\s*\{[^}]*box-sizing:\s*border-box;[^}]*height:\s*34px;/s,
    );
    expect(memberCss).toMatch(
      /\.member\s*\{[^}]*box-sizing:\s*border-box;[^}]*height:\s*44px;/s,
    );
  });

  it('recesses the workspace without changing or clipping shell geometry', () => {
    expect(roomsHtml).toMatch(/class="rooms-workspace flex min-h-0 flex-1"/);
    expect(roomsCss).toMatch(
      /\.rooms-workspace\s*\{[^}]*background:[^}]*box-shadow:/s,
    );

    for (const selector of ['.rooms-workspace', '.shell-side']) {
      const block = ruleBody(roomsCss, selector);
      expect(block, `${selector} must have a rule`).toBeDefined();
      expect(
        block,
        `${selector} must not clip handles or focus rings`,
      ).not.toMatch(/overflow\s*:\s*(hidden|clip)/);
    }
  });

  it('defines both cosy and compact shell density recipes', () => {
    for (const token of [
      '--trinity-density-shell-gap',
      '--trinity-density-shell-padding-inline',
      '--trinity-density-channel-padding-block',
    ]) {
      expect(variables.match(new RegExp(`${token}\\s*:`, 'g'))?.length).toBe(2);
    }
  });

  it('keeps every raw shell control on the shared coarse-pointer floor', () => {
    const controls = [
      [railCss, '.pill'],
      [sidebarCss, '.sidebar__action'],
      [sidebarCss, '.sidebar__filter-clear'],
      [roomListCss, '.invite__btn'],
      [roomListCss, '.channel'],
      [roomListCss, '.channel__menu'],
      [userPanelCss, '.userbar__trigger'],
      [userPanelCss, '.userbar__settings'],
    ];

    for (const [source, selector] of controls) {
      const rule = ruleBody(source, selector);
      expect(rule, `${selector} must have a rule`).toBeDefined();
      expect(rule, `${selector} must consume the shared touch floor`).toContain(
        'var(--trinity-interaction-target-min-size)',
      );
    }
  });

  it('gives the desktop identity dock one shared floating geometry contract', () => {
    expect(roomsHtml).not.toMatch(/class="[^"]*shell-side[^"]*\bw-full\b/);
    expect(roomsCss).toMatch(
      /\.shell-side\s*\{[^}]*position:\s*relative;[^}]*display:\s*grid;[^}]*width:\s*100%;[^}]*--trinity-navigation-dock-height:\s*52px;[^}]*@media\s+#\{\$md\}\s*\{[^}]*width:\s*var\(--shell-sidebar-w,\s*352px\);/s,
    );
    expect(roomsCss).toMatch(
      /--trinity-navigation-safe-area-bottom:\s*env\(safe-area-inset-bottom\);[\s\S]*?padding-bottom:\s*var\(--trinity-navigation-safe-area-bottom\);/,
    );
    expect(roomsHtml).toMatch(
      /<trn-server-rail[\s\S]*class="shell-side__rail"[\s\S]*<trn-channel-sidebar[\s\S]*class="shell-side__rooms"[\s\S]*<trn-sidebar-user-panel[\s\S]*class="shell-side__dock"/,
    );
    expect(sidebarCss).toMatch(
      /\.sidebar__scroll\s*\{[\s\S]*?@media\s+#\{\$md\}\s*\{[\s\S]*?padding-block-end:\s*calc\([\s\S]*?var\(--trinity-navigation-dock-height\)[\s\S]*?scroll-padding-block-end:\s*calc\([\s\S]*?var\(--trinity-navigation-dock-height\)/,
    );
    expect(railCss).toMatch(
      /\.rail\s*\{[\s\S]*?@media\s+#\{\$md\}\s*\{[\s\S]*?padding-block-end:\s*calc\([\s\S]*?var\(--trinity-navigation-dock-height\)[\s\S]*?scroll-padding-block-end:\s*calc\([\s\S]*?var\(--trinity-navigation-dock-height\)/,
    );
    expect(userPanelCss).toMatch(
      /:host\s*\{[\s\S]*?height:\s*var\(--trinity-navigation-dock-height\);[\s\S]*?@media\s+#\{\$md\}\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1;[\s\S]*?position:\s*absolute;[\s\S]*?inset-inline:[^;]+;[\s\S]*?inset-block-end:\s*calc\([\s\S]*?var\(--trinity-navigation-safe-area-bottom\)/,
    );
    expect(userPanelCss).toMatch(
      /\.userbar\s*\{[\s\S]*?@media\s+#\{\$md\}\s*\{[\s\S]*?border-radius:\s*var\(--trinity-shape-container-radius\);[\s\S]*?background:\s*var\(--trinity-surface-floating\);[\s\S]*?box-shadow:\s*var\(--trinity-shadow-floating\);/,
    );
  });

  it('keeps generic interaction guards weaker than specialized consumer states', () => {
    expect(roomMixins).toContain('&:hover:where(:not(:disabled))');
    expect(roomMixins).toContain('&:active:where(:not(:disabled))');
    expect(sidebarCss).toMatch(
      /\.joinable__action\s*\{[\s\S]*?&:hover\s*\{[\s\S]*?background:\s*var\(--trinity-active\)/,
    );
  });

  it('leaves right-panel separators with one paint owner', () => {
    const panelHeader = ruleBody(globalCss, '.panel-header');
    const chatPanel = ruleBody(roomsCss, '.chat-panel');
    expect(panelHeader).toBeDefined();
    expect(chatPanel).toBeDefined();
    expect(panelHeader).not.toContain('box-shadow');
    expect(chatPanel).not.toContain('box-shadow');
  });
});
