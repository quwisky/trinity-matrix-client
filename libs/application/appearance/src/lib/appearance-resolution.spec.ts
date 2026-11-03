import { describe, expect, it } from 'vitest';
import type { AppearanceValue } from './appearance-preferences';
import {
  resolveAppearance,
  surfaceMode,
  toNativeChromeAppearance,
} from './appearance-resolution';

const page = (color: string) =>
  ({ kind: 'page', color, underStatusBar: true }) as const;

const committed = (mode: AppearanceValue['mode']): AppearanceValue => ({
  mode,
  theme: 'amethyst',
  textSize: 'larger',
  density: 'compact',
  roomList: 'compact',
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

  it('projects only resolved Mode to native chrome without a status area reading', () => {
    const native = toNativeChromeAppearance(
      resolveAppearance(committed('system'), 'dark'),
    );

    expect(native).toEqual({ mode: 'dark', color: null });
    expect(Object.keys(native)).toEqual(['mode', 'color']);
  });

  it('takes the Mode of the surface under the status bar over the resolved Mode', () => {
    const light = resolveAppearance(committed('light'), 'light');
    const dark = resolveAppearance(committed('dark'), 'dark');

    // The dark Graphite accent banner: white content would measure 2.96:1, black 7.1:1.
    expect(toNativeChromeAppearance(dark, page('#7f8ff1'))).toEqual({
      mode: 'light',
      color: '#7f8ff1',
    });
    // The media viewer's black matte in light Mode.
    expect(toNativeChromeAppearance(light, page('#000000')).mode).toBe('dark');
    expect(toNativeChromeAppearance(light, page('#f5f3ef')).mode).toBe('light');
  });

  it('follows the system Mode where the page does not reach under the status bar', () => {
    // Android WebView before 140 shows the window background there, which follows the system;
    // the colour still goes to a browser's theme colour.
    const light = resolveAppearance(committed('light'), 'dark');

    expect(
      toNativeChromeAppearance(
        light,
        { kind: 'page', color: '#5358ee', underStatusBar: false },
        'dark',
      ),
    ).toEqual({ mode: 'dark', color: '#5358ee' });
  });

  it('picks the content colour with more contrast on the surface', () => {
    expect(surfaceMode('#ffffff')).toBe('light');
    expect(surfaceMode('#000000')).toBe('dark');
    // The light accent banner: black 4.0:1, white 5.25:1.
    expect(surfaceMode('#5358ee')).toBe('dark');
    // Either side of the 0.179 luminance where both contrasts meet.
    expect(surfaceMode('#757575')).toBe('dark');
    expect(surfaceMode('#777777')).toBe('light');
  });
});
