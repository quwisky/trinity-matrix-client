import { describe, expect, it } from 'vitest';
import type { AppearanceValue } from './appearance-preferences';
import {
  resolveAppearance,
  sameResolvedAppearance,
  toNativeChromeAppearance,
} from './appearance-resolution';

const committed = (mode: AppearanceValue['mode']): AppearanceValue => ({
  mode,
  theme: 'amethyst',
  textSize: 'larger',
  density: 'compact',
  codeSize: 'smaller',
  codeLinePresentation: 'always',
  appIcon: 'system',
});

describe('Appearance resolution', () => {
  it('resolves system Mode without reading browser or native APIs', () => {
    const { appIcon: _appIcon, ...rest } = committed('system');
    expect(resolveAppearance(committed('system'), 'dark')).toEqual({
      ...rest,
      mode: 'dark',
      appIcon: 'dark',
      appIconPreference: 'system',
    });
    expect(resolveAppearance(committed('system'), 'light')).toEqual({
      ...rest,
      mode: 'light',
      appIcon: 'blurple',
      appIconPreference: 'system',
    });
  });

  it('keeps fixed Modes independent from later system changes', () => {
    expect(resolveAppearance(committed('light'), 'dark').mode).toBe('light');
    expect(resolveAppearance(committed('dark'), 'light').mode).toBe('dark');
  });

  it('projects only resolved Mode to native chrome', () => {
    const native = toNativeChromeAppearance(
      resolveAppearance(committed('system'), 'dark'),
    );

    expect(native).toEqual({
      mode: 'dark',
      appIcon: 'dark',
      appIconPreference: 'system',
    });
    expect(Object.keys(native)).toEqual([
      'mode',
      'appIcon',
      'appIconPreference',
    ]);
  });

  it.each([
    ['system', 'light', 'blurple'],
    ['system', 'dark', 'dark'],
    ['blurple', 'dark', 'blurple'],
    ['dark', 'light', 'dark'],
  ] as const)(
    'resolves app icon %s under a %s system to %s',
    (preference, system, icon) => {
      const resolved = resolveAppearance(
        { ...committed('system'), appIcon: preference },
        system,
      );
      expect(resolved.appIcon).toBe(icon);
      expect(resolved.appIconPreference).toBe(preference);
      expect(toNativeChromeAppearance(resolved)).toEqual({
        mode: resolved.mode,
        appIcon: icon,
        appIconPreference: preference,
      });
    },
  );

  it('treats an app icon change as a different appearance', () => {
    const base = resolveAppearance(
      { ...committed('system'), appIcon: 'system' },
      'light',
    );
    expect(
      sameResolvedAppearance(
        base,
        resolveAppearance({ ...committed('system'), appIcon: 'dark' }, 'light'),
      ),
    ).toBe(false);
    expect(
      sameResolvedAppearance(
        base,
        resolveAppearance(
          { ...committed('system'), appIcon: 'blurple' },
          'light',
        ),
      ),
    ).toBe(false);
  });
});
