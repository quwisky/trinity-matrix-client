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
  RESET_CONFIG_CONSEQUENCES,
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

/** The exported envelope, as these tests read it back. */
interface Envelope {
  readonly version: number;
  readonly exportedAt: string;
  readonly settings: Record<string, unknown>;
}

function parseEnvelope(json: string): Envelope {
  return JSON.parse(json) as Envelope;
}

/**
 * Intercept the download anchor. Installed only around the click that exports: an anchor
 * returned for every `createElement` would break rendering.
 */
function stubDownloadAnchor(): {
  readonly element: HTMLAnchorElement;
  readonly click: Mock;
  readonly restore: () => void;
} {
  const element = document.createElement('a');
  const click = vi.fn();
  element.click = click;
  const createElement = vi
    .spyOn(document, 'createElement')
    .mockReturnValue(element);
  return { element, click, restore: () => createElement.mockRestore() };
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

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** What the first Copy put on the clipboard. */
  function copiedText(): string {
    return String(writeText.mock.calls[0]?.[0] ?? '');
  }

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

  // What the export leaves out is proved in `app-config.service.spec.ts`, over the real
  // registry and a real DraftStoreService holding real draft text. Asserting it here, over
  // this file's own two-entry stub registry, would only prove that strings absent from the
  // fixture are absent from the fixture — a test that cannot fail. Not repeated on purpose.

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

  // The section carries a third-party API key, and the maintainer's condition for keeping it
  // in the export was that the page says so BEFORE offering a way to send the document
  // anywhere. A disclosure below the buttons is read after the damage.
  it('discloses the GIF API key above Copy and Export, not below them', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    const { container } = await render(AdvancedSettingsComponent, {
      providers: realConfig(),
    });

    const note = container.querySelector('[data-testid=advanced-gif-key-note]');
    expect(note?.textContent).toContain('GIF API key');
    for (const testid of ['advanced-copy', 'advanced-export']) {
      const action = button(container, testid);
      expect(action, `${testid} must be on the page`).not.toBeNull();
      const position =
        note && action ? note.compareDocumentPosition(action) : 0;
      expect(
        position & Node.DOCUMENT_POSITION_FOLLOWING,
        `the disclosure must precede ${testid}`,
      ).toBeGreaterThan(0);
    }
    // Said once: two paragraphs saying the same thing is how one of them goes stale.
    expect(
      container.querySelectorAll('[data-testid=advanced-gif-key-note]').length,
    ).toBe(1);
  });

  it('copies exactly the settings it shows', async () => {
    const { container } = await render(AdvancedSettingsComponent, {
      providers: realConfig(),
    });
    const shown = textareaValue(container);

    button(container, 'advanced-copy')?.click();
    await flush();

    // The settings, not the whole string: `exportedAt` is deliberately re-stamped on the way
    // out (see below), so the envelopes may differ by a timestamp and nothing else.
    const copied = parseEnvelope(copiedText());
    expect(copied.settings).toEqual(parseEnvelope(shown).settings);
    expect(copied.version).toBe(parseEnvelope(shown).version);
    expect(toastShow).toHaveBeenCalledWith(
      'Settings copied.',
      expect.anything(),
    );
  });

  // Opened at 09:00, copied at 17:00: a document memoized at render time would claim it was
  // taken at 09:00 — and PR #135 keys its migration off this envelope.
  it('stamps the copy when it leaves the app, not when the view rendered', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T09:00:00.000Z'));
    const { container } = await render(AdvancedSettingsComponent, {
      providers: realConfig(),
    });
    const rendered = parseEnvelope(textareaValue(container)).exportedAt;

    vi.setSystemTime(new Date('2026-01-01T17:00:00.000Z'));
    button(container, 'advanced-copy')?.click();
    await flush();

    expect(rendered).toBe('2026-01-01T09:00:00.000Z');
    expect(parseEnvelope(copiedText()).exportedAt).toBe(
      '2026-01-01T17:00:00.000Z',
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

    const anchor = stubDownloadAnchor();
    button(container, 'advanced-export')?.click();
    anchor.restore();

    expect(anchor.click).toHaveBeenCalled();
    expect(anchor.element.download).toMatch(
      /^trinity-settings-\d{4}-\d{2}-\d{2}\.json$/,
    );
    expect(decodeURIComponent(anchor.element.href)).toContain('{"version":1}');
  });

  // 12:00 UTC is already the 2nd in Kiritimati: a UTC-dated filename is a day out either
  // side of midnight for most of the world, on the one string people scan a folder for.
  it('dates the file by the user’s calendar, not UTC', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    const timeZone = process.env['TZ'];
    process.env['TZ'] = 'Pacific/Kiritimati';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));

    try {
      const { container } = await render(AdvancedSettingsComponent, {
        providers: mockedConfig(),
      });

      const anchor = stubDownloadAnchor();
      button(container, 'advanced-export')?.click();
      anchor.restore();

      expect(anchor.element.download).toBe('trinity-settings-2026-01-02.json');
    } finally {
      process.env['TZ'] = timeZone;
    }
  });

  it('stamps the exported file when it leaves the app, not when the view rendered', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T09:00:00.000Z'));
    const { container } = await render(AdvancedSettingsComponent, {
      providers: realConfig(),
    });
    const rendered = parseEnvelope(textareaValue(container)).exportedAt;

    vi.setSystemTime(new Date('2026-01-01T17:00:00.000Z'));
    const anchor = stubDownloadAnchor();
    button(container, 'advanced-export')?.click();
    anchor.restore();

    const written = parseEnvelope(
      decodeURIComponent(anchor.element.href).replace(
        /^data:application\/json;charset=utf-8,/,
        '',
      ),
    );
    expect(rendered).toBe('2026-01-01T09:00:00.000Z');
    expect(written.exportedAt).toBe('2026-01-01T17:00:00.000Z');
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

  // Resetting the push gateway deregisters this device's pushers (see
  // `push-config-entries.ts`), which is the one thing here that reaches the server. The gate
  // used to promise the opposite — a promise the user acts on before anything is destroyed.
  it('warns that the reset removes this device’s push registrations', async () => {
    const { container } = await render(AdvancedSettingsComponent, {
      providers: mockedConfig(),
    });

    button(container, 'advanced-reset')?.click();
    await flush();

    expect(RESET_CONFIG_CONSEQUENCES).toContain('push registrations');
    expect(RESET_CONFIG_CONSEQUENCES).not.toContain(
      'nothing on your homeserver changes',
    );
    const prompt: unknown = alertPrompt.mock.calls[0]?.[0];
    expect(prompt).toMatchObject({
      message: expect.stringContaining('push registrations') as unknown,
    });
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
