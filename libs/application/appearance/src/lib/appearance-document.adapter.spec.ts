import { TestBed } from '@angular/core/testing';
import { THEME_CATALOG } from '@trinity/theme-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserAppearanceDocumentAdapter,
  deviceTextScale,
} from './appearance-document.adapter';
import type { ResolvedAppearance } from './appearance-resolution';

const root = document.documentElement;

function clearAppearanceCarriers(): void {
  root.classList.remove('dark');
  root.removeAttribute('data-theme');
  root.removeAttribute('data-density');
  root.removeAttribute('data-room-list');
  root.removeAttribute('data-code-lines');
  root.style.removeProperty('font-size');
  root.style.removeProperty('--trinity-code-scale');
}

describe('BrowserAppearanceDocumentAdapter', () => {
  afterEach(clearAppearanceCarriers);

  function adapter(): BrowserAppearanceDocumentAdapter {
    TestBed.configureTestingModule({
      providers: [BrowserAppearanceDocumentAdapter],
    });
    return TestBed.inject(BrowserAppearanceDocumentAdapter);
  }

  it('owns every existing document carrier', () => {
    const value: ResolvedAppearance = {
      mode: 'dark',
      theme: 'amethyst',
      textSize: 'larger',
      density: 'compact',
      roomList: 'compact',
      codeSize: 'larger',
      codeLinePresentation: 'always',
    };

    adapter().apply(value);

    expect(root.classList.contains('dark')).toBe(true);
    expect(root.getAttribute('data-theme')).toBe('amethyst');
    expect(root.style.fontSize).toBe('125%');
    expect(root.getAttribute('data-density')).toBe('compact');
    expect(root.getAttribute('data-room-list')).toBe('compact');
    expect(root.style.getPropertyValue('--trinity-code-scale')).toBe('1.15');
    expect(root.getAttribute('data-code-lines')).toBe('always');
  });

  it('sets data-density for spacious and clears it again for cosy', () => {
    const documentAdapter = adapter();
    const base: ResolvedAppearance = {
      mode: 'light',
      theme: 'trinity',
      textSize: 'default',
      density: 'spacious',
      roomList: 'rich',
      codeSize: 'default',
      codeLinePresentation: 'auto',
    };

    documentAdapter.apply(base);
    expect(root.getAttribute('data-density')).toBe('spacious');

    documentAdapter.apply({ ...base, density: 'cosy' });
    expect(root.hasAttribute('data-density')).toBe(false);
  });

  it('sets data-room-list for compact and clears it again for rich', () => {
    const documentAdapter = adapter();
    const base: ResolvedAppearance = {
      mode: 'light',
      theme: 'trinity',
      textSize: 'default',
      density: 'cosy',
      roomList: 'compact',
      codeSize: 'default',
      codeLinePresentation: 'auto',
    };

    documentAdapter.apply(base);
    expect(root.getAttribute('data-room-list')).toBe('compact');

    documentAdapter.apply({ ...base, roomList: 'rich' });
    expect(root.hasAttribute('data-room-list')).toBe(false);
  });

  it('removes every optional carrier for default axes', () => {
    const documentAdapter = adapter();
    documentAdapter.apply({
      mode: 'dark',
      theme: 'midnight',
      textSize: 'small',
      density: 'compact',
      roomList: 'compact',
      codeSize: 'smaller',
      codeLinePresentation: 'off',
    });

    documentAdapter.apply({
      mode: 'light',
      theme: 'trinity',
      textSize: 'default',
      density: 'cosy',
      roomList: 'rich',
      codeSize: 'default',
      codeLinePresentation: 'auto',
    });

    expect(root.classList.contains('dark')).toBe(false);
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(root.style.fontSize).toBe('');
    expect(root.hasAttribute('data-density')).toBe(false);
    expect(root.hasAttribute('data-room-list')).toBe(false);
    expect(root.style.getPropertyValue('--trinity-code-scale')).toBe('');
    expect(root.hasAttribute('data-code-lines')).toBe(false);
  });

  for (const theme of THEME_CATALOG.themes) {
    it(`activates ${theme.id} from Theme catalog metadata`, () => {
      adapter().apply({
        mode: 'light',
        theme: theme.id,
        textSize: 'default',
        density: 'cosy',
        roomList: 'rich',
        codeSize: 'default',
        codeLinePresentation: 'auto',
      });

      expect(root.getAttribute('data-theme')).toBe(theme.dataTheme);
    });
  }
});

describe('iOS Dynamic Type', () => {
  const appearance: ResolvedAppearance = {
    mode: 'light',
    theme: 'trinity',
    textSize: 'default',
    density: 'cosy',
    roomList: 'rich',
    codeSize: 'default',
    codeLinePresentation: 'auto',
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document
      .querySelectorAll('span[style*="apple-system-body"]')
      .forEach((e) => e.remove());
    root.style.removeProperty('font-size');
  });

  function iosAdapter(bodyPx: () => string): BrowserAppearanceDocumentAdapter {
    vi.stubGlobal('CSS', { supports: () => true });
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) =>
      el instanceof HTMLSpanElement
        ? ({ fontSize: bodyPx() } as CSSStyleDeclaration)
        : real(el),
    );
    TestBed.configureTestingModule({
      providers: [BrowserAppearanceDocumentAdapter],
    });
    return TestBed.inject(BrowserAppearanceDocumentAdapter);
  }

  it('is 1 without a probe and 40/17 at accessibility extra large', () => {
    expect(deviceTextScale(null, window)).toBe(1);
    const probe = document.createElement('span');
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      fontSize: '17px',
    } as CSSStyleDeclaration);
    expect(deviceTextScale(probe, window)).toBe(1);
    vi.mocked(window.getComputedStyle).mockReturnValue({
      fontSize: '40px',
    } as CSSStyleDeclaration);
    expect(deviceTextScale(probe, window)).toBeCloseTo(40 / 17);
  });

  it('leaves the root alone at the default device size', () => {
    iosAdapter(() => '17px').apply(appearance);
    expect(root.style.fontSize).toBe('');
  });

  it('scales the app setting relative to the device size, and follows it live', () => {
    let body = '40px';
    const adapter = iosAdapter(() => body);
    adapter.apply({ ...appearance, textSize: 'larger' });
    expect(parseFloat(root.style.fontSize)).toBeCloseTo((125 * 40) / 17);

    body = '17px';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(root.style.fontSize).toBe('125%');
  });
});
