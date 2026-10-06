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

  it('exposes the conversation column as the page main landmark', () => {
    expect(roomsHtml).toMatch(/<main\b[^>]*#mainView[^>]*class="main"/);
    expect(roomsHtml).not.toContain('<div #mainView');
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

  it('sets the conversation in a rounded inset pane on the app ground', () => {
    const app = 'var(--trinity-surface-app)';
    const sidebarSurface = 'var(--trinity-surface-sidebar)';
    for (const selector of [
      '.rooms-shell',
      '.rooms-workspace',
      '.shell-side',
    ]) {
      expect(ruleBody(roomsCss, selector)).toContain(`background: ${app}`);
    }
    expect(ruleBody(railCss, '.rail')).toContain(app);
    expect(ruleBody(sidebarCss, '.sidebar')).toContain(sidebarSurface);
    expect(ruleBody(sidebarCss, '.sidebar__header')).toContain(
      'background: var(--trinity-surface-navigation-header)',
    );
    expect(ruleBody(userPanelCss, '.userbar')).toContain(
      'background: var(--trinity-surface-navigation-header)',
    );
    // Rail tiles must read against the rail ground, so never paint them with it.
    expect(ruleBody(railCss, '.pill')).toContain(
      'background: var(--trinity-state-hover-surface)',
    );
    expect(ruleBody(railCss, '.pill')).not.toContain(
      'background: var(--trinity-surface-app)',
    );
    // Classic keeps today's sidebar tone; every other Theme inherits the app ground.
    expect(variables).toMatch(
      /--trinity-surface-sidebar:\s*var\(--trinity-surface-app\)/,
    );
    for (const selector of [
      ":root[data-theme='classic']:not(.dark)",
      ":root[data-theme='classic'].dark",
    ]) {
      expect(ruleBody(variables, selector), selector).toContain(
        '--trinity-surface-sidebar:',
      );
    }

    const main = ruleBody(roomsCss, '.main');
    expect(main).toContain('background: var(--trinity-surface-pane)');
    // The rounded corner must not be a radius on `.main`: `.main` clips with overflow:hidden,
    // and a rounded clip around the composited timeline forces an offscreen render pass that
    // costs ~430 MB of GPU IOSurface memory on macOS. The corner is painted by an unclipped mask.
    expect(main).not.toMatch(/border(-[a-z-]+)?-radius/);
    const corner = ruleBody(roomsCss, '.main::before');
    expect(corner).toContain('pointer-events: none');
    expect(roomsCss).toContain('--corner: var(--trinity-shape-pane-radius)');
    expect(corner).toMatch(/radial-gradient\(/);
    // The straight 1px edges are overlays too: .main's own inset shadows paint under the
    // header and timeline backgrounds, so the arc would otherwise float on its own.
    expect(corner).toMatch(/linear-gradient\(/);
    const topEdge = ruleBody(roomsCss, '.main::after');
    expect(topEdge).toContain('pointer-events: none');
    expect(topEdge).toContain('block-size: 1px');
    expect(roomsCss).toMatch(
      /@media\s+#\{\$md\}\s*\{[^]*?\.main::before[^]*?\.main::after/,
    );
    expect(ruleBody(roomsCss, '.chat-body')).toContain(
      'background: var(--trinity-surface-pane)',
    );
    expect(variables).toMatch(
      /--trinity-shape-pane-radius:\s*var\(--trinity-radius-xl\)/,
    );
  });

  it('defines cosy, compact and spacious shell density recipes', () => {
    for (const token of [
      '--trinity-density-shell-gap',
      '--trinity-density-shell-padding-inline',
      '--trinity-density-channel-padding-block',
    ]) {
      // One declaration per density block: base, compact and spacious.
      expect(variables.match(new RegExp(`${token}\\s*:`, 'g'))?.length).toBe(3);
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
      /\.shell-side\s*\{[^}]*position:\s*relative;[^}]*display:\s*grid;[^}]*width:\s*100%;[^}]*--trinity-navigation-dock-height:\s*60px;[^}]*@media\s+#\{\$md\}\s*\{[^}]*width:\s*var\(--shell-sidebar-w,\s*352px\);/s,
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
      /\.userbar\s*\{[\s\S]*?@media\s+#\{\$md\}\s*\{[\s\S]*?border-radius:\s*var\(--trinity-shape-overlay-radius\);[\s\S]*?background:\s*var\(--trinity-surface-floating-card\);[\s\S]*?box-shadow:\s*var\(--trinity-shadow-floating\);/,
    );
  });

  it('keeps generic interaction guards weaker than specialized consumer states', () => {
    expect(roomMixins).toContain('&:hover:where(:not(:disabled))');
    expect(roomMixins).toContain('&:active:where(:not(:disabled))');
  });

  it('sizes the members list to its bordered host instead of overflowing it', () => {
    // `.chat-members` is 240px border-box with a 1px inline-start border, so a fixed 240px
    // list inside it overflows by that pixel.
    const members = ruleBody(
      read('libs/feature/rooms/src/lib/member-list/member-list.component.scss'),
      '.members',
    );
    expect(members).toContain('width: 100%');
    expect(members).not.toContain('width: 240px');
  });

  it('gives every right-hand panel one surface and one inline-start border', () => {
    expect(globalCss).not.toContain('.panel-header');
    for (const selector of ['.chat-members', '.chat-panel']) {
      const body = ruleBody(roomsCss, selector);
      expect(body, selector).toContain(
        'background: var(--trinity-surface-panel)',
      );
      expect(body, selector).toContain(
        'border-inline-start: 1px solid var(--trinity-border-subtle)',
      );
      expect(body, selector).not.toContain('box-shadow');
    }
  });
});
