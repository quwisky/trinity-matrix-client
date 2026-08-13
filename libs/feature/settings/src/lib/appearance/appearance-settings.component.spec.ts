import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  ComposerSettingsService,
  SystemLineSettingsService,
  ThemeService,
  TRINITY_PALETTES,
  TRINITY_TEXT_SCALES,
  TRINITY_CODE_SCALES,
  TRINITY_CODE_LINE_MODES,
  type CodeLineMode,
  type CodeScale,
  type Palette,
  type ResolvedTheme,
  type TextScale,
  type ThemePreference,
} from '@trinity/platform-native';
import { By } from '@angular/platform-browser';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import { DateTimeFormatService } from '@trinity/platform-native';
import {
  SpaceRoomOrderService,
  TRINITY_ROOM_SORTS,
  type RoomSortMode,
} from '@trinity/data-access/rooms';
import { AppearanceSettingsComponent } from './appearance-settings.component';

describe('AppearanceSettingsComponent', () => {
  let preference: ReturnType<typeof signal<ThemePreference>>;
  let resolved: ReturnType<typeof signal<ResolvedTheme>>;
  let palette: ReturnType<typeof signal<Palette>>;
  let textScale: ReturnType<typeof signal<TextScale>>;
  let codeScale: ReturnType<typeof signal<CodeScale>>;
  let codeLines: ReturnType<typeof signal<CodeLineMode>>;
  let showMembership: ReturnType<typeof signal<boolean>>;
  let showProfile: ReturnType<typeof signal<boolean>>;
  let showRoomChanges: ReturnType<typeof signal<boolean>>;
  let setShowMembership: Mock;
  let setShowProfile: Mock;
  let setShowRoomChanges: Mock;
  let spaceOrderDefault: ReturnType<typeof signal<RoomSortMode>>;
  let setDefault: Mock;
  let showFormattingToolbar: ReturnType<typeof signal<boolean>>;
  let setShowFormattingToolbar: Mock;

  beforeEach(() => {
    preference = signal<ThemePreference>('system');
    resolved = signal<ResolvedTheme>('dark');
    palette = signal<Palette>('trinity');
    textScale = signal<TextScale>('default');
    codeScale = signal<CodeScale>('default');
    codeLines = signal<CodeLineMode>('auto');
    showMembership = signal(true);
    showProfile = signal(true);
    showRoomChanges = signal(true);
    setShowMembership = vi.fn();
    setShowProfile = vi.fn();
    setShowRoomChanges = vi.fn();
    spaceOrderDefault = signal<RoomSortMode>('recent');
    setDefault = vi.fn();
    showFormattingToolbar = signal(true);
    setShowFormattingToolbar = vi.fn();
  });

  function renderPage() {
    return render(AppearanceSettingsComponent, {
      providers: [
        MockProvider(ThemeService, {
          preference,
          resolved,
          palette,
          palettes: TRINITY_PALETTES,
          textScale,
          textScales: TRINITY_TEXT_SCALES,
          codeScale,
          codeScales: TRINITY_CODE_SCALES,
          codeLines,
          codeLineModes: TRINITY_CODE_LINE_MODES,
        }),
        MockProvider(ComposerSettingsService, {
          showFormattingToolbar,
          setShowFormattingToolbar,
        }),
        MockProvider(SystemLineSettingsService, {
          showMembership,
          showProfile,
          showRoomChanges,
          setShowMembership,
          setShowProfile,
          setShowRoomChanges,
        }),
        // Mocked rather than real: the service injects MatrixClientService (this page has
        // no Matrix client) and hydrates from Capacitor Preferences on construction.
        MockProvider(SpaceRoomOrderService, {
          modes: TRINITY_ROOM_SORTS,
          defaultMode: spaceOrderDefault.asReadonly(),
          setDefault,
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

  it('gives every enumerated control an accessible name via aria-labelledby', async () => {
    const { container } = await renderPage();

    const labelled = [
      container.querySelector('hlm-radio-group'),
      container.querySelector('[data-testid=palette-select]'),
      container.querySelector('[data-testid=text-scale-select]'),
      container.querySelector('[data-testid=code-scale-select]'),
      container.querySelector('[data-testid=code-lines-select]'),
      container.querySelector('[data-testid=time-format-select]'),
      container.querySelector('[data-testid=date-format-select]'),
      container.querySelector('[data-testid=space-order-select]'),
    ];
    // Every entry must actually be present, or a missing control would pass this sweep by
    // being null. `text-scale-select` was absent from this list until the code-size block
    // was added beside it.
    expect(labelled.every(Boolean)).toBe(true);
    for (const control of labelled) {
      const id = control?.getAttribute('aria-labelledby');
      expect(id).toBeTruthy();
      expect(
        container.querySelector(`#${id}`)?.textContent?.trim(),
      ).toBeTruthy();
    }
  });

  // The option lists render in a CDK overlay only once opened (jsdom has no
  // ResizeObserver/scrollIntoView), so the open→select round-trip is covered in e2e — same as
  // the palette dropdown above. Here: the controls exist, are bound, and validate what they
  // are handed.
  it('offers every registered text size, bound to the current one', async () => {
    textScale.set('large');
    const { container } = await renderPage();

    const trigger = container.querySelector('[data-testid=text-scale-select]');
    expect(trigger).not.toBeNull();
    expect(trigger!.textContent).toContain('Large');
  });

  it('applies a chosen text size, and ignores an unregistered one', async () => {
    const { fixture } = await renderPage();
    const theme = TestBed.inject(ThemeService);
    const cmp = fixture.componentInstance;

    cmp.onTextScaleChange('larger');
    expect(theme.setTextScale).toHaveBeenCalledWith('larger');

    // The select can only offer registered ids, but the handler takes `string | null` from
    // the Helm output — so it must reject anything else rather than widen the type.
    cmp.onTextScaleChange('gigantic');
    cmp.onTextScaleChange(null);
    expect(theme.setTextScale).toHaveBeenCalledTimes(1);
  });

  describe('date and time', () => {
    it('renders both format dropdowns bound to the current preference', async () => {
      const { container } = await renderPage();
      const format = TestBed.inject(DateTimeFormatService);
      format.setTimeFormat('h24');
      format.setDateFormat('iso');

      for (const testid of ['time-format-select', 'date-format-select']) {
        const select = container.querySelector(`[data-testid=${testid}]`);
        expect(select?.tagName.toLowerCase(), testid).toBe('hlm-select');
        expect(select?.querySelector('button'), testid).not.toBeNull();
      }
    });

    it('shows the current formats applied to a sample instant', async () => {
      const { fixture, container } = await renderPage();
      const format = TestBed.inject(DateTimeFormatService);

      format.setTimeFormat('h24');
      format.setDateFormat('iso');
      fixture.detectChanges();

      expect(
        container.querySelector('[data-testid=date-time-showing]')?.textContent,
      ).toContain('2026-07-24, 15:45');
    });

    // Each handler is a separate binding, so a copy-paste slip (date bound to setTimeFormat)
    // would otherwise ship green — nothing else covers this wiring.
    it('persists each axis independently', async () => {
      const { fixture } = await renderPage();
      const format = TestBed.inject(DateTimeFormatService);

      fixture.componentInstance.onTimeFormatChange('h12');
      expect(format.timeFormat()).toBe('h12');
      expect(format.dateFormat()).toBe('system');

      fixture.componentInstance.onDateFormatChange('dmy');
      expect(format.dateFormat()).toBe('dmy');
      expect(format.timeFormat()).toBe('h12');
    });

    // hlm-select's valueChange is typed `string | null | undefined`, so the handlers guard
    // rather than cast — a stray value must not become the app-wide format.
    it('ignores a value that is not one of the offered ids', async () => {
      const { fixture } = await renderPage();
      const format = TestBed.inject(DateTimeFormatService);
      format.setTimeFormat('h24');

      fixture.componentInstance.onTimeFormatChange(null);
      fixture.componentInstance.onTimeFormatChange('nonsense');

      expect(format.timeFormat()).toBe('h24');
    });
  });

  // Same jsdom caveat as the palette dropdown: the option list lives in a CDK overlay that
  // only renders once opened, so the open→select round-trip is covered in e2e.
  describe('room order in spaces', () => {
    it('renders a select bound to this account’s default', async () => {
      spaceOrderDefault.set('alphabetical');
      const { container } = await renderPage();

      const select = container.querySelector(
        '[data-testid=space-order-select]',
      );
      expect(select).not.toBeNull();
      expect(select?.querySelector('button')).not.toBeNull();
    });

    it('shows the label on the collapsed trigger, not the stored id', async () => {
      // hlm-select renders the trigger from the bound value rather than the chosen option's
      // markup, so without itemToString this control would read "recent".
      const { fixture } = await renderPage();

      expect(fixture.componentInstance.spaceOrderLabel('recent')).toBe(
        'Recent activity',
      );
      expect(fixture.componentInstance.spaceOrderLabel('space')).toBe(
        'Space order',
      );
      // An id we no longer ship falls through rather than blanking the trigger.
      expect(fixture.componentInstance.spaceOrderLabel('a-z')).toBe('a-z');
    });

    it('applies the chosen default', async () => {
      const { fixture } = await renderPage();

      fixture.componentInstance.onSpaceOrderChange('space');

      expect(setDefault).toHaveBeenCalledWith('space');
    });

    it('ignores a value that is not one of the offered ids', async () => {
      const { fixture } = await renderPage();

      fixture.componentInstance.onSpaceOrderChange(null);
      fixture.componentInstance.onSpaceOrderChange(undefined);
      fixture.componentInstance.onSpaceOrderChange('a-z');

      expect(setDefault).not.toHaveBeenCalled();
    });

    it('says the preference is per account and device-local', async () => {
      // The page's other controls are device-wide, so the copy has to carry the difference.
      const { container } = await renderPage();

      expect(container.textContent).toContain(
        'Saved per account on this device',
      );
    });
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
  it('reflects and sets the formatting-toolbar preference', async () => {
    showFormattingToolbar.set(false);
    const { fixture } = await renderPage();

    const toggle = checkboxFor(fixture, 'composer-show-toolbar')!;
    expect(toggle.componentInstance.checked()).toBe(false);

    toggle.componentInstance.checkedChange.emit(true);
    expect(setShowFormattingToolbar).toHaveBeenCalledWith(true);
  });
});
