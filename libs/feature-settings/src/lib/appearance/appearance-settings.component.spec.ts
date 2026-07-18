import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ThemeService,
  type ResolvedTheme,
  type ThemePreference,
} from '@trinity/platform-native';
import { AppearanceSettingsComponent } from './appearance-settings.component';

describe('AppearanceSettingsComponent', () => {
  let preference: ReturnType<typeof signal<ThemePreference>>;
  let resolved: ReturnType<typeof signal<ResolvedTheme>>;

  beforeEach(() => {
    preference = signal<ThemePreference>('system');
    resolved = signal<ResolvedTheme>('dark');
  });

  function renderPage() {
    return render(AppearanceSettingsComponent, {
      providers: [MockProvider(ThemeService, { preference, resolved })],
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
});
