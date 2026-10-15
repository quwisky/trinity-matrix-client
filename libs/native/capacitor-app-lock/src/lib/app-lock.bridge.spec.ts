import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { firstValueFrom } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import {
  AppLockPinBridge,
  DISMISS_PRESENTED_TIMEOUT_MS,
} from './app-lock.bridge';

const plugin = vi.hoisted(() => ({
  pinStatus: vi.fn(),
  setPin: vi.fn(),
  verifyPin: vi.fn(),
  clearPin: vi.fn(),
  dismissPresented: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => true),
    isPluginAvailable: vi.fn(() => true),
  },
  registerPlugin: vi.fn(() => plugin),
}));

function bridge(): AppLockPinBridge {
  TestBed.configureTestingModule({ providers: [AppLockPinBridge] });
  return TestBed.inject(AppLockPinBridge);
}

describe('AppLockPinBridge', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => TestBed.resetTestingModule());

  it('reads the status cold', async () => {
    plugin.pinStatus.mockResolvedValue({ set: true, nextAttemptAt: null });
    const status = bridge().status();
    expect(plugin.pinStatus).not.toHaveBeenCalled();
    await expect(firstValueFrom(status)).resolves.toEqual({
      kind: 'ready',
      set: true,
      nextAttemptAt: null,
    });
  });

  it('maps a storage rejection to unavailable', async () => {
    plugin.pinStatus.mockRejectedValue({ code: 'storage-unavailable' });
    await expect(firstValueFrom(bridge().status())).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('maps set rejections by code', async () => {
    const pins = bridge();
    plugin.setPin.mockRejectedValueOnce({ code: 'pin-invalid' });
    await expect(firstValueFrom(pins.set('12'))).resolves.toBe('invalid');
    plugin.setPin.mockRejectedValueOnce({ code: 'storage-unavailable' });
    await expect(firstValueFrom(pins.set('482913'))).resolves.toBe(
      'unavailable',
    );
    plugin.setPin.mockResolvedValueOnce(undefined);
    await expect(firstValueFrom(pins.set('482913'))).resolves.toBe('completed');
    expect(plugin.setPin).toHaveBeenLastCalledWith({ pin: '482913' });
  });

  it('accepts only declared verify results', async () => {
    const pins = bridge();
    plugin.verifyPin.mockResolvedValueOnce({
      result: 'delayed',
      nextAttemptAt: 9,
    });
    await expect(firstValueFrom(pins.verify('482913'))).resolves.toEqual({
      kind: 'delayed',
      nextAttemptAt: 9,
    });
    plugin.verifyPin.mockResolvedValueOnce({ result: 'open-sesame' });
    await expect(firstValueFrom(pins.verify('482913'))).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('maps every declared verify result', async () => {
    const pins = bridge();
    plugin.verifyPin.mockResolvedValueOnce({
      result: 'verified',
      nextAttemptAt: null,
    });
    await expect(firstValueFrom(pins.verify('482913'))).resolves.toEqual({
      kind: 'verified',
    });
    expect(plugin.verifyPin).toHaveBeenLastCalledWith({ pin: '482913' });
    plugin.verifyPin.mockResolvedValueOnce({
      result: 'failed',
      nextAttemptAt: null,
    });
    await expect(firstValueFrom(pins.verify('000000'))).resolves.toEqual({
      kind: 'failed',
      nextAttemptAt: null,
    });
    plugin.verifyPin.mockResolvedValueOnce({
      result: 'failed',
      nextAttemptAt: 30_000,
    });
    await expect(firstValueFrom(pins.verify('000000'))).resolves.toEqual({
      kind: 'failed',
      nextAttemptAt: 30_000,
    });
    plugin.verifyPin.mockResolvedValueOnce({
      result: 'invalid',
      nextAttemptAt: null,
    });
    await expect(firstValueFrom(pins.verify('12 34'))).resolves.toEqual({
      kind: 'invalid',
    });
    plugin.verifyPin.mockResolvedValueOnce({
      result: 'unavailable',
      nextAttemptAt: null,
    });
    await expect(firstValueFrom(pins.verify('482913'))).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('treats a wait without its end, or a rejected check, as unavailable', async () => {
    const pins = bridge();
    plugin.verifyPin.mockResolvedValueOnce({
      result: 'delayed',
      nextAttemptAt: null,
    });
    await expect(firstValueFrom(pins.verify('482913'))).resolves.toEqual({
      kind: 'unavailable',
    });
    plugin.verifyPin.mockRejectedValueOnce(new Error('bridge gone'));
    await expect(firstValueFrom(pins.verify('482913'))).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  // A garbled answer (an older or a hostile build) must never read as "no PIN set" or "no
  // wait": a stored PIN keeps the lock on when the setting cannot be read.
  it.each([
    ['a missing set', { nextAttemptAt: null }],
    ['a string set', { set: 'false', nextAttemptAt: null }],
    ['a numeric set', { set: 0, nextAttemptAt: null }],
    ['a null set', { set: null, nextAttemptAt: null }],
    ['a non-numeric wait end', { set: true, nextAttemptAt: 'soon' }],
    ['a missing wait end', { set: true }],
    [
      'an infinite wait end',
      { set: true, nextAttemptAt: Number.POSITIVE_INFINITY },
    ],
    ['no answer', undefined],
    ['a null answer', null],
  ])('reads a status with %s as unavailable', async (_name, answer) => {
    plugin.pinStatus.mockResolvedValue(answer);
    await expect(firstValueFrom(bridge().status())).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('reads a running wait from the status', async () => {
    plugin.pinStatus.mockResolvedValue({ set: true, nextAttemptAt: 30_000 });
    await expect(firstValueFrom(bridge().status())).resolves.toEqual({
      kind: 'ready',
      set: true,
      nextAttemptAt: 30_000,
    });
  });

  it.each([
    [
      'a failure with a non-numeric wait end',
      { result: 'failed', nextAttemptAt: 'soon' },
    ],
    ['a failure with a missing wait end', { result: 'failed' }],
    ['a missing result', { nextAttemptAt: null }],
    ['no answer', undefined],
    ['a null answer', null],
  ])('reads a check with %s as unavailable', async (_name, answer) => {
    plugin.verifyPin.mockResolvedValue(answer);
    await expect(firstValueFrom(bridge().verify('482913'))).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('clears the PIN, cold', async () => {
    const pins = bridge();
    plugin.clearPin.mockResolvedValueOnce(undefined);
    const cleared = pins.clear();
    expect(plugin.clearPin).not.toHaveBeenCalled();
    await expect(firstValueFrom(cleared)).resolves.toBe('completed');
    plugin.clearPin.mockRejectedValueOnce({ code: 'storage-unavailable' });
    await expect(firstValueFrom(pins.clear())).resolves.toBe('unavailable');
  });

  it('dismisses presented native UI, cold', async () => {
    plugin.dismissPresented.mockResolvedValueOnce(undefined);
    const dismissal = bridge().dismissPresented();
    expect(plugin.dismissPresented).not.toHaveBeenCalled();
    await expect(
      firstValueFrom(dismissal, { defaultValue: 'done' }),
    ).resolves.toBeUndefined();
    expect(plugin.dismissPresented).toHaveBeenCalledOnce();
  });

  it('dismisses presented native UI, and never fails the caller', async () => {
    plugin.dismissPresented.mockRejectedValueOnce(new Error('no controller'));
    await expect(
      firstValueFrom(bridge().dismissPresented(), { defaultValue: 'done' }),
    ).resolves.toBeUndefined();
  });

  it('stops waiting for a dismissal that never settles', async () => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
      ],
    });
    try {
      plugin.dismissPresented.mockReturnValueOnce(new Promise(() => undefined));
      const dismissal = firstValueFrom(bridge().dismissPresented(), {
        defaultValue: 'done',
      });
      await vi.advanceTimersByTimeAsync(DISMISS_PRESENTED_TIMEOUT_MS);
      await expect(dismissal).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not supported off native', async () => {
    (Capacitor.isNativePlatform as unknown as Mock).mockReturnValue(false);
    await expect(firstValueFrom(bridge().status())).resolves.toEqual({
      kind: 'not-supported',
    });
    expect(plugin.pinStatus).not.toHaveBeenCalled();
    (Capacitor.isNativePlatform as unknown as Mock).mockReturnValue(true);
  });

  it('never reaches the plugin when it is missing', async () => {
    (Capacitor.isPluginAvailable as unknown as Mock).mockReturnValue(false);
    const pins = bridge();
    expect(pins.available).toBe(false);
    await expect(firstValueFrom(pins.set('482913'))).resolves.toBe(
      'unavailable',
    );
    await expect(firstValueFrom(pins.verify('482913'))).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(firstValueFrom(pins.clear())).resolves.toBe('unavailable');
    expect(plugin.setPin).not.toHaveBeenCalled();
    expect(plugin.verifyPin).not.toHaveBeenCalled();
    expect(plugin.clearPin).not.toHaveBeenCalled();
    await expect(
      firstValueFrom(pins.dismissPresented(), { defaultValue: 'done' }),
    ).resolves.toBeUndefined();
    expect(plugin.dismissPresented).not.toHaveBeenCalled();
    (Capacitor.isPluginAvailable as unknown as Mock).mockReturnValue(true);
  });
});
