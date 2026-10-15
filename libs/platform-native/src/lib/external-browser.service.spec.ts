import { TestBed } from '@angular/core/testing';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import {
  HOST_DEEP_LINKS_OPERATION,
  HOST_LIFECYCLE_OPERATION,
  HostDeepLinksService,
  HostSystemUiService,
} from '@trinity/runtime/host';
import { Subject, firstValueFrom, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalBrowserService } from './external-browser.service';

const sheet = vi.hoisted(() => ({
  finished: (): void => undefined,
  remove: vi.fn(() => Promise.resolve()),
}));

vi.mock('@capacitor/browser', () => ({
  Browser: {
    open: vi.fn(() => Promise.resolve()),
    addListener: vi.fn((_event: string, listener: () => void) => {
      sheet.finished = listener;
      return Promise.resolve({ remove: sheet.remove });
    }),
  },
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
}));

const isNative = vi.mocked(Capacitor.isNativePlatform);
const browserOpen = vi.mocked(Browser.open);
const addListener = vi.mocked(Browser.addListener);

describe('ExternalBrowserService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isNative.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('opens web and Electron destinations without an opener', async () => {
    const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null);

    const opened = await firstValueFrom(
      TestBed.inject(ExternalBrowserService).open(
        'https://widgets.example/board',
      ),
    );

    expect(opened).toBe(true);
    expect(windowOpen).toHaveBeenCalledWith(
      'https://widgets.example/board',
      '_blank',
      'noopener,noreferrer',
    );
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it('does not dispatch until the action is subscribed', async () => {
    const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null);
    const action = TestBed.inject(ExternalBrowserService).open(
      'https://widgets.example/board',
    );

    expect(windowOpen).not.toHaveBeenCalled();

    await firstValueFrom(action);

    expect(windowOpen).toHaveBeenCalledOnce();
  });

  it('uses the Capacitor browser on iOS and Android', async () => {
    isNative.mockReturnValue(true);
    const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null);

    const opened = await firstValueFrom(
      TestBed.inject(ExternalBrowserService).open(
        'http://widgets.example/board',
      ),
    );

    expect(opened).toBe(true);
    expect(browserOpen).toHaveBeenCalledWith({
      url: 'http://widgets.example/board',
    });
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('reports a Capacitor browser rejection to the caller', async () => {
    isNative.mockReturnValue(true);
    browserOpen.mockRejectedValueOnce(new Error('browser unavailable'));
    const debug = vi
      .spyOn(console, 'debug')
      .mockImplementation(() => undefined);

    const opened = await firstValueFrom(
      TestBed.inject(ExternalBrowserService).open(
        'https://widgets.example/board',
      ),
    );

    expect(opened).toBe(false);
    expect(debug).toHaveBeenCalledWith(
      'Trinity: external browser unavailable',
      expect.any(Error),
    );
    debug.mockRestore();
  });

  it.each(['javascript:alert(1)', 'data:text/html,hello', 'not a URL'])(
    'refuses %s before dispatching it to any platform',
    async (url) => {
      const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null);

      expect(
        await firstValueFrom(TestBed.inject(ExternalBrowserService).open(url)),
      ).toBe(false);
      expect(windowOpen).not.toHaveBeenCalled();
      expect(browserOpen).not.toHaveBeenCalled();
    },
  );

  describe('the in-app browser sheet as Trinity’s own system UI', () => {
    function setup() {
      isNative.mockReturnValue(true);
      const lifecycle = new Subject<{
        readonly kind: 'active' | 'background';
      }>();
      const received = new Subject<{ readonly url: string }>();
      TestBed.configureTestingModule({
        providers: [
          {
            provide: HOST_LIFECYCLE_OPERATION,
            useValue: { events: lifecycle.asObservable() },
          },
          {
            provide: HOST_DEEP_LINKS_OPERATION,
            useValue: {
              deepLinkSupport: () => of({ kind: 'supported' as const }),
              received: received.asObservable(),
              closeAuthentication: () => of({ kind: 'completed' as const }),
            },
          },
        ],
      });
      // The application listens for links for its whole lifetime.
      TestBed.inject(HostDeepLinksService).received.subscribe();
      const ui = TestBed.inject(HostSystemUiService);
      // "Manage account" at the account provider, or approving an identity reset there.
      const open = () =>
        firstValueFrom(
          TestBed.inject(ExternalBrowserService).open(
            'https://account.example/account',
          ),
        );
      return { ui, lifecycle, received, open };
    }

    it('counts the sheet from opening until the person closes it', async () => {
      const { ui, open } = setup();
      await open();
      expect(addListener).toHaveBeenCalledWith(
        'browserFinished',
        expect.any(Function),
      );
      // The plugin's open resolves as soon as the sheet shows; the sheet is still up.
      expect(ui.active()).toBe(true);
      sheet.finished();
      expect(ui.active()).toBe(false);
      expect(sheet.remove).toHaveBeenCalled();
    });

    it('stops counting when a link arrives back from the sheet', async () => {
      const { ui, received, open } = setup();
      await open();
      expect(ui.active()).toBe(true);
      received.next({ url: 'dev.trinityproject.trinity://matrix.to/#/!a:b' });
      expect(ui.active()).toBe(false);
    });

    it('releases a sheet whose end was missed once the app is back in the foreground', async () => {
      const { ui, lifecycle, open } = setup();
      await open();
      lifecycle.next({ kind: 'background' });
      expect(ui.active()).toBe(true);
      lifecycle.next({ kind: 'active' });
      expect(ui.active()).toBe(false);
    });

    it('counts nothing when the sheet could not open', async () => {
      const { ui, open } = setup();
      browserOpen.mockRejectedValueOnce(new Error('browser unavailable'));
      vi.spyOn(console, 'debug').mockImplementation(() => undefined);
      expect(await open()).toBe(false);
      expect(ui.active()).toBe(false);
    });

    it('counts nothing for a page in a browser outside Trinity', async () => {
      const { ui, open } = setup();
      isNative.mockReturnValue(false);
      vi.spyOn(window, 'open').mockReturnValue(null);
      expect(await open()).toBe(true);
      expect(ui.active()).toBe(false);
    });
  });
});
