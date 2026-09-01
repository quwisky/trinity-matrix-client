import { describe, expect, it } from 'vitest';
import type { AppearanceValue } from './appearance-preferences';
import {
  resolveAppearance,
  toNativeChromeAppearance,
} from './appearance-resolution';

const committed = (mode: AppearanceValue['mode']): AppearanceValue => ({
  mode,
  theme: 'amethyst',
  textSize: 'larger',
  density: 'compact',
  codeSize: 'smaller',
  codeLinePresentation: 'always',
});

describe('Appearance resolution', () => {
  it('resolves system Mode without reading browser or native APIs', () => {
    expect(resolveAppearance(committed('system'), 'dark')).toEqual({
      ...committed('system'),
      mode: 'dark',
    });
    expect(resolveAppearance(committed('system'), 'light')).toEqual({
      ...committed('system'),
      mode: 'light',
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

    expect(native).toEqual({ mode: 'dark' });
    expect(Object.keys(native)).toEqual(['mode']);
  });
});
