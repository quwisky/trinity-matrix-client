import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeKeyboardInsetAdapter } from './native-keyboard-inset.adapter';

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: vi.fn(() => 'web') },
}));
vi.mock('@capacitor/keyboard', () => ({
  Keyboard: { addListener: vi.fn() },
}));

const platform = vi.mocked(Capacitor.getPlatform);
const addListener = vi.mocked(Keyboard.addListener) as unknown as ReturnType<
  typeof vi.fn
>;
const listeners = new Map<
  string,
  (info?: { keyboardHeight: number }) => void
>();
const remove = vi.fn(() => Promise.resolve());
const inset = () =>
  document.documentElement.style.getPropertyValue('--trinity-keyboard-inset');
const flush = () => new Promise((resolve) => setTimeout(resolve));

describe('NativeKeyboardInsetAdapter', () => {
  beforeEach(() => {
    platform.mockReturnValue('ios');
    listeners.clear();
    remove.mockClear();
    addListener.mockReset().mockImplementation((event: string, listener) => {
      listeners.set(event, listener);
      return Promise.resolve({ remove });
    });
  });
  afterEach(() => {
    document.documentElement.style.removeProperty('--trinity-keyboard-inset');
    vi.restoreAllMocks();
  });

  it('sets the inset to the keyboard height as it shows and to 0 as it hides', () => {
    const run = TestBed.inject(NativeKeyboardInsetAdapter).run().subscribe();

    listeners.get('keyboardWillShow')?.({ keyboardHeight: 336 });
    expect(inset()).toBe('336px');

    listeners.get('keyboardWillHide')?.();
    expect(inset()).toBe('0px');
    run.unsubscribe();
  });

  it('follows the latest height when the keyboard changes while open', () => {
    // A predictive bar or a switch to the emoji keyboard shows again with another height.
    TestBed.inject(NativeKeyboardInsetAdapter).run().subscribe();

    listeners.get('keyboardWillShow')?.({ keyboardHeight: 336 });
    listeners.get('keyboardWillShow')?.({ keyboardHeight: 291 });

    expect(inset()).toBe('291px');
  });

  it('listens only to the keyboard starting to move', () => {
    TestBed.inject(NativeKeyboardInsetAdapter).run().subscribe();

    expect([...listeners.keys()]).toEqual([
      'keyboardWillShow',
      'keyboardWillHide',
    ]);
  });

  it.each(['web', 'android'])('does nothing on %s', (host) => {
    platform.mockReturnValue(host);

    TestBed.inject(NativeKeyboardInsetAdapter).run().subscribe();

    expect(addListener).not.toHaveBeenCalled();
    expect(inset()).toBe('');
  });

  it('removes its listeners and the inset on teardown', async () => {
    const run = TestBed.inject(NativeKeyboardInsetAdapter).run().subscribe();
    listeners.get('keyboardWillShow')?.({ keyboardHeight: 336 });

    run.unsubscribe();
    await flush();

    expect(remove).toHaveBeenCalledTimes(2);
    expect(inset()).toBe('');
  });
});
