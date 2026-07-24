import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SystemLineSettingsService,
  ThemeService,
  TRINITY_PALETTES,
  type Palette,
  type ResolvedTheme,
  type ThemePreference,
} from '@trinity/platform-native';
import { By } from '@angular/platform-browser';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import { AppearanceSettingsComponent } from './appearance-settings.component';

describe('AppearanceSettingsComponent', () => {
  let preference: ReturnType<typeof signal<ThemePreference>>;
  let resolved: ReturnType<typeof signal<ResolvedTheme>>;
  let palette: ReturnType<typeof signal<Palette>>;
  let showMembership: ReturnType<typeof signal<boolean>>;
  let showProfile: ReturnType<typeof signal<boolean>>;
  let showRoomChanges: ReturnType<typeof signal<boolean>>;
  let setShowMembership: ReturnType<typeof vi.fn>;
  let setShowProfile: ReturnType<typeof vi.fn>;
  let setShowRoomChanges: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    preference = signal<ThemePreference>('system');
    resolved = signal<ResolvedTheme>('dark');
    palette = signal<Palette>('trinity');
    showMembership = signal(true);
    showProfile = signal(true);
    showRoomChanges = signal(true);
    setShowMembership = vi.fn();
    setShowProfile = vi.fn();
    setShowRoomChanges = vi.fn();
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
        MockProvider(SystemLineSettingsService, {
          showMembership,
          showProfile,
          showRoomChanges,
          setShowMembership,
          setShowProfile,
          setShowRoomChanges,
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

  it('gives the mode group and palette select an accessible name via aria-labelledby', async () => {
    const { container } = await renderPage();

    const labelled = [
      container.querySelector('hlm-radio-group'),
      container.querySelector('[data-testid=palette-select]'),
    ];
    for (const control of labelled) {
      const id = control?.getAttribute('aria-labelledby');
      expect(id).toBeTruthy();
      expect(
        container.querySelector(`#${id}`)?.textContent?.trim(),
      ).toBeTruthy();
    }
  });

  it('renders the palette dropdown as a select control', async () => {
    // The option list renders in a CDK overlay only once opened (needs a real browser —
    // ResizeObserver/scrollIntoView are absent in jsdom), so the open→select round-trip
    // is covered in e2e (settings.spec.mts). Here: the control is present and is an
    // hlm-select with a trigger button.
    const { container } = await renderPage();

    const select = container.querySelector('[data-testid=palette-select]');
    expect(select?.tagName.toLowerCase()).toBe('hlm-select');
    expect(select?.querySelector('button')).not.toBeNull();
  });

  it('applies the chosen palette when the dropdown emits a value', async () => {
    const { fixture } = await renderPage();

    fixture.componentInstance.onPaletteChange('amethyst');

    expect(TestBed.inject(ThemeService).setPalette).toHaveBeenCalledWith(
      'amethyst',
    );
  });

  it('ignores a cleared (null) palette value', async () => {
    const { fixture } = await renderPage();

    fixture.componentInstance.onPaletteChange(null);

    expect(TestBed.inject(ThemeService).setPalette).not.toHaveBeenCalled();
  });

  /** The `hlm-checkbox` inside the labelled toggle with the given testid. */
  function checkboxFor(fixture: unknown, testid: string) {
    return (
      fixture as { debugElement: { queryAll: (p: unknown) => unknown[] } }
    ).debugElement
      .queryAll(By.directive(HlmCheckbox))
      .find((c) =>
        (c as { nativeElement: HTMLElement }).nativeElement.closest(
          `[data-testid=${testid}]`,
        ),
      ) as { componentInstance: HlmCheckbox } | undefined;
  }

  // Each switch is a separate binding, so a copy-paste slip (profile bound to
  // showMembership) would otherwise ship green — nothing else covers this wiring.
  it('reflects each timeline category independently', async () => {
    showProfile.set(false);
    const { fixture } = await renderPage();

    expect(
      checkboxFor(
        fixture,
        'timeline-show-membership',
      )!.componentInstance.checked(),
    ).toBe(true);
    expect(
      checkboxFor(
        fixture,
        'timeline-show-profile',
      )!.componentInstance.checked(),
    ).toBe(false);
    expect(
      checkboxFor(
        fixture,
        'timeline-show-room-changes',
      )!.componentInstance.checked(),
    ).toBe(true);
  });

  it('writes each timeline toggle to its own setter', async () => {
    const { fixture } = await renderPage();

    checkboxFor(
      fixture,
      'timeline-show-profile',
    )!.componentInstance.checkedChange.emit(false);
    expect(setShowProfile).toHaveBeenCalledWith(false);
    // The neighbouring switches must not move — they are separate preferences.
    expect(setShowMembership).not.toHaveBeenCalled();
    expect(setShowRoomChanges).not.toHaveBeenCalled();

    checkboxFor(
      fixture,
      'timeline-show-membership',
    )!.componentInstance.checkedChange.emit(false);
    expect(setShowMembership).toHaveBeenCalledWith(false);

    checkboxFor(
      fixture,
      'timeline-show-room-changes',
    )!.componentInstance.checkedChange.emit(false);
    expect(setShowRoomChanges).toHaveBeenCalledWith(false);
  });
});
