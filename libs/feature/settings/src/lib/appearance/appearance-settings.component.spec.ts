import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { THEME_CATALOG } from '@trinity/theme-foundation';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  ComposerSettingsService,
  SystemLineSettingsService,
  ThemeService,
  TRINITY_TEXT_SCALES,
  TRINITY_CODE_SCALES,
  TRINITY_CODE_LINE_MODES,
  TRINITY_DENSITIES,
  type CodeLineMode,
  type CodeScale,
  type Density,
  type Palette,
  type ResolvedTheme,
  type TextScale,
  type ThemePreference,
} from '@trinity/platform-native';
import { By } from '@angular/platform-browser';
import { TrnSwitchComponent } from '@trinity/components/controls';
import { DateTimeFormatService } from '@trinity/platform-native';
import {
  SpaceRoomOrderService,
  TRINITY_ROOM_SORTS,
  type RoomSortMode,
} from '@trinity/data-access/room-library';
import { AppearanceSettingsComponent } from './appearance-settings.component';
import { of } from 'rxjs';

describe('AppearanceSettingsComponent', () => {
  let preference: ReturnType<typeof signal<ThemePreference>>;
  let resolved: ReturnType<typeof signal<ResolvedTheme>>;
  let palette: ReturnType<typeof signal<Palette>>;
  let textScale: ReturnType<typeof signal<TextScale>>;
  let codeScale: ReturnType<typeof signal<CodeScale>>;
  let codeLines: ReturnType<typeof signal<CodeLineMode>>;
  let density: ReturnType<typeof signal<Density>>;
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
  let formatOnSelection: ReturnType<typeof signal<boolean>>;
  let setFormatOnSelection: Mock;

  beforeEach(() => {
    preference = signal<ThemePreference>('system');
    resolved = signal<ResolvedTheme>('dark');
    palette = signal<Palette>('trinity');
    textScale = signal<TextScale>('default');
    codeScale = signal<CodeScale>('default');
    codeLines = signal<CodeLineMode>('auto');
    density = signal<Density>('cosy');
    showMembership = signal(true);
    showProfile = signal(true);
    showRoomChanges = signal(true);
    setShowMembership = vi.fn();
    setShowProfile = vi.fn();
    setShowRoomChanges = vi.fn();
    spaceOrderDefault = signal<RoomSortMode>('recent');
    setDefault = vi.fn(() => of(void 0));
    showFormattingToolbar = signal(true);
    setShowFormattingToolbar = vi.fn();
    formatOnSelection = signal(true);
    setFormatOnSelection = vi.fn();
  });

  function renderPage() {
    return render(AppearanceSettingsComponent, {
      providers: [
        MockProvider(ThemeService, {
          preference,
          resolved,
          palette,
          palettes: THEME_CATALOG.themes,
          textScale,
          textScales: TRINITY_TEXT_SCALES,
          codeScale,
          codeScales: TRINITY_CODE_SCALES,
          codeLines,
          codeLineModes: TRINITY_CODE_LINE_MODES,
          density,
          densities: TRINITY_DENSITIES,
        }),
        MockProvider(ComposerSettingsService, {
          showFormattingToolbar,
          setShowFormattingToolbar,
          formatOnSelection,
          setFormatOnSelection,
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

  it('groups the content into the prototype-aligned settings rhythm', async () => {
    const { container } = await renderPage();

    expect(
      container.querySelector('[data-testid=appearance-mode-palette]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid=appearance-layout]'),
    ).not.toBeNull();
    expect(
      container.querySelectorAll('[trnSettingsFieldRow]').length,
    ).toBeGreaterThanOrEqual(5);
    expect(
      container.querySelector('trn-radio-group')?.getAttribute('data-variant'),
    ).toBe('segmented');
  });

  it('renders a labelled live preview of the active appearance recipe', async () => {
    const { container, fixture } = await renderPage();
    const preview = container.querySelector('[data-testid=appearance-preview]');
    const state = container.querySelector(
      '[data-testid=appearance-preview-state]',
    );

    expect(preview).not.toBeNull();
    expect(preview?.getAttribute('aria-hidden')).toBe('true');
    expect(state?.textContent).toContain('dark · Trinity · Cosy');

    resolved.set('light');
    palette.set('onyx');
    density.set('compact');
    fixture.detectChanges();

    expect(state?.textContent).toContain('light · Onyx · Compact');
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
      ...Array.from(container.querySelectorAll('trn-select [role=combobox]')),
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
    // Presence and shape only — what each dropdown SHOWS for the stored preference is the
    // test below, which is the one #168 is about.
    it('renders both format dropdowns as select controls', async () => {
      const { container } = await renderPage();

      for (const testid of ['time-format-select', 'date-format-select']) {
        const select = container.querySelector(`[data-testid=${testid}]`);
        expect(select?.tagName.toLowerCase(), testid).toBe('trn-select');
        expect(select?.querySelector('button'), testid).not.toBeNull();
      }
    });

    // #168. The trigger renders from the bound VALUE, not from the chosen item's markup, so
    // a select with no label lookup showed `h24` and `dmy` — identifiers that appear nowhere
    // else in the UI, in place of the worked example the reader had just clicked.
    // `<trn-select>` derives the label from the options it already holds, and this pins the
    // user-visible result for the two dropdowns that were wrong.
    //
    // `h24`/`dmy` rather than the default `system` on purpose: 'Match system' CONTAINS
    // 'system', so the negative half of the assertion would pass on the defect itself.
    // Only the label's stable half is asserted — the parenthetical sample is locale-derived
    // and belongs to the sample-instant test above.
    it('shows each chosen format’s label on the collapsed trigger, not the stored id', async () => {
      const { fixture, container } = await renderPage();
      const format = TestBed.inject(DateTimeFormatService);

      format.setTimeFormat('h24');
      format.setDateFormat('dmy');
      fixture.detectChanges();

      const triggerText = (testid: string) =>
        container.querySelector(`[data-testid=${testid}] hlm-select-trigger`)
          ?.textContent ?? '';

      expect(triggerText('time-format-select')).toContain('24-hour');
      expect(triggerText('time-format-select')).not.toContain('h24');
      expect(triggerText('date-format-select')).toContain('Day first');
      expect(triggerText('date-format-select')).not.toContain('dmy');
    });

    it('re-previews the options when the system locale changes', async () => {
      // The regression this pins. The option lists were built once, in a field initializer,
      // so their preview text froze at construction. `sample` is a fixed instant on purpose,
      // but the preview formats it through `prefs()`, whose locales come from a
      // `languagechange` listener — and Android keeps the WebView alive across an OS
      // language change (`locale` sits in the Activity's `configChanges`). The paragraph
      // below the dropdowns stayed a live template call, so the same screen ended up
      // previewing "Match system" two contradictory ways.
      //
      // Driven through the real mechanism — stub the chain `systemLocales()` reads, then
      // fire the event the service listens for — rather than poking a setter, because the
      // service exposes none and the event is what actually happens on device.
      const languages = vi.spyOn(navigator, 'languages', 'get');

      languages.mockReturnValue(['en-US']);
      const { fixture, container } = await renderPage();
      window.dispatchEvent(new Event('languagechange'));
      fixture.detectChanges();
      const before =
        container.querySelector('[data-testid=time-format-select]')
          ?.textContent ?? '';

      languages.mockReturnValue(['de-DE']);
      window.dispatchEvent(new Event('languagechange'));
      fixture.detectChanges();

      expect(before).not.toBe('');
      expect(
        container.querySelector('[data-testid=time-format-select]')
          ?.textContent,
      ).not.toBe(before);
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

    // the kit select's valueChange is typed `string | null | undefined`, so the handlers guard
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
      // The select renders the trigger from the bound VALUE rather than the chosen option's
      // markup, so a control that just echoed the value would read "recent" here. This used
      // to be asserted through the component's own `spaceOrderLabel` lookup, which existed
      // only to feed the kit's `itemToString`; `<trn-select>` derives it from the options it
      // already holds, so the lookup is gone and the rendered trigger is the thing to check.
      const { container } = await renderPage();
      const trigger = container.querySelector(
        '[data-testid="space-order-select"] hlm-select-trigger',
      );

      expect(trigger?.textContent).toContain('Recent activity');
      expect(trigger?.textContent).not.toContain('recent');
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
    // trn-select with a trigger button.
    const { container } = await renderPage();

    const select = container.querySelector('[data-testid=palette-select]');
    expect(select?.tagName.toLowerCase()).toBe('trn-select');
    expect(select?.querySelector('button')).not.toBeNull();
  });

  // #168, and the quietest of the three: the palette dropdown lost only a capital letter,
  // reading `amethyst` under an option labelled 'Amethyst'. `toContain` is case-sensitive,
  // which is the whole reason the negative half of this assertion can still fail.
  it('shows the chosen palette’s label on the collapsed trigger, not the stored id', async () => {
    palette.set('amethyst');
    const { container } = await renderPage();

    const trigger = container.querySelector(
      '[data-testid="palette-select"] hlm-select-trigger',
    );

    expect(trigger?.textContent).toContain('Amethyst');
    expect(trigger?.textContent).not.toContain('amethyst');
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

  /** The `trn-switch` inside the labelled toggle with the given testid. */
  function switchFor(fixture: unknown, testid: string) {
    return (
      fixture as { debugElement: { queryAll: (p: unknown) => unknown[] } }
    ).debugElement
      .queryAll(By.directive(TrnSwitchComponent))
      .find((c) =>
        (c as { nativeElement: HTMLElement }).nativeElement.closest(
          `[data-testid=${testid}]`,
        ),
      ) as { componentInstance: TrnSwitchComponent } | undefined;
  }

  // Each switch is a separate binding, so a copy-paste slip (profile bound to
  // showMembership) would otherwise ship green — nothing else covers this wiring.
  it('reflects each timeline category independently', async () => {
    showProfile.set(false);
    const { fixture } = await renderPage();

    expect(
      switchFor(
        fixture,
        'timeline-show-membership',
      )!.componentInstance.checked(),
    ).toBe(true);
    expect(
      switchFor(fixture, 'timeline-show-profile')!.componentInstance.checked(),
    ).toBe(false);
    expect(
      switchFor(
        fixture,
        'timeline-show-room-changes',
      )!.componentInstance.checked(),
    ).toBe(true);
  });

  it('writes each timeline toggle to its own setter', async () => {
    const { fixture } = await renderPage();

    switchFor(
      fixture,
      'timeline-show-profile',
    )!.componentInstance.checkedChange.emit(false);
    expect(setShowProfile).toHaveBeenCalledWith(false);
    // The neighbouring switches must not move — they are separate preferences.
    expect(setShowMembership).not.toHaveBeenCalled();
    expect(setShowRoomChanges).not.toHaveBeenCalled();

    switchFor(
      fixture,
      'timeline-show-membership',
    )!.componentInstance.checkedChange.emit(false);
    expect(setShowMembership).toHaveBeenCalledWith(false);

    switchFor(
      fixture,
      'timeline-show-room-changes',
    )!.componentInstance.checkedChange.emit(false);
    expect(setShowRoomChanges).toHaveBeenCalledWith(false);
  });
  it('reflects and sets the formatting-toolbar preference', async () => {
    showFormattingToolbar.set(false);
    const { fixture } = await renderPage();

    const toggle = switchFor(fixture, 'composer-show-toolbar')!;
    expect(toggle.componentInstance.checked()).toBe(false);

    toggle.componentInstance.checkedChange.emit(true);
    expect(setShowFormattingToolbar).toHaveBeenCalledWith(true);
  });

  it('reflects and sets the raise-on-selection preference', async () => {
    // Its own switch and its own setter. The two are separate preferences precisely so they
    // can disagree, so a test that only drove the pinned one would not notice them re-merged.
    formatOnSelection.set(false);
    const { fixture } = await renderPage();

    const toggle = switchFor(fixture, 'composer-format-on-selection')!;
    expect(toggle.componentInstance.checked()).toBe(false);

    toggle.componentInstance.checkedChange.emit(true);
    expect(setFormatOnSelection).toHaveBeenCalledWith(true);
    expect(setShowFormattingToolbar).not.toHaveBeenCalled();
  });
});
