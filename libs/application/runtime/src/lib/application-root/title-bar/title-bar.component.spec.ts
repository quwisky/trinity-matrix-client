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
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TitleBarComponent } from './title-bar.component';

type BridgeHost = { trinityDesktop?: unknown };

describe('TitleBarComponent', () => {
  afterEach(() => {
    delete (globalThis as BridgeHost).trinityDesktop;
    const root = document.documentElement;
    root.classList.remove('dark');
    root.removeAttribute('data-theme');
    root.style.removeProperty('--trinity-surface-app');
    root.style.removeProperty('--trinity-text');
  });

  async function setup(
    opts: {
      bridge?: boolean;
      platform?: string;
      systemBar?: boolean;
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
            setOverlayColors,
            popupMenu,
            getSystemTitleBar: async () => ({
              saved: false,
              active: opts.systemBar ?? false,
            }),
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
    const { container, state } = await setup({ systemBar: true });

    expect(
      container.querySelector('[data-testid="title-bar-title"]'),
    ).toBeNull();
    expect(state.active()).toBe(false);
  });

  it('asks for the system title bar only after host negotiation settles', async () => {
    const negotiated = new Subject<
      ReturnType<typeof unavailableHostManifest>
    >();
    const getSystemTitleBar = vi.fn(async () => ({
      saved: true,
      active: true,
    }));
    (globalThis as BridgeHost).trinityDesktop = desktopBridgeFixture({
      capabilities: {
        titleBar: { setOverlayColors: vi.fn(), getSystemTitleBar },
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

    expect(getSystemTitleBar).not.toHaveBeenCalled();
    negotiated.next(unavailableHostManifest('not-supported'));
    await fixture.whenStable();
    expect(getSystemTitleBar).toHaveBeenCalledTimes(1);
  });

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

    it('truncates the title and keeps actions inside the overlay area', () => {
      expect(scss).toContain('text-overflow: ellipsis');
      expect(scss).toContain('env(titlebar-area-x');
      expect(scss).toContain('env(titlebar-area-width');
    });
  });
});
