import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import {
  AppLockPinBridge,
  type AppLockDismissal,
} from '@trinity/capacitor-app-lock';
import {
  HOST_SCREEN_PRIVACY_OPERATION,
  HostDeepLinksService,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import { desktopBridgeFixture } from '@trinity/testing';
import { type Observable, firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const privacy = vi.hoisted(() => ({ enable: vi.fn(), disable: vi.fn() }));
vi.mock('@capacitor/privacy-screen', () => ({ PrivacyScreen: privacy }));

import {
  CapacitorScreenPrivacyAdapter,
  PRIVACY_SCREEN_PLUGIN,
  screenPrivacyProvider,
} from './host-screen-privacy.adapters';

describe('CapacitorScreenPrivacyAdapter', () => {
  beforeEach(() => {
    vi.spyOn(Capacitor, 'isPluginAvailable').mockReturnValue(true);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('ios');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  function adapter(
    dismissPresented = vi.fn((): Observable<AppLockDismissal> =>
      of('completed'),
    ),
    closeAuthentication = vi.fn((): Observable<HostOperationOutcome> =>
      of({ kind: 'completed' }),
    ),
  ) {
    TestBed.configureTestingModule({
      providers: [
        CapacitorScreenPrivacyAdapter,
        { provide: AppLockPinBridge, useValue: { dismissPresented } },
        { provide: HostDeepLinksService, useValue: { closeAuthentication } },
      ],
    });
    return {
      adapter: TestBed.inject(CapacitorScreenPrivacyAdapter),
      dismissPresented,
      closeAuthentication,
    };
  }

  it('turns the cover on and off, cold', async () => {
    privacy.enable.mockResolvedValue({ success: true });
    privacy.disable.mockResolvedValue({ success: true });
    const { adapter: screen } = adapter();
    const on = screen.set(true);
    expect(privacy.enable).not.toHaveBeenCalled();
    await expect(firstValueFrom(on)).resolves.toEqual({ kind: 'completed' });
    await expect(firstValueFrom(screen.set(false))).resolves.toEqual({
      kind: 'completed',
    });
    expect(privacy.enable).toHaveBeenCalledExactlyOnceWith({
      ios: { blurEffect: 'dark' },
      android: { dimBackground: true },
    });
    expect(privacy.disable).toHaveBeenCalledOnce();
    expect(Capacitor.isPluginAvailable).toHaveBeenCalledWith(
      PRIVACY_SCREEN_PLUGIN,
    );
  });

  it('reports a refused cover with a stable code', async () => {
    privacy.enable.mockRejectedValue(new Error('activity gone'));
    const { adapter: screen } = adapter();
    await expect(firstValueFrom(screen.set(true))).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'screen-privacy-failed' },
    });
  });

  it('reports an unsuccessful or garbled answer as refused', async () => {
    const { adapter: screen } = adapter();
    privacy.enable.mockResolvedValueOnce({ success: false });
    await expect(firstValueFrom(screen.set(true))).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'screen-privacy-failed' },
    });
    privacy.disable.mockResolvedValueOnce(undefined);
    await expect(firstValueFrom(screen.set(false))).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'screen-privacy-failed' },
    });
  });

  it('reports the cover unavailable when the host lacks the plugin', async () => {
    vi.mocked(Capacitor.isPluginAvailable).mockReturnValue(false);
    const { adapter: screen } = adapter();
    await expect(firstValueFrom(screen.set(true))).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    expect(privacy.enable).not.toHaveBeenCalled();
  });

  it('dismisses native UI Trinity presented', async () => {
    const { adapter: screen, dismissPresented } = adapter();
    const dismissal = screen.dismissPresented();
    expect(dismissPresented).not.toHaveBeenCalled();
    await expect(firstValueFrom(dismissal)).resolves.toEqual({
      kind: 'completed',
    });
    expect(dismissPresented).toHaveBeenCalledOnce();
  });

  it('leaves the browser sheet on iOS to the dismissal', async () => {
    // The Browser plugin's close dismisses whatever the root presents, the privacy cover too.
    const { adapter: screen, closeAuthentication } = adapter();
    await firstValueFrom(screen.dismissPresented());
    expect(closeAuthentication).not.toHaveBeenCalled();
  });

  it('also closes a Custom Tab on Android, which the bridge can’t reach', async () => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue('android');
    const {
      adapter: screen,
      dismissPresented,
      closeAuthentication,
    } = adapter();
    const dismissal = screen.dismissPresented();
    expect(closeAuthentication).not.toHaveBeenCalled();
    await expect(firstValueFrom(dismissal)).resolves.toEqual({
      kind: 'completed',
    });
    expect(dismissPresented).toHaveBeenCalledOnce();
    expect(closeAuthentication).toHaveBeenCalledOnce();
  });

  it('answers the dismissal on Android even when closing the Custom Tab fails', async () => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue('android');
    const { adapter: screen } = adapter(
      vi.fn(() => of<AppLockDismissal>('completed')),
      vi.fn(() => throwError(() => new Error('background activity start'))),
    );
    await expect(firstValueFrom(screen.dismissPresented())).resolves.toEqual({
      kind: 'completed',
    });
  });

  it.each([
    ['failed', { kind: 'rejected', diagnostic: { code: 'dismiss-failed' } }],
    [
      'timed-out',
      { kind: 'rejected', diagnostic: { code: 'dismiss-timeout' } },
    ],
    ['unavailable', { kind: 'unavailable', reason: 'not-supported' }],
  ] as const)(
    'reports the %s dismissal outcome as not completed',
    async (dismissal, outcome) => {
      const { adapter: screen } = adapter(vi.fn(() => of(dismissal)));
      await expect(firstValueFrom(screen.dismissPresented())).resolves.toEqual(
        outcome,
      );
    },
  );
});

describe('screenPrivacyProvider', () => {
  afterEach(() => {
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  function provided() {
    TestBed.configureTestingModule({
      providers: [
        screenPrivacyProvider(),
        {
          provide: AppLockPinBridge,
          useValue: { dismissPresented: () => of('completed') },
        },
      ],
    });
    return TestBed.inject(HOST_SCREEN_PRIVACY_OPERATION);
  }

  it('selects the Capacitor adapter in the native app', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    expect(provided()).toBeInstanceOf(CapacitorScreenPrivacyAdapter);
  });

  it('provides nothing on the web', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    expect(provided()).toBeNull();
  });

  it('provides nothing on the desktop shell', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture();
    expect(provided()).toBeNull();
  });
});
