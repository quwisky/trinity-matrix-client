import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeKeyboardInsetAdapter } from './native-keyboard-inset.adapter';

const plugin = vi.hoisted(() => ({ addListener: vi.fn() }));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: vi.fn(() => 'web') },
  registerPlugin: vi.fn(() => plugin),
}));

interface Frame {
  height: number;
  duration?: number;
  curve: number;
}

const platform = vi.mocked(Capacitor.getPlatform);
const listeners = new Map<string, (frame: Frame) => void>();
const remove = vi.fn(() => Promise.resolve());
const style = (property: string) =>
  document.documentElement.style.getPropertyValue(property);
const flush = () => new Promise((resolve) => setTimeout(resolve));
const PROPERTIES = [
  '--trinity-keyboard-inset',
  '--trinity-keyboard-duration',
  '--trinity-keyboard-easing',
  '--trinity-keyboard-delay',
];

describe('NativeKeyboardInsetAdapter', () => {
  beforeEach(() => {
    platform.mockReturnValue('ios');
    listeners.clear();
    remove.mockClear();
    plugin.addListener
      .mockReset()
      .mockImplementation((event: string, listener: (frame: Frame) => void) => {
        listeners.set(event, listener);
        return Promise.resolve({ remove });
      });
  });
  afterEach(() => {
    for (const property of PROPERTIES)
      document.documentElement.style.removeProperty(property);
    vi.restoreAllMocks();
  });

  it('writes the covered height and the timing of each move as the keyboard shows and hides', () => {
    TestBed.inject(NativeKeyboardInsetAdapter).run().subscribe();

    listeners.get('keyboardFrame')?.({ height: 336, duration: 0.35, curve: 7 });
    expect(style('--trinity-keyboard-inset')).toBe('336px');
    expect(style('--trinity-keyboard-duration')).toBe('350ms');
    expect(style('--trinity-keyboard-delay')).toBe('-16ms');

    listeners.get('keyboardFrame')?.({ height: 0, duration: 0.25, curve: 7 });
    expect(style('--trinity-keyboard-inset')).toBe('0px');
    expect(style('--trinity-keyboard-duration')).toBe('250ms');
    // Each move starts slightly into its curve, to land on screen with the keyboard.
    expect(style('--trinity-keyboard-delay')).toBe('-33ms');
  });

  it('takes the hide head start for any shrinking move, not only the last one', () => {
    TestBed.inject(NativeKeyboardInsetAdapter).run().subscribe();

    listeners.get('keyboardFrame')?.({ height: 336, duration: 0.25, curve: 7 });
    // The predictive bar collapses: the keyboard shrinks but stays up.
    listeners.get('keyboardFrame')?.({ height: 291, duration: 0.25, curve: 7 });
    expect(style('--trinity-keyboard-delay')).toBe('-33ms');

    listeners.get('keyboardFrame')?.({ height: 336, duration: 0.25, curve: 7 });
    expect(style('--trinity-keyboard-delay')).toBe('-16ms');
  });

  it('leaves a missing duration to the stylesheet default and keeps a real 0', () => {
    TestBed.inject(NativeKeyboardInsetAdapter).run().subscribe();

    listeners.get('keyboardFrame')?.({ height: 336, duration: 0.35, curve: 7 });
    listeners.get('keyboardFrame')?.({ height: 0, curve: 7 });
    expect(style('--trinity-keyboard-duration')).toBe('');
    expect(style('--trinity-keyboard-inset')).toBe('0px');

    listeners.get('keyboardFrame')?.({ height: 55, duration: 0, curve: 7 });
    expect(style('--trinity-keyboard-duration')).toBe('0ms');
  });

  it('passes a public curve through and leaves the private one to the stylesheet', () => {
    TestBed.inject(NativeKeyboardInsetAdapter).run().subscribe();

    listeners.get('keyboardFrame')?.({ height: 291, duration: 0.25, curve: 3 });
    expect(style('--trinity-keyboard-easing')).toBe('linear');

    listeners.get('keyboardFrame')?.({ height: 336, duration: 0.25, curve: 7 });
    expect(style('--trinity-keyboard-easing')).toBe('');
  });

  it.each(['web', 'android'])('does nothing on %s', (host) => {
    platform.mockReturnValue(host);

    TestBed.inject(NativeKeyboardInsetAdapter).run().subscribe();

    expect(plugin.addListener).not.toHaveBeenCalled();
    expect(style('--trinity-keyboard-inset')).toBe('');
  });

  it('removes its listener and every property on teardown', async () => {
    const run = TestBed.inject(NativeKeyboardInsetAdapter).run().subscribe();
    listeners.get('keyboardFrame')?.({ height: 336, duration: 0.25, curve: 0 });

    run.unsubscribe();
    await flush();

    expect(remove).toHaveBeenCalledTimes(1);
    for (const property of PROPERTIES) expect(style(property)).toBe('');
  });
});
