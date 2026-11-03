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

  it('keeps status-bar projection cold and maps Mode to the content style', async () => {
    const adapter = TestBed.inject(NativeAppearanceChromeAdapter);
    const command = adapter.apply({ mode: 'dark', color: '#151618' });

    expect(setStyle).not.toHaveBeenCalled();
    await firstValueFrom(command);

    expect(setStyle).toHaveBeenCalledOnce();
    expect(setStyle).toHaveBeenCalledWith({ style: 'DARK' });

    await firstValueFrom(adapter.apply({ mode: 'light', color: '#fdfcf9' }));
    expect(setStyle).toHaveBeenLastCalledWith({ style: 'LIGHT' });
  });

  it('sends the native style only when it changes', async () => {
    const adapter = TestBed.inject(NativeAppearanceChromeAdapter);
    await firstValueFrom(adapter.apply({ mode: 'light', color: '#fdfcf9' }));
    await firstValueFrom(adapter.apply({ mode: 'light', color: '#f5f3ef' }));
    expect(setStyle).toHaveBeenCalledOnce();

    // A rejected command is not remembered, so the next apply tries again.
    setStyle.mockRejectedValueOnce(new Error('bridge busy'));
    await expect(
      firstValueFrom(adapter.apply({ mode: 'dark', color: '#151618' })),
    ).rejects.toThrow('bridge busy');
    await firstValueFrom(adapter.apply({ mode: 'dark', color: '#151618' }));
    expect(setStyle).toHaveBeenCalledTimes(3);
  });

  it('paints the browser theme colour from the status area on Web', async () => {
    const adapter = TestBed.inject(NativeAppearanceChromeAdapter);
    isNative.mockReturnValue(false);
    const metas = ['light', 'dark'].map((scheme) => {
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      meta.media = `(prefers-color-scheme: ${scheme})`;
      meta.content = '#000000';
      document.head.append(meta);
      return meta;
    });

    await firstValueFrom(adapter.apply({ mode: 'light', color: '#5358ee' }));
    expect(metas.map((meta) => meta.content)).toEqual(['#5358ee', '#5358ee']);

    await firstValueFrom(adapter.apply({ mode: 'light', color: null }));
    expect(metas.map((meta) => meta.content)).toEqual(['#5358ee', '#5358ee']);
    for (const meta of metas) meta.remove();
  });

  it('completes without touching plugins on Web, Electron, or missing hosts', async () => {
    const adapter = TestBed.inject(NativeAppearanceChromeAdapter);
    isNative.mockReturnValue(false);
    await firstValueFrom(adapter.apply({ mode: 'dark', color: '#151618' }));
    expect(setStyle).not.toHaveBeenCalled();

    isNative.mockReturnValue(true);
    isAvailable.mockReturnValue(false);
    await firstValueFrom(adapter.apply({ mode: 'dark', color: '#151618' }));
    expect(setStyle).not.toHaveBeenCalled();
  });
});
