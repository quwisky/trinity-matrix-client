import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { TrnAlertService, TrnToastService } from '@trinity/kit/overlay';
import {
  APP_CONFIG_ENTRIES,
  AppConfigService,
  type ConfigEntry,
  type ConfigValidation,
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
import { CLIPBOARD_UNREADABLE_MESSAGE } from './import-config';
import {
  RESET_CONFIG_CONFIRMATION_WORD,
  RESET_CONFIG_CONSEQUENCES,
  RESET_CONFIG_MISTYPED_MESSAGE,
} from './reset-config';

/**
 * The fixture's stored state. Signals rather than plain values because that is what the
 * real entries read from: the document is a `computed` over the owning services' signals,
 * and the dirty-state rule this component exists to get right is only testable if a write
 * really does push a new document at the view.
 */
const palette = signal('violet');
const apiKey = signal('gif-key');
const desktopOnly = signal(false);

/** Text in, text out — enough for the two settings the document's shape is checked against. */
function acceptsText(store: { set: (value: string) => void }) {
  return {
    type: 'string',
    write: (value) => store.set(String(value)),
    validate: (value) =>
      typeof value === 'string'
        ? { ok: true, value }
        : { ok: false, problem: 'is not text' },
  } satisfies Pick<ConfigEntry, 'write' | 'validate' | 'type'>;
}

/**
 * A setting that is accepted but inert here — the shape every cross-platform warning has
 * (a desktop shortcut on a phone, a push gateway where there is no push).
 */
function validateDesktopOnly(value: unknown): ConfigValidation {
  if (typeof value !== 'boolean') {
    return { ok: false, problem: 'is not true or false' };
  }
  return value
    ? {
        ok: true,
        value,
        warning: 'the desktop app is the only place this does anything',
      }
    : { ok: true, value };
}

/** A registry standing in for the app's, wired the way `main.ts` wires the real one. */
const ENTRIES: readonly ConfigEntry[] = [
  {
    path: 'theme.palette',
    key: 'trinity.palette',
    description: 'The accent colour the whole app is themed from.',
    read: () => palette(),
    reset: () => palette.set('trinity'),
    ...acceptsText(palette),
  },
  {
    path: 'gif.apiKey',
    key: 'trinity.gif.config',
    description: 'Your own API key for the GIF service.',
    read: () => apiKey(),
    reset: () => apiKey.set(''),
    ...acceptsText(apiKey),
  },
  {
    path: 'desktop.only',
    key: 'trinity.flags.virtual-timeline',
    description: 'A setting only the desktop app acts on.',
    type: 'boolean',
    read: () => desktopOnly(),
    reset: () => desktopOnly.set(false),
    write: (value) => desktopOnly.set(value === true),
    validate: validateDesktopOnly,
  },
];

/** A document that sets only the paths given, as an import would arrive. */
function documentJson(settings: object): string {
  return JSON.stringify({
    version: 1,
    exportedAt: '2026-08-09T00:00:00.000Z',
    settings,
  });
}

/**
 * A synthetic file-input change event carrying a text file. jsdom's `File` has no `.text()`,
 * so stub just what the handler reads — the same shape the security section's spec uses.
 */
function fileEvent(text?: string): Event {
  const files =
    text === undefined ? [] : [{ text: () => Promise.resolve(text) }];
  return { target: { files, value: '' } } as unknown as Event;
}

/** Let the pending promise chain (prompt → reset → toast) settle. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve));

function textarea(container: Element): HTMLTextAreaElement {
  return container.querySelector(
    '[data-testid=advanced-config-json]',
  ) as HTMLTextAreaElement;
}

function textareaValue(container: Element): string {
  return textarea(container).value;
}

/** Type into the box the way a user does: set the value, then let Angular hear about it. */
function typeInto(container: Element, text: string): void {
  const box = textarea(container);
  box.value = text;
  box.dispatchEvent(new Event('input'));
}

function button(container: Element, testid: string): HTMLButtonElement | null {
  return container.querySelector(`[data-testid=${testid}]`);
}

function textOf(container: Element, testid: string): string {
  return container.querySelector(`[data-testid=${testid}]`)?.textContent ?? '';
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

  let readText: Mock;

  beforeEach(() => {
    palette.set('violet');
    apiKey.set('gif-key');
    desktopOnly.set(false);
    alertPrompt = vi.fn().mockResolvedValue(RESET_CONFIG_CONFIRMATION_WORD);
    toastShow = vi.fn();
    writeText = vi.fn().mockResolvedValue(undefined);
    readText = vi.fn().mockResolvedValue('');
    resetToDefaults = vi.fn(() => of(undefined));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText, readText },
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

  describe('editing and applying', () => {
    /**
     * The real {@link AppConfigService} over {@link ENTRIES}, so the plan under test is the
     * one the app would build — validation, the change summary and the warnings all come
     * from the registry rather than from a stub agreeing with the component.
     */
    async function open() {
      const rendered = await render(AdvancedSettingsComponent, {
        providers: realConfig(),
      });
      return { ...rendered, config: TestBed.inject(AppConfigService) };
    }

    function changeLines(container: Element): readonly string[] {
      return Array.from(
        container.querySelectorAll('[data-testid=advanced-apply-changes] li'),
      ).map((line) => line.textContent ?? '');
    }

    it('stops following the live settings the moment the box is edited', async () => {
      const { container, fixture } = await open();
      const mine = documentJson({ theme: { palette: 'amethyst' } });

      typeInto(container, mine);
      fixture.detectChanges();
      // The document is derived from the owning services' signals, so without the dirty
      // rule a preference moving anywhere would overwrite what is being typed.
      palette.set('emerald');
      fixture.detectChanges();

      expect(textareaValue(container)).toBe(mine);
      expect(textOf(container, 'advanced-edited-note')).toContain(
        'stopped following',
      );
    });

    it('gives the box back to the live document when the edit is discarded', async () => {
      const { container, fixture } = await open();
      typeInto(container, '{ not a document');
      fixture.detectChanges();

      button(container, 'advanced-discard')?.click();
      fixture.detectChanges();

      expect(JSON.parse(textareaValue(container))).toMatchObject({
        settings: { theme: { palette: 'violet' } },
      });
      expect(button(container, 'advanced-discard')).toBeNull();
    });

    it('copies the edit on screen, not the document underneath it', async () => {
      const { container, fixture } = await open();
      const mine = documentJson({ theme: { palette: 'amethyst' } });
      typeInto(container, mine);
      fixture.detectChanges();

      button(container, 'advanced-copy')?.click();
      await flush();

      expect(writeText).toHaveBeenCalledWith(mine);
    });

    it('names the offending path and writes nothing when a value is refused', async () => {
      const { container, fixture, config } = await open();
      const apply = vi.spyOn(config, 'apply');

      typeInto(container, documentJson({ theme: { palette: 42 } }));
      button(container, 'advanced-apply')?.click();
      fixture.detectChanges();

      expect(textOf(container, 'advanced-apply-problems')).toContain(
        'theme.palette',
      );
      expect(
        container.querySelector('[data-testid=advanced-apply-summary]'),
      ).toBeNull();
      expect(apply).not.toHaveBeenCalled();
      expect(palette()).toBe('violet');
    });

    it('reports unreadable JSON as a problem rather than throwing', async () => {
      const { container, fixture } = await open();

      typeInto(container, '{ "version": 1, ');
      button(container, 'advanced-apply')?.click();
      fixture.detectChanges();

      expect(textOf(container, 'advanced-apply-problems')).toContain(
        'not valid JSON',
      );
    });

    it('summarises exactly the settings that would change, and writes nothing yet', async () => {
      const { container, fixture, config } = await open();
      const apply = vi.spyOn(config, 'apply');

      typeInto(
        container,
        documentJson({
          theme: { palette: 'amethyst' },
          gif: { apiKey: 'gif-key' },
        }),
      );
      button(container, 'advanced-apply')?.click();
      fixture.detectChanges();

      // gif.apiKey is in the document but unchanged, so it is not in the summary.
      expect(changeLines(container)).toHaveLength(1);
      expect(changeLines(container)[0]).toContain('theme.palette');
      expect(changeLines(container)[0]).toContain('"violet" → "amethyst"');
      expect(apply).not.toHaveBeenCalled();
      expect(palette()).toBe('violet');
    });

    it('writes only once the summary is confirmed, and then follows the app again', async () => {
      const { container, fixture } = await open();
      typeInto(container, documentJson({ theme: { palette: 'amethyst' } }));
      button(container, 'advanced-apply')?.click();
      fixture.detectChanges();

      button(container, 'advanced-apply-confirm')?.click();
      await flush();
      fixture.detectChanges();

      expect(palette()).toBe('amethyst');
      expect(JSON.parse(textareaValue(container))).toMatchObject({
        settings: { theme: { palette: 'amethyst' } },
      });
      expect(button(container, 'advanced-discard')).toBeNull();
      expect(toastShow).toHaveBeenCalledWith(
        '1 setting applied.',
        expect.objectContaining({ variant: 'success' }),
      );
    });

    it('writes nothing when the summary is cancelled', async () => {
      const { container, fixture, config } = await open();
      const apply = vi.spyOn(config, 'apply');
      typeInto(container, documentJson({ theme: { palette: 'amethyst' } }));
      button(container, 'advanced-apply')?.click();
      fixture.detectChanges();

      button(container, 'advanced-apply-cancel')?.click();
      fixture.detectChanges();

      expect(apply).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid=advanced-apply-summary]'),
      ).toBeNull();
      // The text is kept: cancelling the write is not discarding the edit.
      expect(textareaValue(container)).toContain('amethyst');
    });

    it('drops the summary when the document is edited again', async () => {
      const { container, fixture } = await open();
      typeInto(container, documentJson({ theme: { palette: 'amethyst' } }));
      button(container, 'advanced-apply')?.click();
      fixture.detectChanges();
      expect(changeLines(container)).toHaveLength(1);

      typeInto(container, documentJson({ theme: { palette: 'emerald' } }));
      fixture.detectChanges();

      // A summary that outlived its document could be confirmed against text nobody read.
      expect(
        container.querySelector('[data-testid=advanced-apply-summary]'),
      ).toBeNull();
    });

    it('says the document already matches rather than offering a write', async () => {
      const { container, fixture } = await open();

      button(container, 'advanced-apply')?.click();
      fixture.detectChanges();

      expect(textOf(container, 'advanced-apply-nothing')).toContain(
        'already match',
      );
      expect(
        container.querySelector('[data-testid=advanced-apply-summary]'),
      ).toBeNull();
    });

    it('names a setting that will not do anything here, and applies it anyway', async () => {
      const { container, fixture } = await open();
      typeInto(
        container,
        documentJson({
          desktop: { only: true },
          theme: { palette: 'amethyst' },
        }),
      );
      button(container, 'advanced-apply')?.click();
      fixture.detectChanges();

      const warning = textOf(container, 'advanced-apply-warnings');
      expect(warning).toContain('desktop.only');
      expect(warning).toContain('desktop app is the only place');
      // Decision 4: warned, not filtered — it is still in the summary and still written.
      expect(changeLines(container).join(' ')).toContain('desktop.only');

      button(container, 'advanced-apply-confirm')?.click();
      await flush();
      fixture.detectChanges();

      expect(desktopOnly()).toBe(true);
      // The warning outlives the summary: what did not apply is the part worth re-reading.
      expect(textOf(container, 'advanced-apply-warnings')).toContain(
        'desktop.only',
      );
    });

    it('names a path this build does not have, and still applies the rest', async () => {
      const { container, fixture } = await open();
      typeInto(
        container,
        documentJson({
          theme: { palette: 'amethyst', fromTheFuture: 'x' },
        }),
      );
      button(container, 'advanced-apply')?.click();
      fixture.detectChanges();

      expect(textOf(container, 'advanced-apply-warnings')).toContain(
        'theme.fromTheFuture',
      );
      expect(changeLines(container)).toHaveLength(1);
    });

    it('opens the file picker from the import button', async () => {
      const { container } = await open();
      const input = container.querySelector(
        '[data-testid=advanced-import-file-input]',
      ) as HTMLInputElement;
      const click = vi
        .spyOn(input, 'click')
        .mockImplementation(() => undefined);

      button(container, 'advanced-import-file')?.click();

      expect(click).toHaveBeenCalled();
    });

    it('loads a document from a file into the box and checks it', async () => {
      const { container, fixture } = await open();

      await fixture.componentInstance.importFile(
        fileEvent(documentJson({ theme: { palette: 'amethyst' } })),
      );
      fixture.detectChanges();

      expect(textareaValue(container)).toContain('amethyst');
      expect(changeLines(container)[0]).toContain('theme.palette');
      // Imported, summarised, not written: the same gate a hand edit goes through.
      expect(palette()).toBe('violet');
    });

    it('does nothing when the file picker is dismissed', async () => {
      const { container, fixture } = await open();

      await fixture.componentInstance.importFile(fileEvent());
      fixture.detectChanges();

      expect(button(container, 'advanced-discard')).toBeNull();
    });

    it('loads a document from the clipboard into the box and checks it', async () => {
      readText.mockResolvedValue(
        documentJson({ theme: { palette: 'amethyst' } }),
      );
      const { container, fixture } = await open();

      button(container, 'advanced-import-clipboard')?.click();
      await flush();
      fixture.detectChanges();

      expect(textareaValue(container)).toContain('amethyst');
      expect(changeLines(container)[0]).toContain('theme.palette');
    });

    it('says so rather than silently doing nothing when the clipboard cannot be read', async () => {
      readText.mockRejectedValue(new Error('denied'));
      const { container, fixture } = await open();

      button(container, 'advanced-import-clipboard')?.click();
      await flush();
      fixture.detectChanges();

      expect(toastShow).toHaveBeenCalledWith(
        CLIPBOARD_UNREADABLE_MESSAGE,
        expect.objectContaining({ variant: 'destructive' }),
      );
      expect(button(container, 'advanced-discard')).toBeNull();
    });

    it('keeps the edit but drops the summary when a write fails', async () => {
      const { container, fixture, config } = await open();
      vi.spyOn(config, 'apply').mockReturnValue(
        throwError(() => new Error('nope')),
      );
      typeInto(container, documentJson({ theme: { palette: 'amethyst' } }));
      button(container, 'advanced-apply')?.click();
      fixture.detectChanges();

      button(container, 'advanced-apply-confirm')?.click();
      fixture.detectChanges();

      expect(toastShow).toHaveBeenCalledWith(
        'Could not apply every setting.',
        expect.objectContaining({ variant: 'destructive' }),
      );
      // Some writes may have landed and some not, so the stale summary goes; the text
      // stays, and pressing Apply again re-checks against the app as it now is.
      expect(
        container.querySelector('[data-testid=advanced-apply-summary]'),
      ).toBeNull();
      expect(textareaValue(container)).toContain('amethyst');
      expect(button(container, 'advanced-apply')?.disabled).toBe(false);
    });
  });
});
