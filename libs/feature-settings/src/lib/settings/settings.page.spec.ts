import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ThemeService,
  type ResolvedTheme,
  type ThemePreference,
} from '@trinity/core';
import { SettingsPage } from './settings.page';

describe('SettingsPage', () => {
  const setPreference = vi.fn();
  let preference: ReturnType<typeof signal<ThemePreference>>;
  let resolved: ReturnType<typeof signal<ResolvedTheme>>;

  beforeEach(() => {
    setPreference.mockReset();
    preference = signal<ThemePreference>('system');
    resolved = signal<ResolvedTheme>('dark');
    TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [
        {
          provide: ThemeService,
          useValue: { preference, resolved, setPreference },
        },
      ],
    });
  });

  it('renders the appearance options bound to the current preference', () => {
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelectorAll('ion-radio').length).toBe(3);
    expect(el.querySelector('[data-testid=theme-system]')).not.toBeNull();
    // Angular binds [value] to the element property, not the attribute.
    const group = el.querySelector('ion-radio-group') as
      | (HTMLElement & { value: string })
      | null;
    expect(group?.value).toBe('system');
    expect(el.textContent).toContain('dark'); // resolved-theme note
  });

  it('applies the chosen theme on change', () => {
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();

    fixture.componentInstance.onThemeChange(
      new CustomEvent('ionChange', { detail: { value: 'light' } }),
    );

    expect(setPreference).toHaveBeenCalledWith('light');
  });
});
