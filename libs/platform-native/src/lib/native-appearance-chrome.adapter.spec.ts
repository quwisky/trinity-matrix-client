import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeAppearanceChromeAdapter } from './native-appearance-chrome.adapter';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    isPluginAvailable: vi.fn(() => true),
  },
}));
vi.mock('@capacitor/status-bar', () => ({
  StatusBar: { setStyle: vi.fn(() => Promise.resolve()) },
  Style: { Dark: 'DARK', Light: 'LIGHT' },
}));

const isNative = vi.mocked(Capacitor.isNativePlatform);
const isAvailable = vi.mocked(Capacitor.isPluginAvailable);
const setStyle = vi.mocked(StatusBar.setStyle);

describe('NativeAppearanceChromeAdapter', () => {
  beforeEach(() => {
    isNative.mockReset().mockReturnValue(true);
    isAvailable.mockReset().mockReturnValue(true);
    setStyle.mockReset().mockResolvedValue(undefined);
  });

  it('keeps status-bar projection cold and maps only resolved Mode', async () => {
    const adapter = TestBed.inject(NativeAppearanceChromeAdapter);
    const command = adapter.apply({ mode: 'dark' });

    expect(setStyle).not.toHaveBeenCalled();
    await firstValueFrom(command);

    expect(setStyle).toHaveBeenCalledOnce();
    expect(setStyle).toHaveBeenCalledWith({ style: 'DARK' });

    await firstValueFrom(adapter.apply({ mode: 'light' }));
    expect(setStyle).toHaveBeenLastCalledWith({ style: 'LIGHT' });
  });

  it('completes without touching plugins on Web, Electron, or missing hosts', async () => {
    const adapter = TestBed.inject(NativeAppearanceChromeAdapter);
    isNative.mockReturnValue(false);
    await firstValueFrom(adapter.apply({ mode: 'dark' }));
    expect(setStyle).not.toHaveBeenCalled();

    isNative.mockReturnValue(true);
    isAvailable.mockReturnValue(false);
    await firstValueFrom(adapter.apply({ mode: 'dark' }));
    expect(setStyle).not.toHaveBeenCalled();
  });
});
