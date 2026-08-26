import { TestBed } from '@angular/core/testing';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalBrowserService } from './external-browser.service';

vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn(() => Promise.resolve()) },
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
}));

const isNative = vi.mocked(Capacitor.isNativePlatform);
const browserOpen = vi.mocked(Browser.open);

describe('ExternalBrowserService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isNative.mockReturnValue(false);
  });

  afterEach(() => vi.restoreAllMocks());

  it('opens web and Electron destinations without an opener', async () => {
    const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null);

    const opened = await TestBed.inject(ExternalBrowserService).open(
      'https://widgets.example/board',
    );

    expect(opened).toBe(true);
    expect(windowOpen).toHaveBeenCalledWith(
      'https://widgets.example/board',
      '_blank',
      'noopener,noreferrer',
    );
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it('uses the Capacitor browser on iOS and Android', async () => {
    isNative.mockReturnValue(true);
    const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null);

    const opened = await TestBed.inject(ExternalBrowserService).open(
      'http://widgets.example/board',
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
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    const opened = await TestBed.inject(ExternalBrowserService).open(
      'https://widgets.example/board',
    );

    expect(opened).toBe(false);
  });

  it.each(['javascript:alert(1)', 'data:text/html,hello', 'not a URL'])(
    'refuses %s before dispatching it to any platform',
    async (url) => {
      const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null);

      expect(await TestBed.inject(ExternalBrowserService).open(url)).toBe(
        false,
      );
      expect(windowOpen).not.toHaveBeenCalled();
      expect(browserOpen).not.toHaveBeenCalled();
    },
  );
});
