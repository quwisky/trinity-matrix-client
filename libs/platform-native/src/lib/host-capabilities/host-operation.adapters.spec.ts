import type { Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SwUpdate } from '@angular/service-worker';
import {
  HOST_AUTHENTICATION_HANDOFF_OPERATION,
  HOST_LIFECYCLE_OPERATION,
  HostAuthenticationHandoffService,
  HostCapabilitiesService,
  HostDeepLinksService,
  HostLifecycleService,
  unavailableHostManifest,
} from '@trinity/runtime/host';
import {
  desktopBridgeFixture,
  type DesktopBridgeFixture,
} from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileSaveService } from '../host-media/file-save.service';
import { WebHostCapabilityAdapter } from './host-capability.adapters';
import {
  CapacitorHostOperationAdapter,
  DocumentHostLifecycleAdapter,
  ElectronHostLifecycleAdapter,
  HostFileExportAdapter,
  ServiceWorkerHostUpdatesAdapter,
  hostOperationProviders,
} from './host-operation.adapters';

const app = vi.hoisted(() => ({
  addListener: vi.fn(),
  getLaunchUrl: vi.fn(),
  minimizeApp: vi.fn(),
}));

const browser = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  addListener: vi.fn(),
}));

const cap = vi.hoisted(() => ({ native: true, platform: 'android' }));

vi.mock('@capacitor/app', () => ({ App: app }));
vi.mock('@capacitor/browser', () => ({ Browser: browser }));
vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => ({})),
  Capacitor: {
    isNativePlatform: () => cap.native,
    getPlatform: () => cap.platform,
  },
}));

describe('CapacitorHostOperationAdapter event streams', () => {
  beforeEach(() => {
    app.addListener.mockReset();
    app.getLaunchUrl.mockReset();
    app.minimizeApp.mockReset();
    app.getLaunchUrl.mockResolvedValue(null);
    cap.native = true;
    cap.platform = 'android';
  });

  it('routes rejected deep-link listener setup through the Observable error channel', async () => {
    const failure = new Error('listener setup failed');
    app.addListener.mockRejectedValue(failure);

    await expect(
      firstValueFrom(new CapacitorHostOperationAdapter().received),
    ).rejects.toBe(failure);
  });

  it('routes rejected launch URL reads through the Observable error channel', async () => {
    const failure = new Error('launch URL failed');
    app.addListener.mockImplementation(() => new Promise(() => undefined));
    app.getLaunchUrl.mockRejectedValue(failure);

    await expect(
      firstValueFrom(new CapacitorHostOperationAdapter().received),
    ).rejects.toBe(failure);
  });

  it('delivers the cold-start launch URL once across listener re-attachments', async () => {
    app.addListener.mockResolvedValue({
      remove: vi.fn(() => Promise.resolve()),
    });
    app.getLaunchUrl.mockResolvedValue({
      url: 'dev.trinityproject.trinity://matrix.to/#/!a:b.c',
    });
    const adapter = new CapacitorHostOperationAdapter();
    const urls: string[] = [];

    const first = adapter.received.subscribe(({ url }) => urls.push(url));
    await new Promise((resolve) => setTimeout(resolve));
    first.unsubscribe();
    adapter.received.subscribe(({ url }) => urls.push(url));
    await new Promise((resolve) => setTimeout(resolve));

    expect(urls).toEqual(['dev.trinityproject.trinity://matrix.to/#/!a:b.c']);
  });

  describe('cold-start link and later taps', () => {
    const link = 'dev.trinityproject.trinity://matrix.to/#/!a:b.c';
    let open!: (event: { url: string }) => void;
    const urls: string[] = [];

    const attach = async (retained: boolean, launch: string | null) => {
      urls.length = 0;
      app.addListener.mockImplementation(
        (_event: string, listener: (event: { url: string }) => void) => {
          open = listener;
          if (retained) listener({ url: link });
          return Promise.resolve({ remove: vi.fn(() => Promise.resolve()) });
        },
      );
      app.getLaunchUrl.mockResolvedValue(launch ? { url: launch } : {});
      new CapacitorHostOperationAdapter().received.subscribe(({ url }) =>
        urls.push(url),
      );
      await new Promise((resolve) => setTimeout(resolve));
    };

    it('delivers a cold-start link once when the retained appUrlOpen flushes during addListener', async () => {
      // Models Android: the retained launch event fires synchronously on the first listener.
      await attach(true, link);

      expect(urls).toEqual([link]);
    });

    it('delivers a later tap of the same URL after a retained launch event', async () => {
      await attach(true, link);
      open({ url: link });

      expect(urls).toEqual([link, link]);
    });

    it('delivers a later tap of the same URL after a getLaunchUrl-only launch', async () => {
      await attach(false, link);
      open({ url: link });

      expect(urls).toEqual([link, link]);
    });

    it('delivers a different URL after the launch link', async () => {
      const other = 'dev.trinityproject.trinity://matrix.to/#/!d:e.f';
      await attach(true, link);
      open({ url: other });

      expect(urls).toEqual([link, other]);
    });

    it('delivers a getLaunchUrl-only launch once', async () => {
      await attach(false, link);

      expect(urls).toEqual([link]);
    });
  });

  it('removes a Back listener that resolves after teardown', async () => {
    let resolveListener!: (value: { remove: () => Promise<void> }) => void;
    const remove = vi.fn(() => Promise.resolve());
    app.addListener.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveListener = resolve;
        }),
    );
    const subscription =
      new CapacitorHostOperationAdapter().intents.subscribe();

    subscription.unsubscribe();
    resolveListener({ remove });
    await Promise.resolve();
    await Promise.resolve();

    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('reports the sign-in sheet closed when the person closes it', async () => {
    let finished: () => void = () => undefined;
    const remove = vi.fn(() => Promise.resolve());
    browser.addListener
      .mockReset()
      .mockImplementation((_event: string, listener: () => void) => {
        finished = listener;
        return Promise.resolve({ remove });
      });
    const closed = vi.fn();
    const subscription =
      new CapacitorHostOperationAdapter().sheetClosed.subscribe(closed);
    await Promise.resolve();

    expect(browser.addListener).toHaveBeenCalledWith(
      'browserFinished',
      expect.any(Function),
    );
    finished();
    expect(closed).toHaveBeenCalledOnce();
    subscription.unsubscribe();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('removes a browserFinished listener that resolves after teardown', async () => {
    let resolveListener!: (value: { remove: () => Promise<void> }) => void;
    const remove = vi.fn(() => Promise.resolve());
    browser.addListener.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveListener = resolve;
        }),
    );
    const subscription =
      new CapacitorHostOperationAdapter().sheetClosed.subscribe();

    subscription.unsubscribe();
    resolveListener({ remove });
    await Promise.resolve();
    await Promise.resolve();

    expect(remove).toHaveBeenCalledOnce();
  });

  it('reports Back and backgrounding unavailable on iOS', async () => {
    cap.platform = 'ios';
    const adapter = new CapacitorHostOperationAdapter();
    const completed = vi.fn();

    adapter.intents.subscribe({ complete: completed });

    await expect(firstValueFrom(adapter.backSupport())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    await expect(firstValueFrom(adapter.background())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(app.addListener).not.toHaveBeenCalled();
    expect(app.minimizeApp).not.toHaveBeenCalled();
  });
});

describe('file, lifecycle and update host operation contracts', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  function manifest() {
    const value = unavailableHostManifest('not-implemented');
    return {
      ...value,
      operations: {
        ...value.operations,
        'file-export': { kind: 'supported' as const },
        lifecycle: { kind: 'supported' as const },
      },
    };
  }

  function fileExportAdapter(save: FileSaveService['save']) {
    TestBed.configureTestingModule({
      providers: [
        HostFileExportAdapter,
        MockProvider(HostCapabilitiesService, {
          manifest: () => of(manifest()),
        }),
        MockProvider(FileSaveService, { save }),
      ],
    });
    return TestBed.inject(HostFileExportAdapter);
  }

  it('keeps file export cold, finite and normalized through the selected host adapter', async () => {
    const save = vi.fn(() => of('saved' as const));
    const adapter = fileExportAdapter(save);
    const request = { bytes: new Blob(['safe']), filename: 'safe.txt' };
    const command = adapter.save(request);

    expect(save).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'completed',
    });
    expect(save).toHaveBeenCalledExactlyOnceWith(
      request.bytes,
      request.filename,
    );
  });

  it('reports a dismissed native save as cancelled, never completed', async () => {
    fileExportAdapter(() => of('cancelled' as const));

    await expect(
      firstValueFrom(
        TestBed.inject(HostFileExportAdapter).save({
          bytes: new Blob(['safe']),
          filename: 'safe.txt',
        }),
      ),
    ).resolves.toEqual({ kind: 'cancelled' });
  });

  it('contains file-host failures behind a secret-safe rejection', async () => {
    fileExportAdapter(() => throwError(() => new Error('secret file payload')));

    await expect(
      firstValueFrom(
        TestBed.inject(HostFileExportAdapter).save({
          bytes: new Blob(['secret']),
          filename: 'secret.txt',
        }),
      ),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'file-export-failed' },
    });
  });

  it('projects document foregrounding through the lifecycle contract', async () => {
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('visible');
    const adapter = TestBed.inject(DocumentHostLifecycleAdapter);
    const active = firstValueFrom(adapter.events);

    document.dispatchEvent(new Event('visibilitychange'));

    await expect(active).resolves.toEqual({ kind: 'active' });
    visibility.mockReturnValue('hidden');
    const background = firstValueFrom(adapter.events);
    document.dispatchEvent(new Event('visibilitychange'));
    await expect(background).resolves.toEqual({ kind: 'background' });
  });

  describe('on the desktop shell', () => {
    const visibility: { emit: (value: 'visible' | 'hidden') => void } = {
      emit: () => undefined,
    };
    const releaseMemory = vi.fn();
    const unsubscribe = vi.fn();

    beforeEach(() => {
      visibility.emit = () => undefined;
      releaseMemory.mockClear();
      unsubscribe.mockClear();
      (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
        desktopBridgeFixture({
          capabilities: {
            lifecycle: {
              subscribeVisibility: (callback) => {
                visibility.emit = callback;
                return unsubscribe;
              },
              releaseMemory,
            },
          },
        });
    });

    afterEach(() => {
      delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    });

    function configure(lifecycle: 'supported' | 'unavailable') {
      const value = manifest();
      TestBed.configureTestingModule({
        providers: [
          hostOperationProviders(),
          MockProvider(HostCapabilitiesService, {
            manifest: () =>
              of({
                ...value,
                operations: {
                  ...value.operations,
                  lifecycle:
                    lifecycle === 'supported'
                      ? { kind: 'supported' as const }
                      : {
                          kind: 'unavailable' as const,
                          reason: 'not-implemented' as const,
                        },
                },
              }),
          }),
        ],
      });
      return TestBed.inject(HostLifecycleService);
    }

    it('selects the Electron lifecycle adapter', () => {
      configure('supported');
      expect(TestBed.inject(HOST_LIFECYCLE_OPERATION)).toBeInstanceOf(
        ElectronHostLifecycleAdapter,
      );
    });

    it('maps window visibility from the shell onto background and active', () => {
      const seen: string[] = [];
      const subscription = configure('supported').events.subscribe((event) =>
        seen.push(event.kind),
      );

      visibility.emit('hidden');
      visibility.emit('hidden');
      visibility.emit('visible');
      subscription.unsubscribe();

      expect(seen).toEqual(['background', 'active']);
      expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('asks the shell to release memory only when lifecycle is granted', async () => {
      const command = configure('supported').releaseMemory();
      expect(releaseMemory).not.toHaveBeenCalled();

      await expect(firstValueFrom(command)).resolves.toEqual({
        kind: 'completed',
      });
      expect(releaseMemory).toHaveBeenCalledOnce();
    });

    it('stays silent and inert while lifecycle is unavailable', async () => {
      const lifecycle = configure('unavailable');
      const seen = vi.fn();
      lifecycle.events.subscribe(seen);
      visibility.emit('hidden');

      await expect(firstValueFrom(lifecycle.releaseMemory())).resolves.toEqual({
        kind: 'unavailable',
        reason: 'not-implemented',
      });
      expect(seen).not.toHaveBeenCalled();
      expect(releaseMemory).not.toHaveBeenCalled();
    });
  });

  it('reports memory release unsupported in a plain document', async () => {
    TestBed.configureTestingModule({ providers: [hostOperationProviders()] });
    await expect(
      firstValueFrom(TestBed.inject(HostLifecycleService).releaseMemory()),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'not-supported' });
  });

  function updatesAdapter(
    isEnabled: boolean,
    checkForUpdate: SwUpdate['checkForUpdate'],
    ...extra: Provider[]
  ) {
    TestBed.configureTestingModule({
      providers: [
        ...extra,
        ServiceWorkerHostUpdatesAdapter,
        MockProvider(SwUpdate, { isEnabled, checkForUpdate }),
      ],
    });
    return TestBed.inject(ServiceWorkerHostUpdatesAdapter);
  }

  it('returns explicit update unavailability when this host has no service worker', async () => {
    const checkForUpdate = vi.fn();
    const command = updatesAdapter(false, checkForUpdate).check();

    expect(checkForUpdate).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    expect(checkForUpdate).not.toHaveBeenCalled();
  });

  it('runs a supported update check lazily through the shared operation', async () => {
    const checkForUpdate = vi.fn().mockResolvedValue(true);
    const command = updatesAdapter(true, checkForUpdate).check();

    expect(checkForUpdate).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'completed',
    });
    expect(checkForUpdate).toHaveBeenCalledOnce();
  });

  it('rejects a supported update check that never settles', async () => {
    vi.useFakeTimers();
    const checkForUpdate = vi.fn(() => new Promise<boolean>(() => undefined));
    const result = firstValueFrom(updatesAdapter(true, checkForUpdate).check());

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'update-check-timeout' },
    });
  });

  it('keeps Web update discovery aligned with the shared operation', async () => {
    const checkForUpdate = vi.fn().mockResolvedValue(true);
    const adapter = updatesAdapter(
      true,
      checkForUpdate,
      WebHostCapabilityAdapter,
    );
    const manifest = await firstValueFrom(
      TestBed.inject(WebHostCapabilityAdapter).manifest(),
    );
    const command = adapter.check();

    expect(manifest.operations.updates).toEqual({ kind: 'supported' });
    expect(checkForUpdate).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'completed',
    });
    expect(checkForUpdate).toHaveBeenCalledOnce();
  });
});

describe('Electron app identity', () => {
  const NEXT = {
    channel: 'next',
    deepLinkScheme: 'dev.trinityproject.trinity.next',
    displayName: 'Trinity Next',
  } as const;
  const SSO = {
    webUrl: 'trinity://app/sso-callback',
    appUrl: 'dev.trinityproject.trinity://sso-callback',
  };
  const OIDC = {
    webUrl: 'trinity://app/sso-callback',
    appUrl: 'dev.trinityproject.trinity:/sso-callback',
  };
  let emit: (url: string) => void = () => undefined;

  function configure(appIdentity: DesktopBridgeFixture['appIdentity']) {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture({
        appIdentity,
        capabilities: {
          deepLinks: {
            subscribe: (callback) => {
              emit = callback;
              return () => undefined;
            },
          },
        },
      });
    const value = unavailableHostManifest('not-implemented');
    TestBed.configureTestingModule({
      providers: [
        hostOperationProviders(),
        MockProvider(HostCapabilitiesService, {
          manifest: () =>
            of({
              ...value,
              operations: {
                ...value.operations,
                'deep-links': { kind: 'supported' as const },
              },
            }),
        }),
      ],
    });
  }

  function receivedUrls(emitLinks: () => void) {
    const urls: string[] = [];
    const subscription = TestBed.inject(
      HostDeepLinksService,
    ).received.subscribe(({ url }) => urls.push(url));
    emitLinks();
    subscription.unsubscribe();
    return urls;
  }

  afterEach(() => {
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
  });

  it('sends sign-in callbacks to the scheme Trinity Next registered', () => {
    configure(NEXT);
    const handoff = TestBed.inject(HostAuthenticationHandoffService);
    expect(handoff.callback(SSO)).toEqual({
      url: 'dev.trinityproject.trinity.next://sso-callback',
      applicationType: 'native',
    });
    expect(handoff.callback(OIDC).url).toBe(
      'dev.trinityproject.trinity.next:/sso-callback',
    );
  });

  it('refuses a sign-in callback that is not on the Trinity app scheme', () => {
    configure(NEXT);
    expect(() =>
      TestBed.inject(HostAuthenticationHandoffService).callback({
        webUrl: 'trinity://app/sso-callback',
        appUrl: 'https://x/sso-callback',
      }),
    ).toThrow(/Trinity app scheme/);
  });

  it('keeps stable Trinity on its own scheme', () => {
    configure({
      channel: 'stable',
      deepLinkScheme: 'dev.trinityproject.trinity',
      displayName: 'Trinity',
    });
    expect(
      TestBed.inject(HostAuthenticationHandoffService).callback(OIDC).url,
    ).toBe('dev.trinityproject.trinity:/sso-callback');
  });

  it('refuses to guess a scheme or name when the shell reports no identity', () => {
    configure(null);
    const handoff = TestBed.inject(HostAuthenticationHandoffService);
    expect(() => handoff.callback(SSO)).toThrow(/app identity/);
    expect(() => handoff.deviceDisplayName()).toThrow(/app identity/);
  });

  it('names new devices after the desktop app', () => {
    configure(NEXT);
    expect(
      TestBed.inject(HostAuthenticationHandoffService).deviceDisplayName(),
    ).toBe('Trinity Next');
  });

  it('hands Trinity Next links to the renderer on the canonical scheme', () => {
    configure(NEXT);
    const urls = receivedUrls(() => {
      emit('dev.trinityproject.trinity.next://matrix.to/#/!room:hs.example');
      emit('dev.trinityproject.trinity.next:/sso-callback?code=abc&state=xyz');
      emit('https://elsewhere.example/');
    });
    expect(urls).toEqual([
      'dev.trinityproject.trinity://matrix.to/#/!room:hs.example',
      'dev.trinityproject.trinity:/sso-callback?code=abc&state=xyz',
      'https://elsewhere.example/',
    ]);
  });

  it("drops stable Trinity's links on Trinity Next", () => {
    // Main already forwards only this app's scheme (electron/src/deep-link.ts); this is
    // defence in depth so a stable link can never reach Trinity Next's parsers.
    configure(NEXT);
    const urls = receivedUrls(() => {
      emit('dev.trinityproject.trinity://matrix.to/#/!room:hs.example');
      emit('dev.trinityproject.trinity:/sso-callback?code=abc&state=xyz');
      emit('dev.trinityproject.trinity.next://matrix.to/#/!other:hs.example');
    });
    expect(urls).toEqual([
      'dev.trinityproject.trinity://matrix.to/#/!other:hs.example',
    ]);
  });

  it("passes stable Trinity's links through on stable Trinity", () => {
    configure({
      channel: 'stable',
      deepLinkScheme: 'dev.trinityproject.trinity',
      displayName: 'Trinity',
    });
    const urls = receivedUrls(() =>
      emit('dev.trinityproject.trinity://matrix.to/#/!room:hs.example'),
    );
    expect(urls).toEqual([
      'dev.trinityproject.trinity://matrix.to/#/!room:hs.example',
    ]);
  });
});

describe('device display name off the desktop shell', () => {
  afterEach(() => {
    cap.native = true;
  });

  it.each([
    ['web', false],
    ['mobile', true],
  ])('stays "Trinity" on %s', (_host, native) => {
    cap.native = native;
    TestBed.configureTestingModule({ providers: [hostOperationProviders()] });
    expect(
      TestBed.inject(HostAuthenticationHandoffService).deviceDisplayName(),
    ).toBe('Trinity');
  });
});

describe('sign-in sheet', () => {
  afterEach(() => {
    cap.native = true;
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    TestBed.resetTestingModule();
  });

  it('is a sheet of the host’s own on mobile', () => {
    TestBed.configureTestingModule({ providers: [hostOperationProviders()] });
    expect(
      TestBed.inject(HOST_AUTHENTICATION_HANDOFF_OPERATION).sheetClosed,
    ).toBeDefined();
  });

  it('is a page outside Trinity on the web', () => {
    cap.native = false;
    TestBed.configureTestingModule({ providers: [hostOperationProviders()] });
    expect(
      TestBed.inject(HOST_AUTHENTICATION_HANDOFF_OPERATION).sheetClosed,
    ).toBeUndefined();
  });

  it('is the system browser, outside Trinity, on desktop', () => {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture();
    TestBed.configureTestingModule({
      providers: [
        hostOperationProviders(),
        MockProvider(HostCapabilitiesService, {
          manifest: () => of(unavailableHostManifest('not-implemented')),
        }),
      ],
    });
    expect(
      TestBed.inject(HOST_AUTHENTICATION_HANDOFF_OPERATION).sheetClosed,
    ).toBeUndefined();
  });
});
