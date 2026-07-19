import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ThemeService,
  TRINITY_PALETTES,
  type Palette,
  type ResolvedTheme,
  type ThemePreference,
} from '@trinity/platform-native';
import { AppearanceSettingsComponent } from './appearance-settings.component';

describe('AppearanceSettingsComponent', () => {
  let preference: ReturnType<typeof signal<ThemePreference>>;
  let resolved: ReturnType<typeof signal<ResolvedTheme>>;
  let palette: ReturnType<typeof signal<Palette>>;

  beforeEach(() => {
    preference = signal<ThemePreference>('system');
    resolved = signal<ResolvedTheme>('dark');
    palette = signal<Palette>('trinity');
  });

  function renderPage() {
    return render(AppearanceSettingsComponent, {
      providers: [
        MockProvider(ThemeService, {
          preference,
          resolved,
          palette,
          palettes: TRINITY_PALETTES,
        }),
      ],
    });
  }

  it('renders the theme options bound to the current preference', async () => {
    const { container } = await renderPage();

    expect(container.querySelectorAll('[data-testid^=theme-]').length).toBe(3);
    // The bound preference ('system') is reflected on the native radio input.
    const systemInput = container.querySelector<HTMLInputElement>(
      '[data-testid=theme-system] input',
    );
    expect(systemInput?.checked).toBe(true);
    expect(container.textContent).toContain('dark'); // resolved-theme note
  });

  it('applies the chosen theme on change', async () => {
    const { fixture } = await renderPage();

    fixture.componentInstance.onThemeChange('light');

    expect(TestBed.inject(ThemeService).setPreference).toHaveBeenCalledWith(
      'light',
    );
  });

  it('gives both radio groups an accessible name via aria-labelledby', async () => {
    const { container } = await renderPage();

    const groups = container.querySelectorAll('hlm-radio-group');
    expect(groups.length).toBe(2);
    for (const group of groups) {
      const id = group.getAttribute('aria-labelledby');
      expect(id).toBeTruthy();
      const label = container.querySelector(`#${id}`);
      expect(label?.textContent?.trim()).toBeTruthy();
    }
  });

  it('renders one option per registered palette, bound to the current palette', async () => {
    const { container } = await renderPage();

    const options = container.querySelectorAll('[data-testid^=palette-]');
    expect(options.length).toBe(TRINITY_PALETTES.length);
    // The bound palette ('trinity') is reflected on its native radio input.
    const trinityInput = container.querySelector<HTMLInputElement>(
      '[data-testid=palette-trinity] input',
    );
    expect(trinityInput?.checked).toBe(true);
    expect(container.textContent).toContain('Amethyst');
  });

  it('applies the chosen palette on change', async () => {
    const { fixture } = await renderPage();

    fixture.componentInstance.onPaletteChange('amethyst');

    expect(TestBed.inject(ThemeService).setPalette).toHaveBeenCalledWith(
      'amethyst',
    );
  });
});
