import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signal } from '@angular/core';
import { screen, waitFor } from '@testing-library/angular';
import {
  TitleBarState,
  WORKSPACE_SYSTEM_STATUS,
} from '@trinity/application/workspace';
import { provideTrnIcons } from '@trinity/components/foundations';
import { desktopBridgeFixture, render } from '@trinity/testing';
import {
  HOST_CAPABILITY_NEGOTIATOR,
  unavailableHostManifest,
} from '@trinity/runtime/host';
import { Subject, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TitleBarComponent } from './title-bar.component';

type BridgeHost = { trinityDesktop?: unknown };

describe('TitleBarComponent', () => {
  afterEach(() => {
    delete (globalThis as BridgeHost).trinityDesktop;
    const root = document.documentElement;
    root.classList.remove('dark');
    root.removeAttribute('data-theme');
    root.classList.remove('trn-title-row');
    root.style.removeProperty('--trinity-surface-app');
    root.style.removeProperty('--trinity-text');
  });

  async function setup(
    opts: {
      bridge?: boolean;
      platform?: string;
      mode?: string | null;
      problems?: boolean;
    } = {},
  ) {
    const setOverlayColors = vi.fn();
    const popupMenu = vi.fn();
    const show = vi.fn();
    const root = document.documentElement;
    root.style.setProperty('--trinity-surface-app', 'rgb(18, 18, 20)');
    root.style.setProperty('--trinity-text', 'rgb(219, 222, 225)');
    if (opts.bridge !== false) {
      (globalThis as BridgeHost).trinityDesktop = desktopBridgeFixture({
        platform: opts.platform ?? 'linux',
        capabilities: {
          titleBar: {
            mode: (opts.mode === undefined ? 'row' : opts.mode) as 'row',
            setOverlayColors,
            popupMenu,
          },
        },
      });
    }
    const rendered = await render(TitleBarComponent, {
      providers: [
        provideTrnIcons(),
        {
          provide: WORKSPACE_SYSTEM_STATUS,
          useValue: {
            hasProblems: signal(opts.problems ?? false),
            bannerSlot: signal(null),
            show,
          },
        },
      ],
    });
    const state = rendered.fixture.debugElement.injector.get(TitleBarState);
    await rendered.fixture.whenStable();
    rendered.fixture.detectChanges();
    return { ...rendered, state, setOverlayColors, popupMenu, show };
  }

  it('renders nothing and is inactive without the desktop bridge', async () => {
    const { container, state } = await setup({ bridge: false });

    expect(
      container.querySelector('[data-testid="title-bar-title"]'),
    ).toBeNull();
    expect(state.active()).toBe(false);
  });

  it('renders nothing when the bridge lacks the titleBar capability', async () => {
    const bridge = desktopBridgeFixture();
    (globalThis as BridgeHost).trinityDesktop = {
      ...bridge,
      capabilities: { ...bridge.capabilities, titleBar: undefined },
    };
    const { fixture } = await render(TitleBarComponent, {
      providers: [
        provideTrnIcons(),
        {
          provide: WORKSPACE_SYSTEM_STATUS,
          useValue: {
            hasProblems: signal(false),
            bannerSlot: signal(null),
            show: vi.fn(),
          },
        },
      ],
    });
    await fixture.whenStable();

    expect(
      fixture.nativeElement.querySelector('[data-testid="title-bar-title"]'),
    ).toBeNull();
    expect(fixture.debugElement.injector.get(TitleBarState).active()).toBe(
      false,
    );
  });

  it('renders nothing while the OS title bar is in use', async () => {
    const { container, state } = await setup({ mode: 'system' });

    expect(
      container.querySelector('[data-testid="title-bar-title"]'),
    ).toBeNull();
    expect(state.active()).toBe(false);
    expect(document.documentElement.classList).not.toContain('trn-title-row');
  });

  it.each([null, 'frame'])(
    'never draws the row over an OS bar when the launch mode is %s',
    async (mode) => {
      const { container, state } = await setup({ mode });

      expect(
        container.querySelector('[data-testid="title-bar-title"]'),
      ).toBeNull();
      expect(state.active()).toBe(false);
    },
  );

  it('draws the row at first render, before negotiation and without asking the host', async () => {
    const negotiated = new Subject<
      ReturnType<typeof unavailableHostManifest>
    >();
    const getSystemTitleBar = vi.fn(async () => ({
      saved: false,
      active: false,
    }));
    const setOverlayColors = vi.fn();
    const root = document.documentElement;
    root.style.setProperty('--trinity-surface-app', 'rgb(18, 18, 20)');
    root.style.setProperty('--trinity-text', 'rgb(219, 222, 225)');
    (globalThis as BridgeHost).trinityDesktop = desktopBridgeFixture({
      capabilities: {
        titleBar: { mode: 'row', setOverlayColors, getSystemTitleBar },
      },
    });
    const { fixture } = await render(TitleBarComponent, {
      providers: [
        provideTrnIcons(),
        {
          provide: HOST_CAPABILITY_NEGOTIATOR,
          useValue: { manifest: () => negotiated },
        },
        {
          provide: WORKSPACE_SYSTEM_STATUS,
          useValue: {
            hasProblems: signal(false),
            bannerSlot: signal(null),
            show: vi.fn(),
          },
        },
      ],
    });

    expect(screen.getByTestId('title-bar-title')).toBeTruthy();
    expect(fixture.debugElement.injector.get(TitleBarState).active()).toBe(
      true,
    );
    expect(getSystemTitleBar).not.toHaveBeenCalled();
    // The overlay grant arrives with negotiation; colours wait for it.
    expect(setOverlayColors).not.toHaveBeenCalled();
    negotiated.next(unavailableHostManifest('not-supported'));
    await waitFor(() => expect(setOverlayColors).toHaveBeenCalledTimes(1));
  });

  it('keeps the row when negotiation fails', async () => {
    const setOverlayColors = vi.fn();
    const root = document.documentElement;
    root.style.setProperty('--trinity-surface-app', 'rgb(18, 18, 20)');
    root.style.setProperty('--trinity-text', 'rgb(219, 222, 225)');
    (globalThis as BridgeHost).trinityDesktop = desktopBridgeFixture({
      capabilities: { titleBar: { mode: 'row', setOverlayColors } },
    });
    const { fixture } = await render(TitleBarComponent, {
      providers: [
        provideTrnIcons(),
        {
          provide: HOST_CAPABILITY_NEGOTIATOR,
          useValue: { manifest: () => throwError(() => new Error('down')) },
        },
        {
          provide: WORKSPACE_SYSTEM_STATUS,
          useValue: {
            hasProblems: signal(false),
            bannerSlot: signal(null),
            show: vi.fn(),
          },
        },
      ],
    });
    await fixture.whenStable();

    expect(screen.getByTestId('title-bar-title')).toBeTruthy();
    expect(setOverlayColors).not.toHaveBeenCalled();
  });

  it.each(['linux', 'darwin'])(
    'moves overlays below the row on %s while it shows',
    async (platform) => {
      const { fixture } = await setup({ platform });

      expect(document.documentElement.classList).toContain('trn-title-row');
      fixture.destroy();
      expect(document.documentElement.classList).not.toContain('trn-title-row');
    },
  );

  it('shows the title and marks the row active on a frameless desktop window', async () => {
    const { state } = await setup();

    expect(screen.getByTestId('title-bar-title').textContent).toBe(
      state.title(),
    );
    expect(state.active()).toBe(true);
  });

  it('opens the app menu at the menu button bottom-left on win32/linux', async () => {
    const { popupMenu } = await setup();
    const button = screen.getByTestId('title-bar-menu');
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      left: 8.4,
      bottom: 31.6,
    } as DOMRect);

    button.click();

    expect(popupMenu).toHaveBeenCalledWith({ x: 8, y: 32 });
  });

  it('reserves traffic-light space and drops the menu on macOS', async () => {
    const { fixture } = await setup({ platform: 'darwin' });

    expect(screen.queryByTestId('title-bar-menu')).toBeNull();
    expect(fixture.nativeElement.classList).toContain('title-bar--mac');
  });

  it('runs the quick switcher when the room provides one, and hides it otherwise', async () => {
    const { state, fixture } = await setup();
    expect(screen.queryByTestId('title-bar-switcher')).toBeNull();

    const open = vi.fn();
    state.setContext({ title: 'Room', quickSwitcher: open });
    fixture.detectChanges();
    screen.getByTestId('title-bar-switcher').click();

    expect(open).toHaveBeenCalledOnce();
  });

  it('hides the status warning while nothing is wrong', async () => {
    await setup();

    expect(screen.queryByTestId('title-bar-status')).toBeNull();
  });

  it('shows the status warning while there are problems and opens the status page', async () => {
    const { show } = await setup({ problems: true });
    screen.getByTestId('title-bar-status').click();

    expect(show).toHaveBeenCalledOnce();
  });

  it('sends hex overlay colours and resends them when the theme changes', async () => {
    const { setOverlayColors } = await setup();
    expect(setOverlayColors).toHaveBeenLastCalledWith({
      color: '#121214',
      symbolColor: '#dbdee1',
    });

    const root = document.documentElement;
    root.style.setProperty('--trinity-surface-app', 'rgb(250, 250, 250)');
    root.classList.add('dark');

    await waitFor(() =>
      expect(setOverlayColors).toHaveBeenLastCalledWith({
        color: '#fafafa',
        symbolColor: '#dbdee1',
      }),
    );
  });

  describe('styles', () => {
    const scss = readFileSync(
      join(import.meta.dirname, 'title-bar.component.scss'),
      'utf8',
    );

    it('drags the row and keeps buttons clickable', () => {
      expect(scss).toContain('-webkit-app-region: drag');
      expect(scss).toMatch(
        /\.title-bar__button\s*{[^}]*-webkit-app-region: no-drag/,
      );
    });

    it('follows the native overlay height so zoom keeps the row and buttons aligned', () => {
      expect(scss).toMatch(
        /height: env\(\s*titlebar-area-height,\s*var\(--trinity-title-bar-height\)\s*\)/,
      );
    });

    it('starts viewport-fixed layers below the row while it shows', () => {
      const workspaceRoot = join(import.meta.dirname, '../../../../../../..');
      const read = (file: string) =>
        readFileSync(join(workspaceRoot, file), 'utf8');
      const inset = 'inset-block-start: var(--trinity-title-row-inset, 0)';

      expect(read('apps/trinity/src/global.scss')).toMatch(
        /\.trn-title-row\s*{\s*--trinity-title-row-inset: env\(\s*titlebar-area-height,\s*var\(--trinity-title-bar-height\)\s*\);/,
      );
      expect(read('apps/trinity/src/global.scss')).toMatch(
        /\.cdk-overlay-container\s*{[^}]*inset-block: var\(--trinity-title-row-inset, 0\) 0;/,
      );
      for (const file of [
        'libs/application/runtime/src/lib/application-root/system-status/system-status.component.scss',
        'libs/feature/rooms/src/lib/rooms/rooms.page.scss',
      ]) {
        expect(read(file), file).toContain(inset);
      }
      expect(
        read('libs/feature/rooms/src/lib/rooms/rooms.page.html'),
      ).toContain('top-[var(--trinity-title-row-inset,0px)]');
      expect(
        read(
          'libs/feature/rooms/src/lib/media-attachment/lightbox/lightbox.component.scss',
        ),
      ).toContain('calc(100dvh - var(--trinity-title-row-inset, 0px))');
    });

    it('truncates the title and keeps actions inside the overlay area', () => {
      expect(scss).toContain('text-overflow: ellipsis');
      expect(scss).toContain('env(titlebar-area-x');
      expect(scss).toContain('env(titlebar-area-width');
    });
  });
});
