import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeNavigationService } from './native-navigation.service';

const mocks = vi.hoisted(() => ({
  platform: 'ios' as string,
  available: true,
  setGesturesEnabled: vi.fn<(options: { enabled: boolean }) => Promise<void>>(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: vi.fn(() => mocks.platform),
    isPluginAvailable: vi.fn(() => mocks.available),
  },
  registerPlugin: vi.fn(() => ({
    setGesturesEnabled: (options: { enabled: boolean }) =>
      mocks.setGesturesEnabled(options),
  })),
}));

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('NativeNavigationService', () => {
  let service: NativeNavigationService;
  let escaped: unknown[];
  const record = (reason: unknown) => escaped.push(reason);

  beforeEach(() => {
    mocks.platform = 'ios';
    mocks.available = true;
    mocks.setGesturesEnabled.mockReset().mockResolvedValue(undefined);
    escaped = [];
    process.on('unhandledRejection', record);
    TestBed.configureTestingModule({ providers: [NativeNavigationService] });
    service = TestBed.inject(NativeNavigationService);
  });

  afterEach(() => {
    process.off('unhandledRejection', record);
    TestBed.resetTestingModule();
  });

  it('mirrors enabled and disabled states to the iOS plugin', async () => {
    service.setHistoryGesturesEnabled(false);
    service.setHistoryGesturesEnabled(true);
    await flush();

    expect(mocks.setGesturesEnabled).toHaveBeenNthCalledWith(1, {
      enabled: false,
    });
    expect(mocks.setGesturesEnabled).toHaveBeenNthCalledWith(2, {
      enabled: true,
    });
  });

  it('does nothing outside iOS', async () => {
    mocks.platform = 'android';

    service.setHistoryGesturesEnabled(false);
    await flush();

    expect(Capacitor.getPlatform).toHaveBeenCalled();
    expect(mocks.setGesturesEnabled).not.toHaveBeenCalled();
  });

  it('does nothing when the native plugin is unavailable', async () => {
    mocks.available = false;

    service.setHistoryGesturesEnabled(false);
    await flush();

    expect(Capacitor.isPluginAvailable).toHaveBeenCalledWith(
      'NativeNavigation',
    );
    expect(mocks.setGesturesEnabled).not.toHaveBeenCalled();
  });

  it('contains a rejected bridge call', async () => {
    const debug = vi
      .spyOn(console, 'debug')
      .mockImplementation(() => undefined);
    mocks.setGesturesEnabled.mockRejectedValueOnce(
      new Error('bridge rejected'),
    );

    expect(() => service.setHistoryGesturesEnabled(false)).not.toThrow();
    await flush();

    expect(escaped).toEqual([]);
    expect(debug).toHaveBeenCalledWith(
      'Trinity: native navigation gesture coordination unavailable',
      expect.any(Error),
    );
    debug.mockRestore();
  });

  it('contains a synchronous bridge failure', async () => {
    const debug = vi
      .spyOn(console, 'debug')
      .mockImplementation(() => undefined);
    mocks.setGesturesEnabled.mockImplementationOnce(() => {
      throw new Error('bridge missing');
    });

    expect(() => service.setHistoryGesturesEnabled(false)).not.toThrow();
    await flush();

    expect(escaped).toEqual([]);
    expect(debug).toHaveBeenCalledWith(
      'Trinity: native navigation gesture coordination unavailable',
      expect.any(Error),
    );
    debug.mockRestore();
  });
});
