import { Capacitor } from '@capacitor/core';
import { TrnAlertService, TrnToastService } from '@trinity/helm/overlay';
import {
  APP_CONFIG_ENTRIES,
  AppConfigService,
  type ConfigEntry,
} from '@trinity/platform-native';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { AdvancedSettingsComponent } from './advanced-settings.component';
import {
  RESET_CONFIG_CONFIRMATION_WORD,
  RESET_CONFIG_MISTYPED_MESSAGE,
} from './reset-config';

/** A registry standing in for the app's, wired the way `main.ts` wires the real one. */
const ENTRIES: readonly ConfigEntry[] = [
  {
    path: 'theme.palette',
    key: 'trinity.palette',
    read: () => 'violet',
    reset: () => undefined,
  },
  {
    path: 'gif.apiKey',
    key: 'trinity.gif.config',
    read: () => 'gif-key',
    reset: () => undefined,
  },
];

/** Let the pending promise chain (prompt → reset → toast) settle. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve));

function textareaValue(container: Element): string {
  return (
    container.querySelector(
      '[data-testid=advanced-config-json]',
    ) as HTMLTextAreaElement
  ).value;
}

function button(container: Element, testid: string): HTMLButtonElement | null {
  return container.querySelector(`[data-testid=${testid}]`);
}

describe('AdvancedSettingsComponent', () => {
  let alertPrompt: Mock;
  let toastShow: Mock;
  let writeText: Mock;
  let resetToDefaults: Mock;

  beforeEach(() => {
    alertPrompt = vi.fn().mockResolvedValue(RESET_CONFIG_CONFIRMATION_WORD);
    toastShow = vi.fn();
    writeText = vi.fn().mockResolvedValue(undefined);
    resetToDefaults = vi.fn(() => of(undefined));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  /** The real {@link AppConfigService} over {@link ENTRIES} — the document is truly built. */
  function realConfig() {
    return [
      { provide: APP_CONFIG_ENTRIES, multi: true, useValue: ENTRIES },
      MockProvider(TrnAlertService, { prompt: alertPrompt }),
      MockProvider(TrnToastService, { show: toastShow }),
    ];
  }

  /** A mocked service, for the actions that have to be observed being called. */
  function mockedConfig(json = '{"version":1}') {
    return [
      MockProvider(AppConfigService, {
        exportJson: () => json,
        resetToDefaults,
      }),
      MockProvider(TrnAlertService, { prompt: alertPrompt }),
      MockProvider(TrnToastService, { show: toastShow }),
    ];
  }

  it('renders the live config as pretty-printed JSON', async () => {
    const { container } = await render(AdvancedSettingsComponent, {
      providers: realConfig(),
    });

    const json = textareaValue(container);
    expect(JSON.parse(json)).toMatchObject({
      version: 1,
      settings: { theme: { palette: 'violet' } },
    });
    // Two-space indent: what people paste around, and part of the committed format.
    expect(json).toContain('\n  "version": 1');
  });

  it('shows nothing the export excludes — no drafts, tokens or account registry', async () => {
    const { container } = await render(AdvancedSettingsComponent, {
      providers: realConfig(),
    });

    // The omissions are structural (the document is built from the registered entries and
    // nothing else), so this asserts the surface honours that rather than filtering later.
    const json = textareaValue(container);
    for (const forbidden of [
      'drafts',
      'accessToken',
      'matrix.accounts',
      'applied-app-id',
      'oidc',
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('says the document is preferences only, and names what it leaves out', async () => {
    const { container } = await render(AdvancedSettingsComponent, {
      providers: realConfig(),
    });

    const text = container.textContent ?? '';
    expect(text).toContain('no access tokens');
    expect(text).toContain('preferences transfer, not a sign-in transfer');
    expect(
      container.querySelectorAll('[data-testid=advanced-exclusions] li').length,
    ).toBeGreaterThan(0);
  });

  it('copies exactly the document it shows', async () => {
    const { container } = await render(AdvancedSettingsComponent, {
      providers: realConfig(),
    });
    const shown = textareaValue(container);

    button(container, 'advanced-copy')?.click();
    await flush();

    expect(writeText).toHaveBeenCalledWith(shown);
    expect(toastShow).toHaveBeenCalledWith(
      'Settings copied.',
      expect.anything(),
    );
  });

  it('says so rather than claiming success when the clipboard write fails', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    const { container } = await render(AdvancedSettingsComponent, {
      providers: realConfig(),
    });

    button(container, 'advanced-copy')?.click();
    await flush();

    expect(toastShow).toHaveBeenCalledWith(
      'Could not copy your settings.',
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('offers the file export on web/desktop', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    const { container } = await render(AdvancedSettingsComponent, {
      providers: realConfig(),
    });

    expect(button(container, 'advanced-export')).not.toBeNull();
    expect(
      container.querySelector('[data-testid=advanced-export-unavailable]'),
    ).toBeNull();
  });

  it('downloads the document as a dated JSON file', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    const { container } = await render(AdvancedSettingsComponent, {
      providers: mockedConfig('{"version":1}'),
    });

    // Stubbed only now: an anchor returned for every createElement would break rendering.
    const anchor = document.createElement('a');
    const click = vi.spyOn(anchor, 'click').mockImplementation(() => undefined);
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockReturnValue(anchor);
    button(container, 'advanced-export')?.click();
    createElement.mockRestore();

    expect(click).toHaveBeenCalled();
    expect(anchor.download).toMatch(
      /^trinity-settings-\d{4}-\d{2}-\d{2}\.json$/,
    );
    expect(decodeURIComponent(anchor.href)).toContain('{"version":1}');
  });

  it('replaces the file export with an explanation on native, never hiding it silently', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    const { container } = await render(AdvancedSettingsComponent, {
      providers: realConfig(),
    });

    expect(button(container, 'advanced-export')).toBeNull();
    const note = container.querySelector(
      '[data-testid=advanced-export-unavailable]',
    );
    expect(note?.textContent).toContain('clipboard');
    // Copy is the primary path on native, so it has to still be there.
    expect(button(container, 'advanced-copy')).not.toBeNull();
  });

  it('resets only after the confirmation word is typed', async () => {
    const { container } = await render(AdvancedSettingsComponent, {
      providers: mockedConfig(),
    });

    button(container, 'advanced-reset')?.click();
    await flush();

    expect(alertPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ destructive: true }),
    );
    expect(resetToDefaults).toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(
      'Settings reset to defaults.',
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('resets nothing when the gate is cancelled', async () => {
    alertPrompt.mockResolvedValue(null);
    const { fixture } = await render(AdvancedSettingsComponent, {
      providers: mockedConfig(),
    });

    await fixture.componentInstance.reset();

    expect(resetToDefaults).not.toHaveBeenCalled();
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('resets nothing on a mistype, and says why', async () => {
    alertPrompt.mockResolvedValue('defaluts');
    const { fixture } = await render(AdvancedSettingsComponent, {
      providers: mockedConfig(),
    });

    await fixture.componentInstance.reset();

    expect(resetToDefaults).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(
      RESET_CONFIG_MISTYPED_MESSAGE,
      expect.anything(),
    );
    expect(RESET_CONFIG_MISTYPED_MESSAGE).toContain(
      RESET_CONFIG_CONFIRMATION_WORD,
    );
  });

  it('re-enables the reset button when the reset fails', async () => {
    resetToDefaults.mockReturnValue(throwError(() => new Error('nope')));
    const { container, fixture } = await render(AdvancedSettingsComponent, {
      providers: mockedConfig(),
    });

    await fixture.componentInstance.reset();
    fixture.detectChanges();

    expect(fixture.componentInstance.resetting()).toBe(false);
    expect(button(container, 'advanced-reset')?.disabled).toBe(false);
    expect(toastShow).toHaveBeenCalledWith(
      'Could not reset every setting.',
      expect.objectContaining({ variant: 'destructive' }),
    );
  });
});
